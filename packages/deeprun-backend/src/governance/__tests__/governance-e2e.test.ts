import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { buildDecisionCoreHash, issuedDecisionSchema } from "../decision.js";

const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
const requireE2eDatabase = process.env.CI === "true" || process.env.DEEPRUN_GOVERNANCE_E2E_REQUIRE_DB === "true";

if (!baseDatabaseUrl && requireE2eDatabase) {
  throw new Error("TEST_DATABASE_URL is required for governance E2E tests in CI.");
}

interface ProcessHandle {
  child: ChildProcess;
  stdoutPath: string;
  stderrPath: string;
  stop: () => Promise<void>;
}

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface ProcessEnvironment {
  apiUrl: string;
  cliEnv: NodeJS.ProcessEnv;
  databaseUrl: string;
  startApi: (label: string) => ProcessHandle;
  startWorker: (label: string, envOverrides?: NodeJS.ProcessEnv) => ProcessHandle;
  workspaceRoot: string;
}

interface CliConfigFile {
  apiBaseUrl?: string;
  cookies?: Record<string, string>;
  activeOrganizationId?: string;
}

interface AssessmentRecoveryState {
  status: string;
  attempts: number;
  jobs: number;
  evidenceManifests: number;
  selectedEvidenceAttempts: number;
  issuedDecisions: number;
  uniqueDecisionHashes: number;
}

interface JobRunningMarker {
  assessmentId: string;
  attemptId: string;
  jobId: string;
  workerId: string;
  leaseGeneration: number;
  leaseExpiresAt: string;
}

interface JobLeaseState {
  jobId: string;
  assessmentId: string;
  attemptId: string;
  status: string;
  workerId: string | null;
  leaseGeneration: number;
  leaseExpiresAt: string | null;
}

interface AssessmentErrorState extends AssessmentRecoveryState {
  errorCode: string | null;
  errorMessage: string | null;
}

interface DuplicateInvocationState {
  artifacts: number;
  assessments: number;
  attempts: number;
  jobs: number;
  evidenceManifests: number;
  selectedEvidenceAttempts: number;
  issuedDecisions: number;
  uniqueDecisionHashes: number;
  artifactIdempotencyRecords: number;
  artifactIdempotencyStatus: string | null;
  artifactIdempotencyArtifactId: string | null;
  assessmentIdempotencyRecords: number;
  assessmentIdempotencyStatus: string | null;
  assessmentIdempotencyAssessmentId: string | null;
  assessmentInputHashes: number;
  assessmentInputHash: string | null;
}

function repoPath(...parts: string[]): string {
  return path.resolve(process.cwd(), ...parts);
}

function schemaName(): string {
  return `deeprun_e2e_${process.pid}_${randomUUID().replaceAll("-", "")}`.slice(0, 63);
}

function scopedDatabaseUrl(databaseUrl: string, schema: string): string {
  const parsed = new URL(databaseUrl);
  parsed.searchParams.set("options", `-c search_path=${schema}`);
  return parsed.toString();
}

async function createSchema(databaseUrl: string, schema: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await pool.end();
  }
}

async function dropSchema(databaseUrl: string, schema: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await pool.end();
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not allocate port."));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
    server.on("error", reject);
  });
}

async function waitForHttpOk(urlText: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  let lastError = "";

  while (Date.now() - startedAt < timeoutMs) {
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.get(urlText, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.setTimeout(1_000, () => req.destroy(new Error("timeout")));
      req.on("error", (error) => {
        lastError = error.message;
        resolve(false);
      });
    });

    if (ok) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${urlText}.${lastError ? ` Last error: ${lastError}` : ""}`);
}

function startProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  stdoutPath: string,
  stderrPath: string
): ProcessHandle {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env,
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });

  const stdoutStream = child.stdout;
  const stderrStream = child.stderr;

  stdoutStream.on("data", (chunk) => {
    appendFile(stdoutPath, chunk).catch(() => undefined);
  });
  stderrStream.on("data", (chunk) => {
    appendFile(stderrPath, chunk).catch(() => undefined);
  });

  return {
    child,
    stdoutPath,
    stderrPath,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("close", resolve)),
        new Promise((resolve) => setTimeout(resolve, 5_000))
      ]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await Promise.race([
          new Promise((resolve) => child.once("close", resolve)),
          new Promise((resolve) => setTimeout(resolve, 2_000))
        ]);
      }
    }
  };
}

async function forceKillProcess(handle: ProcessHandle): Promise<void> {
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
    return;
  }

  handle.child.kill("SIGKILL");
  await Promise.race([
    new Promise((resolve) => handle.child.once("close", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000))
  ]);
}

async function collectProcessLogs(handles: ProcessHandle[]): Promise<string[]> {
  const processLogContent: string[] = [];

  for (const handle of handles) {
    try {
      processLogContent.push(`${path.basename(handle.stdoutPath)}:\n${await readFile(handle.stdoutPath, "utf8")}`);
    } catch {
      processLogContent.push(`${path.basename(handle.stdoutPath)}: (unavailable)`);
    }
    try {
      processLogContent.push(`${path.basename(handle.stderrPath)}:\n${await readFile(handle.stderrPath, "utf8")}`);
    } catch {
      processLogContent.push(`${path.basename(handle.stderrPath)}: (unavailable)`);
    }
  }

  return processLogContent;
}

async function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Command timed out: ${command} ${args.join(" ")}`));
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        status: typeof code === "number" ? code : 1,
        stdout,
        stderr
      });
    });
  });
}

function parseSingleJsonObject(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  assert.match(trimmed, /^\{[\s\S]*\}$/);
  assert.doesNotMatch(trimmed, /\}\s*\{/);
  return JSON.parse(trimmed) as Record<string, unknown>;
}

async function prepareCanonicalFixture(outputPath: string): Promise<void> {
  const result = await runCommand(
    process.execPath,
    [repoPath("dist", "scripts", "prepare-v1-ready-target.js"), "--output", outputPath, "--clean", "true"],
    process.env,
    60_000
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

async function breakProductionConfig(fixturePath: string): Promise<void> {
  const envPath = path.join(fixturePath, "src", "config", "env.ts");
  const current = await readFile(envPath, "utf8");
  await writeFile(
    envPath,
    current.replace(/production/g, "prod_only_for_e2e_contract_violation"),
    "utf8"
  );
}

async function withProcessEnvironment<T>(fn: (input: ProcessEnvironment) => Promise<T>): Promise<T> {
  if (!baseDatabaseUrl) {
    throw new Error("TEST_DATABASE_URL is not configured.");
  }

  const schema = schemaName();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "deeprun-governance-e2e-"));
  const port = await freePort();
  const apiUrl = `http://127.0.0.1:${port}`;
  const databaseUrl = scopedDatabaseUrl(baseDatabaseUrl, schema);
  const sharedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    TEST_DATABASE_URL: databaseUrl,
    JWT_SECRET: "deeprun-e2e-jwt-secret-at-least-32-chars",
    AUTH_TOKEN_SECRET: "deeprun-e2e-auth-token-secret",
    CORS_ALLOWED_ORIGINS: apiUrl,
    RATE_LIMIT_LOGIN_MAX: "500",
    RATE_LIMIT_GENERATION_MAX: "500",
    DEEPRUN_WORKSPACE_ROOT: tempRoot,
    DEEPRUN_ARTIFACT_INGESTION_LEASE_SECONDS: "30",
    DEEPRUN_ARTIFACT_INGESTION_RENEW_INTERVAL_MS: "5000",
    AGENT_HEAVY_INSTALL_TIMEOUT_MS: process.env.AGENT_HEAVY_INSTALL_TIMEOUT_MS || "300000",
    AGENT_HEAVY_TYPECHECK_TIMEOUT_MS: process.env.AGENT_HEAVY_TYPECHECK_TIMEOUT_MS || "120000",
    AGENT_HEAVY_BUILD_TIMEOUT_MS: process.env.AGENT_HEAVY_BUILD_TIMEOUT_MS || "180000",
    AGENT_HEAVY_TEST_TIMEOUT_MS: process.env.AGENT_HEAVY_TEST_TIMEOUT_MS || "180000",
    AGENT_HEAVY_BOOT_TIMEOUT_MS: process.env.AGENT_HEAVY_BOOT_TIMEOUT_MS || "25000"
  };

  const handles: ProcessHandle[] = [];
  const startApi = (label: string): ProcessHandle => {
    const handle = startProcess(process.execPath, [repoPath("dist", "server.js")], {
      ...sharedEnv,
      PORT: String(port),
      DEEPRUN_PROCESS_ROLE: "api"
    }, path.join(tempRoot, `${label}.stdout.log`), path.join(tempRoot, `${label}.stderr.log`));
    handles.push(handle);
    return handle;
  };
  const startWorker = (label: string, envOverrides: NodeJS.ProcessEnv = {}): ProcessHandle => {
    const handle = startProcess(process.execPath, [repoPath("dist", "server.js")], {
      ...sharedEnv,
      ...envOverrides,
      DEEPRUN_PROCESS_ROLE: "worker"
    }, path.join(tempRoot, `${label}.stdout.log`), path.join(tempRoot, `${label}.stderr.log`));
    handles.push(handle);
    return handle;
  };

  try {
    await createSchema(baseDatabaseUrl, schema);
    return await fn({
      apiUrl,
      cliEnv: {
        ...sharedEnv,
        DEEPRUN_CLI_CONFIG: path.join(tempRoot, ".deeprun", "cli.json")
      },
      databaseUrl,
      startApi,
      startWorker,
      workspaceRoot: tempRoot
    });
  } catch (error) {
    const processLogContent = await collectProcessLogs(handles);
    if (processLogContent.length > 0) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n\n${processLogContent.join("\n\n")}`);
    }
    throw error;
  } finally {
    for (const handle of [...handles].reverse()) {
      await handle.stop();
    }
    await dropSchema(baseDatabaseUrl, schema).catch(() => undefined);
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function withProcesses<T>(fn: (input: {
  apiUrl: string;
  cliEnv: NodeJS.ProcessEnv;
  workspaceRoot: string;
}) => Promise<T>): Promise<T> {
  return withProcessEnvironment(async (environment) => {
    environment.startApi("api");
    await waitForHttpOk(`${environment.apiUrl}/api/ready`, 30_000);
    environment.startWorker("worker");

    return fn({
      apiUrl: environment.apiUrl,
      cliEnv: environment.cliEnv,
      workspaceRoot: environment.workspaceRoot
    });
  });
}

async function runInitializedCli(
  cliEnv: NodeJS.ProcessEnv,
  apiUrl: string,
  emailSuffix: string
): Promise<void> {
  const init = await runCommand(
    process.execPath,
    [
      repoPath("dist", "scripts", "deeprun-cli.js"),
      "init",
      "--api",
      apiUrl,
      "--email",
      `governance-e2e-${emailSuffix}@deeprun.local`,
      "--password",
      "Password123!",
      "--name",
      "Governance E2E",
      "--org",
      `Governance E2E ${emailSuffix}`,
      "--workspace",
      "Governance Workspace"
    ],
    cliEnv,
    30_000
  );
  assert.equal(init.status, 0, init.stderr || init.stdout);
}

async function readCliConfig(cliEnv: NodeJS.ProcessEnv): Promise<CliConfigFile> {
  const configPath = cliEnv.DEEPRUN_CLI_CONFIG;
  if (typeof configPath !== "string") {
    throw new Error("DEEPRUN_CLI_CONFIG is not configured for the E2E CLI.");
  }
  return JSON.parse(await readFile(configPath, "utf8")) as CliConfigFile;
}

function cookieHeader(cookies: Record<string, string> | undefined): string {
  return Object.entries(cookies ?? {})
    .filter(([name, value]) => name.trim() && value.trim())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

async function authenticatedGet<T>(
  cliEnv: NodeJS.ProcessEnv,
  apiUrl: string,
  endpoint: string
): Promise<T> {
  const config = await readCliConfig(cliEnv);
  const headers: Record<string, string> = {};
  const cookies = cookieHeader(config.cookies);
  if (cookies) {
    headers.cookie = cookies;
  }

  const response = await fetch(`${apiUrl}${endpoint}`, { headers });
  const text = await response.text();
  const body = text.trim() ? JSON.parse(text) as { error?: string } : {};
  assert.ok(response.status >= 200 && response.status < 300, body.error || `GET ${endpoint} failed with ${response.status}`);
  return body as T;
}

async function waitForAssessmentEvidenceFinalized(
  databaseUrl: string,
  assessmentId: string,
  timeoutMs: number
): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  const startedAt = Date.now();
  try {
    while (Date.now() - startedAt < timeoutMs) {
      const result = await pool.query<{
        status: string;
        manifests: string;
        selected_attempts: string;
      }>(
        `SELECT a.status,
                (SELECT COUNT(*) FROM evidence_manifests WHERE assessment_id = a.assessment_id) AS manifests,
                (SELECT COUNT(DISTINCT attempt_id)
                   FROM assessment_evidence
                  WHERE assessment_id = a.assessment_id
                    AND selected_for_decision = TRUE) AS selected_attempts
           FROM governance_assessments a
          WHERE a.assessment_id = $1`,
        [assessmentId]
      );
      const row = result.rows[0];
      if (row && (row.status === "DECIDING" || row.status === "COMPLETE")) {
        assert.equal(Number(row.manifests), 1);
        assert.equal(Number(row.selected_attempts), 1);
        return;
      }
      if (row?.status === "ERROR" || row?.status === "CANCELLED") {
        throw new Error(`Assessment ${assessmentId} reached terminal status ${row.status} before restart.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  } finally {
    await pool.end();
  }

  throw new Error(`Timed out waiting for assessment ${assessmentId} evidence finalization.`);
}

async function waitForJsonFile<T>(filePath: string, timeoutMs: number): Promise<T> {
  const startedAt = Date.now();
  let lastError = "";

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return JSON.parse(await readFile(filePath, "utf8")) as T;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw new Error(`Timed out waiting for marker ${filePath}.${lastError ? ` Last error: ${lastError}` : ""}`);
}

async function waitForLogPattern(handle: ProcessHandle, pattern: RegExp, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const chunks: string[] = [];
    try {
      chunks.push(await readFile(handle.stdoutPath, "utf8"));
    } catch {
      // The process may not have emitted output yet.
    }
    try {
      chunks.push(await readFile(handle.stderrPath, "utf8"));
    } catch {
      // The process may not have emitted output yet.
    }
    if (pattern.test(chunks.join("\n"))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${pattern} in ${path.basename(handle.stdoutPath)}.`);
}

async function readAssessmentRecoveryState(
  databaseUrl: string,
  assessmentId: string
): Promise<AssessmentRecoveryState> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await pool.query<{
      status: string;
      attempts: string;
      jobs: string;
      evidence_manifests: string;
      selected_evidence_attempts: string;
      issued_decisions: string;
      unique_decision_hashes: string;
    }>(
      `SELECT a.status,
              (SELECT COUNT(*) FROM governance_assessment_attempts WHERE assessment_id = a.assessment_id) AS attempts,
              (SELECT COUNT(*) FROM governance_jobs WHERE assessment_id = a.assessment_id) AS jobs,
              (SELECT COUNT(*) FROM evidence_manifests WHERE assessment_id = a.assessment_id) AS evidence_manifests,
              (SELECT COUNT(DISTINCT attempt_id)
                 FROM assessment_evidence
                WHERE assessment_id = a.assessment_id
                  AND selected_for_decision = TRUE) AS selected_evidence_attempts,
              (SELECT COUNT(*) FROM issued_decisions WHERE assessment_id = a.assessment_id) AS issued_decisions,
              (SELECT COUNT(DISTINCT decision_hash) FROM issued_decisions WHERE assessment_id = a.assessment_id) AS unique_decision_hashes
         FROM governance_assessments a
        WHERE a.assessment_id = $1`,
      [assessmentId]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Assessment ${assessmentId} was not found.`);
    }
    return {
      status: row.status,
      attempts: Number(row.attempts),
      jobs: Number(row.jobs),
      evidenceManifests: Number(row.evidence_manifests),
      selectedEvidenceAttempts: Number(row.selected_evidence_attempts),
      issuedDecisions: Number(row.issued_decisions),
      uniqueDecisionHashes: Number(row.unique_decision_hashes)
    };
  } finally {
    await pool.end();
  }
}

async function readAssessmentErrorState(
  databaseUrl: string,
  assessmentId: string
): Promise<AssessmentErrorState> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await pool.query<{
      status: string;
      error_code: string | null;
      error_message: string | null;
      attempts: string;
      jobs: string;
      evidence_manifests: string;
      selected_evidence_attempts: string;
      issued_decisions: string;
      unique_decision_hashes: string;
    }>(
      `SELECT a.status,
              a.error_code,
              a.error_message,
              (SELECT COUNT(*) FROM governance_assessment_attempts WHERE assessment_id = a.assessment_id) AS attempts,
              (SELECT COUNT(*) FROM governance_jobs WHERE assessment_id = a.assessment_id) AS jobs,
              (SELECT COUNT(*) FROM evidence_manifests WHERE assessment_id = a.assessment_id) AS evidence_manifests,
              (SELECT COUNT(DISTINCT attempt_id)
                 FROM assessment_evidence
                WHERE assessment_id = a.assessment_id
                  AND selected_for_decision = TRUE) AS selected_evidence_attempts,
              (SELECT COUNT(*) FROM issued_decisions WHERE assessment_id = a.assessment_id) AS issued_decisions,
              (SELECT COUNT(DISTINCT decision_hash) FROM issued_decisions WHERE assessment_id = a.assessment_id) AS unique_decision_hashes
         FROM governance_assessments a
        WHERE a.assessment_id = $1`,
      [assessmentId]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Assessment ${assessmentId} was not found.`);
    }
    return {
      status: row.status,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      attempts: Number(row.attempts),
      jobs: Number(row.jobs),
      evidenceManifests: Number(row.evidence_manifests),
      selectedEvidenceAttempts: Number(row.selected_evidence_attempts),
      issuedDecisions: Number(row.issued_decisions),
      uniqueDecisionHashes: Number(row.unique_decision_hashes)
    };
  } finally {
    await pool.end();
  }
}

async function waitForAssessmentErrorByDatabase(
  databaseUrl: string,
  assessmentId: string,
  timeoutMs: number
): Promise<AssessmentErrorState> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const state = await readAssessmentErrorState(databaseUrl, assessmentId);
    if (state.status === "ERROR") {
      return state;
    }
    if (state.status === "COMPLETE" || state.status === "CANCELLED") {
      throw new Error(`Assessment ${assessmentId} reached unexpected terminal status ${state.status}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for assessment ${assessmentId} ERROR.`);
}

async function waitForAssessmentCompleteByDatabase(
  databaseUrl: string,
  assessmentId: string,
  timeoutMs: number
): Promise<AssessmentRecoveryState> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const state = await readAssessmentRecoveryState(databaseUrl, assessmentId);
    if (state.status === "COMPLETE" && state.issuedDecisions === 1) {
      return state;
    }
    if (state.status === "ERROR" || state.status === "CANCELLED") {
      throw new Error(`Assessment ${assessmentId} reached terminal status ${state.status} during recovery.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for assessment ${assessmentId} decision recovery.`);
}

async function readJobLeaseState(databaseUrl: string, jobId: string): Promise<JobLeaseState> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await pool.query<{
      job_id: string;
      assessment_id: string;
      attempt_id: string;
      status: string;
      worker_id: string | null;
      lease_generation: number;
      lease_expires_at: Date | null;
    }>(
      `SELECT job_id, assessment_id, attempt_id, status, worker_id, lease_generation, lease_expires_at
         FROM governance_jobs
        WHERE job_id = $1`,
      [jobId]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Job ${jobId} was not found.`);
    }
    return {
      jobId: row.job_id,
      assessmentId: row.assessment_id,
      attemptId: row.attempt_id,
      status: row.status,
      workerId: row.worker_id,
      leaseGeneration: row.lease_generation,
      leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null
    };
  } finally {
    await pool.end();
  }
}

async function waitForJobLeaseGenerationGreater(input: {
  databaseUrl: string;
  jobId: string;
  previousGeneration: number;
  previousWorkerId: string;
  timeoutMs: number;
}): Promise<JobLeaseState> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < input.timeoutMs) {
    const state = await readJobLeaseState(input.databaseUrl, input.jobId);
    if (state.leaseGeneration > input.previousGeneration && state.workerId !== input.previousWorkerId) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for job ${input.jobId} lease reclaim.`);
}

async function waitUntilAfter(isoTimestamp: string, bufferMs: number): Promise<void> {
  const target = Date.parse(isoTimestamp) + bufferMs;
  const delayMs = target - Date.now();
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

async function attemptStaleHeartbeat(input: {
  databaseUrl: string;
  jobId: string;
  workerId: string;
  leaseGeneration: number;
}): Promise<number> {
  const pool = new Pool({ connectionString: input.databaseUrl });
  try {
    const result = await pool.query(
      `UPDATE governance_jobs
          SET heartbeat_at = NOW(),
              lease_expires_at = NOW() + make_interval(secs => 30),
              updated_at = NOW()
        WHERE job_id = $1
          AND worker_id = $2
          AND lease_generation = $3
          AND status IN ('CLAIMED','RUNNING')
          AND lease_expires_at > NOW()`,
      [input.jobId, input.workerId, input.leaseGeneration]
    );
    return Number(result.rowCount ?? 0);
  } finally {
    await pool.end();
  }
}

async function readDuplicateInvocationState(input: {
  databaseUrl: string;
  invocationId: string;
  assessmentId: string;
}): Promise<DuplicateInvocationState> {
  const pool = new Pool({ connectionString: input.databaseUrl });
  try {
    const result = await pool.query<{
      artifacts: string;
      assessments: string;
      attempts: string;
      jobs: string;
      evidence_manifests: string;
      selected_evidence_attempts: string;
      issued_decisions: string;
      unique_decision_hashes: string;
      artifact_idempotency_records: string;
      artifact_idempotency_status: string | null;
      artifact_idempotency_artifact_id: string | null;
      assessment_idempotency_records: string;
      assessment_idempotency_status: string | null;
      assessment_idempotency_assessment_id: string | null;
      assessment_input_hashes: string;
      assessment_input_hash: string | null;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM governance_artifacts) AS artifacts,
         (SELECT COUNT(*) FROM governance_assessments) AS assessments,
         (SELECT COUNT(*) FROM governance_assessment_attempts) AS attempts,
         (SELECT COUNT(*) FROM governance_jobs) AS jobs,
         (SELECT COUNT(*) FROM evidence_manifests WHERE assessment_id = $2) AS evidence_manifests,
         (SELECT COUNT(DISTINCT attempt_id)
            FROM assessment_evidence
           WHERE assessment_id = $2
             AND selected_for_decision = TRUE) AS selected_evidence_attempts,
         (SELECT COUNT(*) FROM issued_decisions WHERE assessment_id = $2) AS issued_decisions,
         (SELECT COUNT(DISTINCT decision_hash) FROM issued_decisions WHERE assessment_id = $2) AS unique_decision_hashes,
         (SELECT COUNT(*) FROM artifact_ingestion_idempotency WHERE idempotency_key = $1 || ':artifact') AS artifact_idempotency_records,
         (SELECT status FROM artifact_ingestion_idempotency WHERE idempotency_key = $1 || ':artifact') AS artifact_idempotency_status,
         (SELECT artifact_id FROM artifact_ingestion_idempotency WHERE idempotency_key = $1 || ':artifact') AS artifact_idempotency_artifact_id,
         (SELECT COUNT(*) FROM assessment_idempotency WHERE idempotency_key = $1 || ':assessment') AS assessment_idempotency_records,
         (SELECT status FROM assessment_idempotency WHERE idempotency_key = $1 || ':assessment') AS assessment_idempotency_status,
         (SELECT assessment_id FROM assessment_idempotency WHERE idempotency_key = $1 || ':assessment') AS assessment_idempotency_assessment_id,
         (SELECT COUNT(DISTINCT assessment_input_hash) FROM governance_assessments) AS assessment_input_hashes,
         (SELECT assessment_input_hash FROM governance_assessments WHERE assessment_id = $2) AS assessment_input_hash`,
      [input.invocationId, input.assessmentId]
    );
    const row = result.rows[0];
    return {
      artifacts: Number(row.artifacts),
      assessments: Number(row.assessments),
      attempts: Number(row.attempts),
      jobs: Number(row.jobs),
      evidenceManifests: Number(row.evidence_manifests),
      selectedEvidenceAttempts: Number(row.selected_evidence_attempts),
      issuedDecisions: Number(row.issued_decisions),
      uniqueDecisionHashes: Number(row.unique_decision_hashes),
      artifactIdempotencyRecords: Number(row.artifact_idempotency_records),
      artifactIdempotencyStatus: row.artifact_idempotency_status,
      artifactIdempotencyArtifactId: row.artifact_idempotency_artifact_id,
      assessmentIdempotencyRecords: Number(row.assessment_idempotency_records),
      assessmentIdempotencyStatus: row.assessment_idempotency_status,
      assessmentIdempotencyAssessmentId: row.assessment_idempotency_assessment_id,
      assessmentInputHashes: Number(row.assessment_input_hashes),
      assessmentInputHash: row.assessment_input_hash
    };
  } finally {
    await pool.end();
  }
}

async function readDurabilityCounts(
  databaseUrl: string,
  assessmentId: string
): Promise<{ evidenceManifests: number; selectedEvidenceAttempts: number; issuedDecisions: number }> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await pool.query<{
      evidence_manifests: string;
      selected_evidence_attempts: string;
      issued_decisions: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM evidence_manifests WHERE assessment_id = $1) AS evidence_manifests,
         (SELECT COUNT(DISTINCT attempt_id)
            FROM assessment_evidence
           WHERE assessment_id = $1
             AND selected_for_decision = TRUE) AS selected_evidence_attempts,
         (SELECT COUNT(*) FROM issued_decisions WHERE assessment_id = $1) AS issued_decisions`,
      [assessmentId]
    );
    const row = result.rows[0];
    return {
      evidenceManifests: Number(row.evidence_manifests),
      selectedEvidenceAttempts: Number(row.selected_evidence_attempts),
      issuedDecisions: Number(row.issued_decisions)
    };
  } finally {
    await pool.end();
  }
}

function assertAssessmentIdentityStable(input: {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  artifactId: string;
  subjectDigest: string;
}): void {
  assert.equal(input.after.assessmentId, input.before.assessmentId);
  assert.deepEqual(input.after.subject, {
    artifactId: input.artifactId,
    digest: input.subjectDigest
  });
  assert.equal((input.after.profile as { id?: string })?.id, "node-fastify-prisma");
  assert.equal((input.after.policy as { id?: string })?.id, "deeprun-baseline");
}

if (!baseDatabaseUrl) {
  test("governance separate-process E2E suite", { skip: "set TEST_DATABASE_URL to run governance E2E tests" }, () => {});
} else {
  test("separate API worker and CLI produce PASS for a valid canonical backend", { timeout: 600_000 }, async () => {
    await withProcesses(async ({ apiUrl, cliEnv, workspaceRoot }) => {
      const fixturePath = path.join(workspaceRoot, "fixtures", "pass");
      await prepareCanonicalFixture(fixturePath);
      await runInitializedCli(cliEnv, apiUrl, "pass");

      const assess = await runCommand(
        process.execPath,
        [
          repoPath("dist", "scripts", "deeprun-cli.js"),
          "assess",
          fixturePath,
          "--json",
          "--timeout",
          "480000",
          "--poll-interval",
          "1000"
        ],
        cliEnv,
        540_000
      );

      assert.equal(assess.status, 0, assess.stderr || assess.stdout);
      const result = parseSingleJsonObject(assess.stdout);
      assert.equal(result.resultSchemaVersion, 1);
      assert.equal(result.exitCode, 0);
      assert.equal((result.assessment as { status?: string }).status, "COMPLETE");
      assert.equal(((result.decision as { decisionCore?: { decision?: string } }).decisionCore ?? {}).decision, "PASS");

      const decisionPath = path.join(workspaceRoot, "pass-decision.json");
      await writeFile(decisionPath, `${JSON.stringify(result.decision, null, 2)}\n`, "utf8");
      const verify = await runCommand(
        process.execPath,
        [repoPath("dist", "scripts", "deeprun-cli.js"), "decision", "verify", decisionPath, "--json"],
        cliEnv,
        30_000
      );
      assert.equal(verify.status, 0, verify.stderr || verify.stdout);
      assert.equal((parseSingleJsonObject(verify.stdout) as { ok?: boolean }).ok, true);
    });
  });

  test("API restart preserves assessment evidence and decision durability", { timeout: 600_000 }, async () => {
    await withProcessEnvironment(async (environment) => {
      const fixturePath = path.join(environment.workspaceRoot, "fixtures", "api-restart");
      await prepareCanonicalFixture(fixturePath);

      const apiA = environment.startApi("api-a");
      await waitForHttpOk(`${environment.apiUrl}/api/ready`, 30_000);
      environment.startWorker("worker");
      await runInitializedCli(environment.cliEnv, environment.apiUrl, "api-restart");

      const submit = await runCommand(
        process.execPath,
        [
          repoPath("dist", "scripts", "deeprun-cli.js"),
          "assess",
          fixturePath,
          "--json",
          "--no-wait"
        ],
        environment.cliEnv,
        120_000
      );

      assert.equal(submit.status, 2, submit.stderr || submit.stdout);
      const submitted = parseSingleJsonObject(submit.stdout);
      assert.equal(submitted.resultSchemaVersion, 1);
      assert.equal(submitted.exitCode, 2);
      assert.equal(submitted.status, "QUEUED");
      const artifactId = String(submitted.artifactId);
      const assessmentId = String(submitted.assessmentId);
      const subjectDigest = String(submitted.subjectDigest);
      assert.match(artifactId, /^art_/);
      assert.match(assessmentId, /^asmt_/);
      assert.match(subjectDigest, /^sha256:/);

      await apiA.stop();
      await waitForAssessmentEvidenceFinalized(environment.databaseUrl, assessmentId, 540_000);

      environment.startApi("api-b");
      await waitForHttpOk(`${environment.apiUrl}/api/ready`, 30_000);

      const afterAssessment = await authenticatedGet<Record<string, unknown>>(
        environment.cliEnv,
        environment.apiUrl,
        `/v1/assessments/${encodeURIComponent(assessmentId)}`
      );
      assertAssessmentIdentityStable({
        before: submitted,
        after: afterAssessment,
        artifactId,
        subjectDigest
      });
      assert.equal(afterAssessment.status, "COMPLETE");

      const assessmentDecision = afterAssessment.decision as { result?: string; decisionHash?: string; href?: string } | null;
      assert.equal(assessmentDecision?.result, "PASS");
      assert.match(assessmentDecision?.decisionHash ?? "", /^[a-f0-9]{64}$/);

      const evidence = await authenticatedGet<{
        assessmentId: string;
        attemptId: string;
        evidenceManifestHash: string;
        subjectDigest: string;
        profileDigest: string;
        executionContractHash: string;
        evidence: Array<{ status: string; evidenceCoreHash: string }>;
      }>(
        environment.cliEnv,
        environment.apiUrl,
        `/v1/assessments/${encodeURIComponent(assessmentId)}/evidence`
      );
      assert.equal(evidence.assessmentId, assessmentId);
      assert.equal(evidence.subjectDigest, subjectDigest);
      assert.match(evidence.evidenceManifestHash, /^[a-f0-9]{64}$/);
      assert.ok(evidence.evidence.length > 0);
      assert.ok(evidence.evidence.every((entry) => entry.status === "PASS"));

      const decision = issuedDecisionSchema.parse(await authenticatedGet<unknown>(
        environment.cliEnv,
        environment.apiUrl,
        `/v1/decisions/${encodeURIComponent(assessmentDecision?.decisionHash ?? "")}`
      ));
      assert.equal(decision.decisionHash, assessmentDecision?.decisionHash);
      assert.equal(decision.decisionCore.decision, "PASS");
      assert.equal(decision.decisionCore.subject.digest, subjectDigest);
      assert.equal(decision.decisionCore.evidenceManifestHash, evidence.evidenceManifestHash);
      assert.equal(buildDecisionCoreHash(decision.decisionCore), decision.decisionHash);

      const counts = await readDurabilityCounts(environment.databaseUrl, assessmentId);
      assert.deepEqual(counts, {
        evidenceManifests: 1,
        selectedEvidenceAttempts: 1,
        issuedDecisions: 1
      });
    });
  });

  test("worker startup recovers DECIDING assessment exactly once", { timeout: 600_000 }, async () => {
    await withProcessEnvironment(async (environment) => {
      const fixturePath = path.join(environment.workspaceRoot, "fixtures", "deciding-recovery");
      const markerPath = path.join(environment.workspaceRoot, "evidence-finalized-marker.json");
      await prepareCanonicalFixture(fixturePath);

      environment.startApi("api");
      await waitForHttpOk(`${environment.apiUrl}/api/ready`, 30_000);
      const workerA = environment.startWorker("worker-a", {
        DEEPRUN_TEST_PAUSE_AFTER_EVIDENCE_FINALIZATION: "true",
        DEEPRUN_TEST_EVIDENCE_FINALIZED_MARKER: markerPath
      });
      await runInitializedCli(environment.cliEnv, environment.apiUrl, "deciding-recovery");

      const submit = await runCommand(
        process.execPath,
        [
          repoPath("dist", "scripts", "deeprun-cli.js"),
          "assess",
          fixturePath,
          "--json",
          "--no-wait"
        ],
        environment.cliEnv,
        120_000
      );

      assert.equal(submit.status, 2, submit.stderr || submit.stdout);
      const submitted = parseSingleJsonObject(submit.stdout);
      assert.equal(submitted.resultSchemaVersion, 1);
      assert.equal(submitted.exitCode, 2);
      const artifactId = String(submitted.artifactId);
      const assessmentId = String(submitted.assessmentId);
      const subjectDigest = String(submitted.subjectDigest);
      assert.match(artifactId, /^art_/);
      assert.match(assessmentId, /^asmt_/);
      assert.match(subjectDigest, /^sha256:/);

      const marker = await waitForJsonFile<{
        assessmentId: string;
        attemptId: string;
        manifestHash: string;
      }>(markerPath, 540_000);
      assert.equal(marker.assessmentId, assessmentId);
      assert.match(marker.attemptId, /^att_/);
      assert.match(marker.manifestHash, /^[a-f0-9]{64}$/);

      const decidingState = await readAssessmentRecoveryState(environment.databaseUrl, assessmentId);
      assert.deepEqual(decidingState, {
        status: "DECIDING",
        attempts: 1,
        jobs: 1,
        evidenceManifests: 1,
        selectedEvidenceAttempts: 1,
        issuedDecisions: 0,
        uniqueDecisionHashes: 0
      });

      await workerA.stop();
      assert.deepEqual(await readAssessmentRecoveryState(environment.databaseUrl, assessmentId), decidingState);

      const workerB = environment.startWorker("worker-b");
      await waitForLogPattern(workerB, /governance\.worker_process\.started/, 60_000);
      const recoveredState = await waitForAssessmentCompleteByDatabase(environment.databaseUrl, assessmentId, 60_000);
      assert.deepEqual(recoveredState, {
        status: "COMPLETE",
        attempts: 1,
        jobs: 1,
        evidenceManifests: 1,
        selectedEvidenceAttempts: 1,
        issuedDecisions: 1,
        uniqueDecisionHashes: 1
      });

      const afterAssessment = await authenticatedGet<Record<string, unknown>>(
        environment.cliEnv,
        environment.apiUrl,
        `/v1/assessments/${encodeURIComponent(assessmentId)}`
      );
      assertAssessmentIdentityStable({
        before: submitted,
        after: afterAssessment,
        artifactId,
        subjectDigest
      });
      assert.equal(afterAssessment.status, "COMPLETE");
      const assessmentDecision = afterAssessment.decision as { result?: string; decisionHash?: string } | null;
      assert.equal(assessmentDecision?.result, "PASS");
      assert.match(assessmentDecision?.decisionHash ?? "", /^[a-f0-9]{64}$/);

      const evidence = await authenticatedGet<{
        assessmentId: string;
        evidenceManifestHash: string;
        subjectDigest: string;
        evidence: Array<{ status: string }>;
      }>(
        environment.cliEnv,
        environment.apiUrl,
        `/v1/assessments/${encodeURIComponent(assessmentId)}/evidence`
      );
      assert.equal(evidence.assessmentId, assessmentId);
      assert.equal(evidence.subjectDigest, subjectDigest);
      assert.equal(evidence.evidenceManifestHash, marker.manifestHash);
      assert.ok(evidence.evidence.length > 0);
      assert.ok(evidence.evidence.every((entry) => entry.status === "PASS"));

      const decision = issuedDecisionSchema.parse(await authenticatedGet<unknown>(
        environment.cliEnv,
        environment.apiUrl,
        `/v1/decisions/${encodeURIComponent(assessmentDecision?.decisionHash ?? "")}`
      ));
      assert.equal(decision.decisionHash, assessmentDecision?.decisionHash);
      assert.equal(decision.decisionCore.decision, "PASS");
      assert.equal(decision.decisionCore.subject.digest, subjectDigest);
      assert.equal(decision.decisionCore.evidenceManifestHash, evidence.evidenceManifestHash);
      assert.equal(buildDecisionCoreHash(decision.decisionCore), decision.decisionHash);

      await workerB.stop();
      const workerC = environment.startWorker("worker-c");
      await waitForLogPattern(workerC, /governance\.worker_process\.started/, 60_000);
      assert.deepEqual(await readAssessmentRecoveryState(environment.databaseUrl, assessmentId), recoveredState);
    });
  });

  test("forced worker death is reclaimed after lease expiry with one final decision", { timeout: 600_000 }, async () => {
    await withProcessEnvironment(async (environment) => {
      const fixturePath = path.join(environment.workspaceRoot, "fixtures", "forced-worker-death");
      const markerPath = path.join(environment.workspaceRoot, "job-running-marker.json");
      await prepareCanonicalFixture(fixturePath);

      environment.startApi("api");
      await waitForHttpOk(`${environment.apiUrl}/api/ready`, 30_000);
      const workerA = environment.startWorker("worker-a", {
        DEEPRUN_TEST_PAUSE_AFTER_JOB_RUNNING: "true",
        DEEPRUN_TEST_JOB_RUNNING_MARKER: markerPath
      });
      await runInitializedCli(environment.cliEnv, environment.apiUrl, "forced-worker-death");

      const submit = await runCommand(
        process.execPath,
        [
          repoPath("dist", "scripts", "deeprun-cli.js"),
          "assess",
          fixturePath,
          "--json",
          "--no-wait"
        ],
        environment.cliEnv,
        120_000
      );

      assert.equal(submit.status, 2, submit.stderr || submit.stdout);
      const submitted = parseSingleJsonObject(submit.stdout);
      assert.equal(submitted.resultSchemaVersion, 1);
      assert.equal(submitted.exitCode, 2);
      const artifactId = String(submitted.artifactId);
      const assessmentId = String(submitted.assessmentId);
      const subjectDigest = String(submitted.subjectDigest);
      assert.match(artifactId, /^art_/);
      assert.match(assessmentId, /^asmt_/);
      assert.match(subjectDigest, /^sha256:/);

      const marker = await waitForJsonFile<JobRunningMarker>(markerPath, 120_000);
      assert.equal(marker.assessmentId, assessmentId);
      assert.match(marker.attemptId, /^att_/);
      assert.match(marker.jobId, /^job_/);
      assert.match(marker.workerId, /^worker-/);
      assert.equal(marker.leaseGeneration, 1);
      assert.ok(Date.parse(marker.leaseExpiresAt) > Date.now());

      const ownedState = await readJobLeaseState(environment.databaseUrl, marker.jobId);
      assert.deepEqual(ownedState, {
        jobId: marker.jobId,
        assessmentId,
        attemptId: marker.attemptId,
        status: "RUNNING",
        workerId: marker.workerId,
        leaseGeneration: marker.leaseGeneration,
        leaseExpiresAt: marker.leaseExpiresAt
      });
      assert.deepEqual(await readAssessmentRecoveryState(environment.databaseUrl, assessmentId), {
        status: "RUNNING",
        attempts: 1,
        jobs: 1,
        evidenceManifests: 0,
        selectedEvidenceAttempts: 0,
        issuedDecisions: 0,
        uniqueDecisionHashes: 0
      });

      await forceKillProcess(workerA);
      assert.deepEqual(await readJobLeaseState(environment.databaseUrl, marker.jobId), ownedState);

      const workerB = environment.startWorker("worker-b");
      await waitForLogPattern(workerB, /governance\.worker_process\.started/, 60_000);
      await new Promise((resolve) => setTimeout(resolve, 3_000));

      assert.deepEqual(await readJobLeaseState(environment.databaseUrl, marker.jobId), ownedState);
      assert.deepEqual(await readAssessmentRecoveryState(environment.databaseUrl, assessmentId), {
        status: "RUNNING",
        attempts: 1,
        jobs: 1,
        evidenceManifests: 0,
        selectedEvidenceAttempts: 0,
        issuedDecisions: 0,
        uniqueDecisionHashes: 0
      });

      await waitUntilAfter(marker.leaseExpiresAt, 1_000);
      const reclaimedState = await waitForJobLeaseGenerationGreater({
        databaseUrl: environment.databaseUrl,
        jobId: marker.jobId,
        previousGeneration: marker.leaseGeneration,
        previousWorkerId: marker.workerId,
        timeoutMs: 120_000
      });
      assert.ok(reclaimedState.leaseGeneration > marker.leaseGeneration);
      assert.notEqual(reclaimedState.workerId, marker.workerId);
      assert.equal(await attemptStaleHeartbeat({
        databaseUrl: environment.databaseUrl,
        jobId: marker.jobId,
        workerId: marker.workerId,
        leaseGeneration: marker.leaseGeneration
      }), 0);

      await waitForAssessmentEvidenceFinalized(environment.databaseUrl, assessmentId, 540_000);
      assert.deepEqual(await readAssessmentRecoveryState(environment.databaseUrl, assessmentId), {
        status: "DECIDING",
        attempts: 1,
        jobs: 1,
        evidenceManifests: 1,
        selectedEvidenceAttempts: 1,
        issuedDecisions: 0,
        uniqueDecisionHashes: 0
      });

      const afterAssessment = await authenticatedGet<Record<string, unknown>>(
        environment.cliEnv,
        environment.apiUrl,
        `/v1/assessments/${encodeURIComponent(assessmentId)}`
      );
      assertAssessmentIdentityStable({
        before: submitted,
        after: afterAssessment,
        artifactId,
        subjectDigest
      });
      assert.equal(afterAssessment.status, "COMPLETE");
      const assessmentDecision = afterAssessment.decision as { result?: string; decisionHash?: string } | null;
      assert.equal(assessmentDecision?.result, "PASS");
      assert.match(assessmentDecision?.decisionHash ?? "", /^[a-f0-9]{64}$/);

      const evidence = await authenticatedGet<{
        assessmentId: string;
        evidenceManifestHash: string;
        subjectDigest: string;
        evidence: Array<{ status: string }>;
      }>(
        environment.cliEnv,
        environment.apiUrl,
        `/v1/assessments/${encodeURIComponent(assessmentId)}/evidence`
      );
      assert.equal(evidence.assessmentId, assessmentId);
      assert.equal(evidence.subjectDigest, subjectDigest);
      assert.match(evidence.evidenceManifestHash, /^[a-f0-9]{64}$/);
      assert.ok(evidence.evidence.length > 0);
      assert.ok(evidence.evidence.every((entry) => entry.status === "PASS"));

      const decision = issuedDecisionSchema.parse(await authenticatedGet<unknown>(
        environment.cliEnv,
        environment.apiUrl,
        `/v1/decisions/${encodeURIComponent(assessmentDecision?.decisionHash ?? "")}`
      ));
      assert.equal(decision.decisionHash, assessmentDecision?.decisionHash);
      assert.equal(decision.decisionCore.decision, "PASS");
      assert.equal(decision.decisionCore.subject.digest, subjectDigest);
      assert.equal(decision.decisionCore.evidenceManifestHash, evidence.evidenceManifestHash);
      assert.equal(buildDecisionCoreHash(decision.decisionCore), decision.decisionHash);

      const finalState = await readAssessmentRecoveryState(environment.databaseUrl, assessmentId);
      assert.deepEqual(finalState, {
        status: "COMPLETE",
        attempts: 1,
        jobs: 1,
        evidenceManifests: 1,
        selectedEvidenceAttempts: 1,
        issuedDecisions: 1,
        uniqueDecisionHashes: 1
      });
      const completedJob = await readJobLeaseState(environment.databaseUrl, marker.jobId);
      assert.equal(completedJob.status, "COMPLETE");
      assert.equal(completedJob.workerId, reclaimedState.workerId);
      assert.equal(completedJob.leaseGeneration, reclaimedState.leaseGeneration);
    });
  });

  test("controlled evaluator infrastructure error ends assessment without a decision", { timeout: 600_000 }, async () => {
    await withProcessEnvironment(async (environment) => {
      const fixturePath = path.join(environment.workspaceRoot, "fixtures", "controlled-error");
      await prepareCanonicalFixture(fixturePath);

      environment.startApi("api");
      await waitForHttpOk(`${environment.apiUrl}/api/ready`, 30_000);
      environment.startWorker("worker", {
        DEEPRUN_TEST_FORCE_EVALUATION_ERROR: "true"
      });
      await runInitializedCli(environment.cliEnv, environment.apiUrl, "controlled-error");

      const assess = await runCommand(
        process.execPath,
        [
          repoPath("dist", "scripts", "deeprun-cli.js"),
          "assess",
          fixturePath,
          "--json",
          "--timeout",
          "120000",
          "--poll-interval",
          "1000"
        ],
        environment.cliEnv,
        180_000
      );

      assert.equal(assess.status, 2, assess.stderr || assess.stdout);
      const result = parseSingleJsonObject(assess.stdout);
      assert.equal(result.resultSchemaVersion, 1);
      assert.equal(result.exitCode, 2);
      assert.equal(result.status, "ERROR");
      assert.equal(result.decision, "ERROR");
      assert.equal(result.decisionHash, null);
      assert.equal(result.evidenceManifestHash, null);
      assert.match(String((result.error as { code?: string } | undefined)?.code ?? ""), /^TEST_FORCED_EVALUATION_ERROR$/);

      const assessmentId = String(result.assessmentId);
      assert.match(assessmentId, /^asmt_/);

      const errorState = await waitForAssessmentErrorByDatabase(environment.databaseUrl, assessmentId, 30_000);
      assert.deepEqual(errorState, {
        status: "ERROR",
        errorCode: "TEST_FORCED_EVALUATION_ERROR",
        errorMessage: "Test-forced evaluation infrastructure error.",
        attempts: 1,
        jobs: 1,
        evidenceManifests: 0,
        selectedEvidenceAttempts: 0,
        issuedDecisions: 0,
        uniqueDecisionHashes: 0
      });

      const assessment = await authenticatedGet<Record<string, unknown>>(
        environment.cliEnv,
        environment.apiUrl,
        `/v1/assessments/${encodeURIComponent(assessmentId)}`
      );
      assert.equal(assessment.status, "ERROR");
      assert.equal(assessment.decision, null);
      assert.deepEqual(assessment.error, { code: "TEST_FORCED_EVALUATION_ERROR" });
    });
  });

  test("CLI timeout preserves assessment for later retrieval", { timeout: 600_000 }, async () => {
    await withProcessEnvironment(async (environment) => {
      const fixturePath = path.join(environment.workspaceRoot, "fixtures", "cli-timeout");
      await prepareCanonicalFixture(fixturePath);

      environment.startApi("api");
      await waitForHttpOk(`${environment.apiUrl}/api/ready`, 30_000);
      environment.startWorker("worker", {
        DEEPRUN_TEST_EVALUATION_DELAY_MS: "5000"
      });
      await runInitializedCli(environment.cliEnv, environment.apiUrl, "cli-timeout");

      const assess = await runCommand(
        process.execPath,
        [
          repoPath("dist", "scripts", "deeprun-cli.js"),
          "assess",
          fixturePath,
          "--json",
          "--timeout",
          "1000",
          "--poll-interval",
          "250"
        ],
        environment.cliEnv,
        120_000
      );

      assert.equal(assess.status, 6, assess.stderr || assess.stdout);
      const timeoutResult = parseSingleJsonObject(assess.stdout);
      assert.equal(timeoutResult.resultSchemaVersion, 1);
      assert.equal(timeoutResult.exitCode, 6);
      assert.equal(timeoutResult.status, "TIMEOUT");
      assert.equal(timeoutResult.terminal, false);
      assert.equal(timeoutResult.decision, "UNAVAILABLE");
      assert.equal(timeoutResult.decisionHash, null);
      assert.equal(timeoutResult.evidenceManifestHash, null);
      assert.equal((timeoutResult.error as { code?: string } | undefined)?.code, "CLIENT_TIMEOUT");

      const artifactId = String(timeoutResult.artifactId);
      const assessmentId = String(timeoutResult.assessmentId);
      const subjectDigest = String(timeoutResult.subjectDigest);
      assert.match(artifactId, /^art_/);
      assert.match(assessmentId, /^asmt_/);
      assert.match(subjectDigest, /^sha256:/);

      const timeoutState = await readAssessmentRecoveryState(environment.databaseUrl, assessmentId);
      assert.ok(timeoutState.status === "QUEUED" || timeoutState.status === "RUNNING", timeoutState.status);
      assert.equal(timeoutState.attempts, 1);
      assert.equal(timeoutState.jobs, 1);
      assert.equal(timeoutState.evidenceManifests, 0);
      assert.equal(timeoutState.selectedEvidenceAttempts, 0);
      assert.equal(timeoutState.issuedDecisions, 0);
      assert.equal(timeoutState.uniqueDecisionHashes, 0);

      await waitForAssessmentEvidenceFinalized(environment.databaseUrl, assessmentId, 540_000);

      const afterAssessment = await authenticatedGet<Record<string, unknown>>(
        environment.cliEnv,
        environment.apiUrl,
        `/v1/assessments/${encodeURIComponent(assessmentId)}`
      );
      assertAssessmentIdentityStable({
        before: timeoutResult,
        after: afterAssessment,
        artifactId,
        subjectDigest
      });
      assert.equal(afterAssessment.status, "COMPLETE");
      const assessmentDecision = afterAssessment.decision as { result?: string; decisionHash?: string } | null;
      assert.equal(assessmentDecision?.result, "PASS");
      assert.match(assessmentDecision?.decisionHash ?? "", /^[a-f0-9]{64}$/);

      const evidence = await authenticatedGet<{
        assessmentId: string;
        evidenceManifestHash: string;
        subjectDigest: string;
        evidence: Array<{ status: string }>;
      }>(
        environment.cliEnv,
        environment.apiUrl,
        `/v1/assessments/${encodeURIComponent(assessmentId)}/evidence`
      );
      assert.equal(evidence.assessmentId, assessmentId);
      assert.equal(evidence.subjectDigest, subjectDigest);
      assert.match(evidence.evidenceManifestHash, /^[a-f0-9]{64}$/);
      assert.ok(evidence.evidence.length > 0);
      assert.ok(evidence.evidence.every((entry) => entry.status === "PASS"));

      const decision = issuedDecisionSchema.parse(await authenticatedGet<unknown>(
        environment.cliEnv,
        environment.apiUrl,
        `/v1/decisions/${encodeURIComponent(assessmentDecision?.decisionHash ?? "")}`
      ));
      assert.equal(decision.decisionHash, assessmentDecision?.decisionHash);
      assert.equal(decision.decisionCore.decision, "PASS");
      assert.equal(decision.decisionCore.subject.digest, subjectDigest);
      assert.equal(decision.decisionCore.evidenceManifestHash, evidence.evidenceManifestHash);
      assert.equal(buildDecisionCoreHash(decision.decisionCore), decision.decisionHash);

      assert.deepEqual(await readAssessmentRecoveryState(environment.databaseUrl, assessmentId), {
        status: "COMPLETE",
        attempts: 1,
        jobs: 1,
        evidenceManifests: 1,
        selectedEvidenceAttempts: 1,
        issuedDecisions: 1,
        uniqueDecisionHashes: 1
      });
    });
  });

  test("duplicate CLI invocation converges on one artifact assessment and decision", { timeout: 600_000 }, async () => {
    await withProcessEnvironment(async (environment) => {
      const fixturePath = path.join(environment.workspaceRoot, "fixtures", "duplicate-invocation");
      const invocationId = `e2e-${randomUUID()}`;
      await prepareCanonicalFixture(fixturePath);

      environment.startApi("api");
      await waitForHttpOk(`${environment.apiUrl}/api/ready`, 30_000);
      environment.startWorker("worker", {
        DEEPRUN_TEST_EVALUATION_DELAY_MS: "5000"
      });
      await runInitializedCli(environment.cliEnv, environment.apiUrl, "duplicate-invocation");

      const args = [
        repoPath("dist", "scripts", "deeprun-cli.js"),
        "assess",
        fixturePath,
        "--json",
        "--invocation-id",
        invocationId,
        "--timeout",
        "480000",
        "--poll-interval",
        "500"
      ];
      const [first, duplicate] = await Promise.all([
        runCommand(process.execPath, args, environment.cliEnv, 540_000),
        runCommand(process.execPath, args, environment.cliEnv, 540_000)
      ]);

      assert.equal(first.status, 0, first.stderr || first.stdout);
      assert.equal(duplicate.status, 0, duplicate.stderr || duplicate.stdout);
      const firstResult = parseSingleJsonObject(first.stdout);
      const duplicateResult = parseSingleJsonObject(duplicate.stdout);

      assert.equal(firstResult.resultSchemaVersion, 1);
      assert.equal(duplicateResult.resultSchemaVersion, 1);
      assert.equal(firstResult.exitCode, 0);
      assert.equal(duplicateResult.exitCode, 0);
      assert.equal(firstResult.status, "COMPLETE");
      assert.equal(duplicateResult.status, "COMPLETE");
      assert.equal(firstResult.decision, "PASS");
      assert.equal(duplicateResult.decision, "PASS");
      assert.equal(firstResult.artifactId, duplicateResult.artifactId);
      assert.equal(firstResult.assessmentId, duplicateResult.assessmentId);
      assert.equal(firstResult.subjectDigest, duplicateResult.subjectDigest);
      assert.equal(firstResult.decisionHash, duplicateResult.decisionHash);
      assert.equal(firstResult.evidenceManifestHash, duplicateResult.evidenceManifestHash);

      const artifactId = String(firstResult.artifactId);
      const assessmentId = String(firstResult.assessmentId);
      const subjectDigest = String(firstResult.subjectDigest);
      assert.match(artifactId, /^art_/);
      assert.match(assessmentId, /^asmt_/);
      assert.match(subjectDigest, /^sha256:/);
      assert.match(String(firstResult.decisionHash), /^[a-f0-9]{64}$/);
      assert.match(String(firstResult.evidenceManifestHash), /^[a-f0-9]{64}$/);

      const state = await readDuplicateInvocationState({
        databaseUrl: environment.databaseUrl,
        invocationId,
        assessmentId
      });
      assert.deepEqual(state, {
        artifacts: 1,
        assessments: 1,
        attempts: 1,
        jobs: 1,
        evidenceManifests: 1,
        selectedEvidenceAttempts: 1,
        issuedDecisions: 1,
        uniqueDecisionHashes: 1,
        artifactIdempotencyRecords: 1,
        artifactIdempotencyStatus: "COMPLETE",
        artifactIdempotencyArtifactId: artifactId,
        assessmentIdempotencyRecords: 1,
        assessmentIdempotencyStatus: "COMPLETE",
        assessmentIdempotencyAssessmentId: assessmentId,
        assessmentInputHashes: 1,
        assessmentInputHash: state.assessmentInputHash
      });
      assert.match(state.assessmentInputHash ?? "", /^[a-f0-9]{64}$/);

      const afterAssessment = await authenticatedGet<Record<string, unknown>>(
        environment.cliEnv,
        environment.apiUrl,
        `/v1/assessments/${encodeURIComponent(assessmentId)}`
      );
      assertAssessmentIdentityStable({
        before: firstResult,
        after: afterAssessment,
        artifactId,
        subjectDigest
      });
      assert.equal(afterAssessment.status, "COMPLETE");

      const assessmentDecision = afterAssessment.decision as { result?: string; decisionHash?: string } | null;
      assert.equal(assessmentDecision?.decisionHash, firstResult.decisionHash);
      const decision = issuedDecisionSchema.parse(await authenticatedGet<unknown>(
        environment.cliEnv,
        environment.apiUrl,
        `/v1/decisions/${encodeURIComponent(String(firstResult.decisionHash))}`
      ));
      assert.equal(buildDecisionCoreHash(decision.decisionCore), decision.decisionHash);
    });
  });

  test("separate API worker and CLI produce FAIL for a deterministic contract violation", { timeout: 600_000 }, async () => {
    await withProcesses(async ({ apiUrl, cliEnv, workspaceRoot }) => {
      const fixturePath = path.join(workspaceRoot, "fixtures", "fail");
      await prepareCanonicalFixture(fixturePath);
      await breakProductionConfig(fixturePath);
      await runInitializedCli(cliEnv, apiUrl, "fail");

      const assess = await runCommand(
        process.execPath,
        [
          repoPath("dist", "scripts", "deeprun-cli.js"),
          "assess",
          fixturePath,
          "--json",
          "--timeout",
          "480000",
          "--poll-interval",
          "1000"
        ],
        cliEnv,
        540_000
      );

      assert.equal(assess.status, 1, assess.stderr || assess.stdout);
      const result = parseSingleJsonObject(assess.stdout);
      assert.equal(result.resultSchemaVersion, 1);
      assert.equal(result.exitCode, 1);
      assert.equal((result.assessment as { status?: string }).status, "COMPLETE");
      assert.equal(((result.decision as { decisionCore?: { decision?: string } }).decisionCore ?? {}).decision, "FAIL");
    });
  });
}
