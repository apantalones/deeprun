import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Pool } from "pg";

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

async function withProcesses<T>(fn: (input: {
  apiUrl: string;
  cliEnv: NodeJS.ProcessEnv;
  workspaceRoot: string;
}) => Promise<T>): Promise<T> {
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

  let api: ProcessHandle | null = null;
  let worker: ProcessHandle | null = null;

  try {
    await createSchema(baseDatabaseUrl, schema);
    api = startProcess(process.execPath, [repoPath("dist", "server.js")], {
      ...sharedEnv,
      PORT: String(port),
      DEEPRUN_PROCESS_ROLE: "api"
    }, path.join(tempRoot, "api.stdout.log"), path.join(tempRoot, "api.stderr.log"));
    await waitForHttpOk(`${apiUrl}/api/ready`, 30_000);
    worker = startProcess(process.execPath, [repoPath("dist", "server.js")], {
      ...sharedEnv,
      DEEPRUN_PROCESS_ROLE: "worker"
    }, path.join(tempRoot, "worker.stdout.log"), path.join(tempRoot, "worker.stderr.log"));

    return await fn({
      apiUrl,
      cliEnv: {
        ...sharedEnv,
        DEEPRUN_CLI_CONFIG: path.join(tempRoot, ".deeprun", "cli.json")
      },
      workspaceRoot: tempRoot
    });
  } catch (error) {
    const processLogContent: string[] = [];
    if (api?.stdoutPath) {
      try {
        processLogContent.push(`api stdout:\n${await readFile(api.stdoutPath, "utf8")}`);
      } catch {
        processLogContent.push("api stdout: (unavailable)");
      }
      try {
        processLogContent.push(`api stderr:\n${await readFile(api.stderrPath, "utf8")}`);
      } catch {
        processLogContent.push("api stderr: (unavailable)");
      }
    }
    if (worker?.stdoutPath) {
      try {
        processLogContent.push(`worker stdout:\n${await readFile(worker.stdoutPath, "utf8")}`);
      } catch {
        processLogContent.push("worker stdout: (unavailable)");
      }
      try {
        processLogContent.push(`worker stderr:\n${await readFile(worker.stderrPath, "utf8")}`);
      } catch {
        processLogContent.push("worker stderr: (unavailable)");
      }
    }
    if (processLogContent.length > 0) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n\n${processLogContent.join("\n\n")}`);
    }
    throw error;
  } finally {
    await worker?.stop();
    await api?.stop();
    await dropSchema(baseDatabaseUrl, schema).catch(() => undefined);
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
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
