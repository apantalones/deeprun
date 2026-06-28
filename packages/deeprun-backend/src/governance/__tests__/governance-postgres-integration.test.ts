import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import {
  buildEvidenceManifestCore,
  finalizeAssessmentEvidenceManifest
} from "../assessment-evidence.js";
import { buildAssessmentInputHash } from "../assessment-hash.js";
import { GovernanceDecisionIssuerImpl } from "../decision-issuer.js";
import {
  buildEvidenceCoreHash,
  EVIDENCE_SCHEMA_VERSION,
  type EvidenceCore
} from "../evidence.js";
import { GovernanceStore } from "../governance-store.js";
import { buildProfileDigest, type ProfileDescriptor } from "../profiles.js";

const integrationDatabaseUrl =
  process.env.TEST_DATABASE_URL ||
  (process.env.DEEPRUN_ALLOW_DATABASE_URL_INTEGRATION_TESTS === "true" ? process.env.DATABASE_URL : undefined);
const requireIntegrationDatabase =
  process.env.CI === "true" || process.env.DEEPRUN_GOVERNANCE_INTEGRATION_REQUIRE_DB === "true";

if (!integrationDatabaseUrl && requireIntegrationDatabase) {
  throw new Error("TEST_DATABASE_URL is required for governance integration tests in CI.");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

async function withIntegrationStore<T>(fn: (input: {
  pool: Pool;
  store: GovernanceStore;
  schema: string;
}) => Promise<T>): Promise<T> {
  if (!integrationDatabaseUrl) {
    throw new Error("integration database URL is not configured");
  }

  const schema = `gov_int_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({ connectionString: integrationDatabaseUrl });
  await adminPool.query(`CREATE SCHEMA ${schema}`);

  const pool = new Pool({
    connectionString: integrationDatabaseUrl,
    options: `-c search_path=${schema}`
  });
  const store = new GovernanceStore(pool);

  try {
    await store.initialize();
    return await fn({ pool, store, schema });
  } finally {
    await pool.end().catch(() => undefined);
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await adminPool.end().catch(() => undefined);
  }
}

function ids(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function makeAuthorityMaterial() {
  const profile: ProfileDescriptor = {
    profileSchemaVersion: 1,
    id: "deeprun-baseline",
    version: "1.0.0",
    validatorSet: [{ id: "canonical.structure", version: "1.0.0" }]
  };
  const policy = { policySchemaVersion: 1, id: "deeprun-baseline", version: "1.0.0" };
  const profileDigest = buildProfileDigest(profile);
  const policyDigest = sha256Canonical(policy);
  const subjectDigest = `sha256:${"1".repeat(64)}`;
  const executionContractHash = `sha256:${"2".repeat(64)}`;
  const assessmentInputHash = buildAssessmentInputHash({
    subjectDigest,
    profileDigest,
    policyDigest,
    executionContractHash
  });

  return {
    profile,
    policy,
    profileDigest,
    policyDigest,
    subjectDigest,
    executionContractHash,
    assessmentInputHash
  };
}

async function seedAssessment(store: GovernanceStore, input?: {
  assessmentStatus?: "QUEUED" | "RUNNING" | "DECIDING";
  attemptStatus?: "QUEUED" | "RUNNING" | "COMPLETE";
}) {
  const material = makeAuthorityMaterial();
  const assessmentId = ids("asmt");
  const attemptId = ids("att");
  const jobId = ids("job");

  await store.upsertProfileSnapshot({
    profileId: material.profile.id,
    profileVersion: material.profile.version,
    profileDigest: material.profileDigest,
    profileJson: JSON.stringify(material.profile)
  });
  await store.upsertPolicySnapshot({
    policyId: material.policy.id,
    policyVersion: material.policy.version,
    policyDigest: material.policyDigest,
    policyJson: JSON.stringify(material.policy)
  });
  await store.upsertExecutionContractSnapshot({
    executionContractHash: material.executionContractHash,
    contractJson: JSON.stringify({ executionContractHash: material.executionContractHash })
  });

  await store.createAssessment({
    assessmentId,
    organizationId: "org-integration",
    artifactId: ids("art"),
    subjectDigest: material.subjectDigest,
    profileId: material.profile.id,
    profileVersion: material.profile.version,
    profileDigest: material.profileDigest,
    policyId: material.policy.id,
    policyVersion: material.policy.version,
    policyDigest: material.policyDigest,
    executionContractHash: material.executionContractHash,
    assessmentInputHash: material.assessmentInputHash,
    gateId: null,
    requestedBy: "integration-test"
  });
  await store.createAssessmentAttempt({ assessmentId, attemptId, attemptNumber: 1 });
  await store.createGovernanceJob({ assessmentId, attemptId, jobId });

  if (input?.assessmentStatus) {
    await store.updateAssessmentStatus(assessmentId, input.assessmentStatus);
  }
  if (input?.attemptStatus) {
    await store.updateAttemptStatus(attemptId, input.attemptStatus);
  }

  return {
    ...material,
    assessmentId,
    attemptId,
    jobId
  };
}

function makeIdempotentAssessmentGraph(input: {
  idempotencyKey: string;
  requestFingerprint: string;
  subjectDigest?: string;
  gateId?: string | null;
}) {
  const material = makeAuthorityMaterial();
  const subjectDigest = input.subjectDigest ?? material.subjectDigest;
  const assessmentInputHash = buildAssessmentInputHash({
    subjectDigest,
    profileDigest: material.profileDigest,
    policyDigest: material.policyDigest,
    executionContractHash: material.executionContractHash
  });
  const assessmentId = ids("asmt");
  const attemptId = ids("att");
  const jobId = ids("job");

  return {
    idempotency: {
      organizationId: "org-integration",
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint
    },
    assessment: {
      assessmentId,
      organizationId: "org-integration",
      artifactId: ids("art"),
      subjectDigest,
      profileId: material.profile.id,
      profileVersion: material.profile.version,
      profileDigest: material.profileDigest,
      policyId: material.policy.id,
      policyVersion: material.policy.version,
      policyDigest: material.policyDigest,
      executionContractHash: material.executionContractHash,
      assessmentInputHash,
      gateId: input.gateId ?? null,
      requestedBy: "integration-test"
    },
    attempt: {
      attemptId,
      assessmentId,
      attemptNumber: 1
    },
    job: {
      jobId,
      assessmentId,
      attemptId
    },
    profileSnapshot: {
      profileId: material.profile.id,
      profileVersion: material.profile.version,
      profileDigest: material.profileDigest,
      profileJson: JSON.stringify(material.profile)
    },
    policySnapshot: {
      policyId: material.policy.id,
      policyVersion: material.policy.version,
      policyDigest: material.policyDigest,
      policyJson: JSON.stringify(material.policy)
    },
    executionContractSnapshot: {
      executionContractHash: material.executionContractHash,
      contractJson: JSON.stringify({ executionContractHash: material.executionContractHash })
    }
  };
}

function makeArtifactInput(input: {
  artifactId?: string;
  organizationId?: string;
  blobDigest?: string;
  sourceTreeDigest?: string;
}) {
  const blobValue = input.blobDigest ?? "5".repeat(64);
  const sourceTreeValue = input.sourceTreeDigest ?? "6".repeat(64);
  return {
    artifactId: input.artifactId ?? ids("art"),
    organizationId: input.organizationId ?? "org-integration",
    blob: {
      blobDigest: { algorithm: "sha256" as const, value: blobValue },
      storageKey: `sha256:${blobValue}`,
      mediaType: "application/x-deeprun-source-bundle",
      sizeBytes: 123,
      createdAt: new Date().toISOString()
    },
    sourceTree: {
      sourceTreeDigest: { algorithm: "sha256" as const, value: sourceTreeValue },
      manifestSchemaVersion: 1,
      manifest: {
        schemaVersion: 1 as const,
        files: [
          {
            path: "package.json",
            size: 2,
            sha256: "7".repeat(64),
            executable: false
          }
        ]
      },
      manifestHash: sourceTreeValue,
      normalizedBundleDigest: { algorithm: "sha256" as const, value: blobValue },
      fileCount: 1,
      totalBytes: 2,
      createdAt: new Date().toISOString()
    },
    originalFilename: "fixture.tar",
    createdBy: "integration-test"
  };
}

async function attachPassingEvidence(store: GovernanceStore, seed: Awaited<ReturnType<typeof seedAssessment>>) {
  const evidenceCore: EvidenceCore = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    subjectDigest: seed.subjectDigest,
    validatorId: "canonical.structure",
    validatorVersion: "1.0.0",
    validatorImplementationDigest: `sha256:${"3".repeat(64)}`,
    profileDigest: seed.profileDigest,
    executionContractHash: seed.executionContractHash,
    trustClass: "DEEPRUN_EXECUTED",
    status: "PASS",
    reasonCodes: [],
    resultArtifactDigests: []
  };
  const evidenceCoreHash = buildEvidenceCoreHash(evidenceCore);
  const evidenceEnvelopeId = ids("env");
  const now = new Date().toISOString();

  await store.upsertEvidenceCore({
    evidenceCoreHash,
    schemaVersion: evidenceCore.schemaVersion,
    subjectDigest: evidenceCore.subjectDigest,
    profileDigest: evidenceCore.profileDigest,
    validatorId: evidenceCore.validatorId,
    validatorVersion: evidenceCore.validatorVersion,
    validatorImplementationDigest: evidenceCore.validatorImplementationDigest,
    executionContractHash: evidenceCore.executionContractHash,
    trustClass: evidenceCore.trustClass,
    status: evidenceCore.status,
    reasonCodes: evidenceCore.reasonCodes,
    outputArtifactDigests: evidenceCore.resultArtifactDigests,
    coreJson: JSON.stringify(evidenceCore)
  });
  await store.persistEvidenceEnvelope({
    evidenceEnvelopeId,
    evidenceCoreHash,
    assessmentId: seed.assessmentId,
    attemptId: seed.attemptId,
    workerId: "worker-a",
    startedAt: now,
    completedAt: now,
    diagnostics: [],
    logArtifactRefs: [],
    envelopeJson: JSON.stringify({ evidenceEnvelopeId, evidenceCoreHash })
  });
  await store.linkEvidenceToAssessment({
    assessmentId: seed.assessmentId,
    attemptId: seed.attemptId,
    validatorId: evidenceCore.validatorId,
    evidenceCoreHash,
    evidenceEnvelopeId
  });

  const manifestCore = buildEvidenceManifestCore({
    subjectDigest: seed.subjectDigest,
    profileDigest: seed.profileDigest,
    executionContractHash: seed.executionContractHash,
    entries: [
      {
        validatorId: evidenceCore.validatorId,
        validatorVersion: evidenceCore.validatorVersion,
        evidenceCoreHash
      }
    ]
  });
  return finalizeAssessmentEvidenceManifest({
    assessmentId: seed.assessmentId,
    attemptId: seed.attemptId,
    manifestCore
  });
}

if (!integrationDatabaseUrl) {
  test("governance Postgres integration suite", { skip: "set TEST_DATABASE_URL to run real Postgres integration tests" }, () => {});
} else {
  test("Postgres artifact idempotency fences claims and stale completion", async () => {
    await withIntegrationStore(async ({ pool, store }) => {
      const organizationId = "org-integration";
      const idempotencyKey = ids("artifact_idem");
      const expectedBlobDigest = `sha256:${"5".repeat(64)}`;
      const firstClaim = await store.claimArtifactIngestion({
        organizationId,
        idempotencyKey,
        expectedBlobDigest,
        claimOwner: "uploader-a",
        leaseDurationSeconds: 30
      });
      assert.equal(firstClaim.kind, "CLAIMED");
      if (firstClaim.kind !== "CLAIMED") throw new Error("expected first claim");
      assert.equal(firstClaim.claimGeneration, 1);

      const liveClaim = await store.claimArtifactIngestion({
        organizationId,
        idempotencyKey,
        expectedBlobDigest,
        claimOwner: "uploader-b",
        leaseDurationSeconds: 30
      });
      assert.equal(liveClaim.kind, "IN_PROGRESS");

      await pool.query(
        `UPDATE artifact_ingestion_idempotency
         SET claim_expires_at = NOW() - interval '1 second'
         WHERE organization_id = $1 AND idempotency_key = $2`,
        [organizationId, idempotencyKey]
      );

      const reclaimed = await store.claimArtifactIngestion({
        organizationId,
        idempotencyKey,
        expectedBlobDigest,
        claimOwner: "uploader-b",
        leaseDurationSeconds: 30
      });
      assert.equal(reclaimed.kind, "CLAIMED");
      if (reclaimed.kind !== "CLAIMED") throw new Error("expected reclaimed claim");
      assert.equal(reclaimed.claimGeneration, firstClaim.claimGeneration + 1);

      const staleRenew = await store.renewArtifactIngestionClaim({
        organizationId,
        idempotencyKey,
        expectedBlobDigest,
        claimGeneration: firstClaim.claimGeneration,
        claimOwner: firstClaim.claimOwner,
        leaseDurationSeconds: 30
      });
      assert.equal(staleRenew, false);

      await assert.rejects(
        () =>
          store.completeArtifactIngestionClaimAndCreateArtifact({
            ...makeArtifactInput({ organizationId }),
            idempotency: {
              organizationId,
              idempotencyKey,
              expectedBlobDigest,
              claimGeneration: firstClaim.claimGeneration,
              claimOwner: firstClaim.claimOwner
            }
          }),
        /Artifact ingestion claim is no longer current/
      );

      const artifact = await store.completeArtifactIngestionClaimAndCreateArtifact({
        ...makeArtifactInput({ organizationId }),
        idempotency: {
          organizationId,
          idempotencyKey,
          expectedBlobDigest,
          claimGeneration: reclaimed.claimGeneration,
          claimOwner: reclaimed.claimOwner
        }
      });

      const replay = await store.claimArtifactIngestion({
        organizationId,
        idempotencyKey,
        expectedBlobDigest,
        claimOwner: "uploader-c",
        leaseDurationSeconds: 30
      });
      assert.equal(replay.kind, "REPLAYED");
      if (replay.kind !== "REPLAYED") throw new Error("expected replay");
      assert.equal(replay.artifact.artifactId, artifact.artifactId);

      const conflict = await store.claimArtifactIngestion({
        organizationId,
        idempotencyKey,
        expectedBlobDigest: `sha256:${"8".repeat(64)}`,
        claimOwner: "uploader-d",
        leaseDurationSeconds: 30
      });
      assert.equal(conflict.kind, "CONFLICT");

      const counts = await pool.query<{ artifacts: string; claims: string }>(
        `SELECT
           (SELECT COUNT(*) FROM governance_artifacts) AS artifacts,
           (SELECT COUNT(*) FROM artifact_ingestion_idempotency) AS claims`
      );
      assert.equal(Number(counts.rows[0].artifacts), 1);
      assert.equal(Number(counts.rows[0].claims), 1);
    });
  });

  test("Postgres artifact claim renewal prevents reclaim and expired renewal fences completion", async () => {
    await withIntegrationStore(async ({ pool, store }) => {
      const organizationId = "org-integration";
      const idempotencyKey = ids("artifact_idem");
      const expectedBlobDigest = `sha256:${"5".repeat(64)}`;
      const claim = await store.claimArtifactIngestion({
        organizationId,
        idempotencyKey,
        expectedBlobDigest,
        claimOwner: "uploader-a",
        leaseDurationSeconds: 30
      });
      assert.equal(claim.kind, "CLAIMED");
      if (claim.kind !== "CLAIMED") throw new Error("expected claim");

      await pool.query(
        `UPDATE artifact_ingestion_idempotency
         SET claim_expires_at = NOW() + interval '1 second'
         WHERE organization_id = $1 AND idempotency_key = $2`,
        [organizationId, idempotencyKey]
      );

      const renewed = await store.renewArtifactIngestionClaim({
        organizationId,
        idempotencyKey,
        expectedBlobDigest,
        claimGeneration: claim.claimGeneration,
        claimOwner: claim.claimOwner,
        leaseDurationSeconds: 30
      });
      assert.equal(renewed, true);

      const blockedReclaim = await store.claimArtifactIngestion({
        organizationId,
        idempotencyKey,
        expectedBlobDigest,
        claimOwner: "uploader-b",
        leaseDurationSeconds: 30
      });
      assert.equal(blockedReclaim.kind, "IN_PROGRESS");

      await pool.query(
        `UPDATE artifact_ingestion_idempotency
         SET claim_expires_at = NOW() - interval '1 second'
         WHERE organization_id = $1 AND idempotency_key = $2`,
        [organizationId, idempotencyKey]
      );

      const expiredRenew = await store.renewArtifactIngestionClaim({
        organizationId,
        idempotencyKey,
        expectedBlobDigest,
        claimGeneration: claim.claimGeneration,
        claimOwner: claim.claimOwner,
        leaseDurationSeconds: 30
      });
      assert.equal(expiredRenew, false);

      await assert.rejects(
        () =>
          store.completeArtifactIngestionClaimAndCreateArtifact({
            ...makeArtifactInput({ organizationId }),
            idempotency: {
              organizationId,
              idempotencyKey,
              expectedBlobDigest,
              claimGeneration: claim.claimGeneration,
              claimOwner: claim.claimOwner
            }
          }),
        /Artifact ingestion claim is no longer current/
      );

      const reclaimed = await store.claimArtifactIngestion({
        organizationId,
        idempotencyKey,
        expectedBlobDigest,
        claimOwner: "uploader-b",
        leaseDurationSeconds: 30
      });
      assert.equal(reclaimed.kind, "CLAIMED");
      if (reclaimed.kind !== "CLAIMED") throw new Error("expected reclaimed claim");
      assert.equal(reclaimed.claimGeneration, claim.claimGeneration + 1);

      const artifact = await store.completeArtifactIngestionClaimAndCreateArtifact({
        ...makeArtifactInput({ organizationId }),
        idempotency: {
          organizationId,
          idempotencyKey,
          expectedBlobDigest,
          claimGeneration: reclaimed.claimGeneration,
          claimOwner: reclaimed.claimOwner
        }
      });
      assert.ok(artifact.artifactId);
    });
  });

  test("Postgres artifact idempotency is scoped by organization", async () => {
    await withIntegrationStore(async ({ store }) => {
      const idempotencyKey = ids("artifact_idem");
      const expectedBlobDigest = `sha256:${"5".repeat(64)}`;
      const claimA = await store.claimArtifactIngestion({
        organizationId: "org-a",
        idempotencyKey,
        expectedBlobDigest,
        claimOwner: "uploader-a",
        leaseDurationSeconds: 30
      });
      const claimB = await store.claimArtifactIngestion({
        organizationId: "org-b",
        idempotencyKey,
        expectedBlobDigest,
        claimOwner: "uploader-b",
        leaseDurationSeconds: 30
      });
      assert.equal(claimA.kind, "CLAIMED");
      assert.equal(claimB.kind, "CLAIMED");
      if (claimA.kind !== "CLAIMED" || claimB.kind !== "CLAIMED") throw new Error("expected claims");

      const artifactA = await store.completeArtifactIngestionClaimAndCreateArtifact({
        ...makeArtifactInput({ organizationId: "org-a" }),
        idempotency: {
          organizationId: "org-a",
          idempotencyKey,
          expectedBlobDigest,
          claimGeneration: claimA.claimGeneration,
          claimOwner: claimA.claimOwner
        }
      });
      const artifactB = await store.completeArtifactIngestionClaimAndCreateArtifact({
        ...makeArtifactInput({ organizationId: "org-b" }),
        idempotency: {
          organizationId: "org-b",
          idempotencyKey,
          expectedBlobDigest,
          claimGeneration: claimB.claimGeneration,
          claimOwner: claimB.claimOwner
        }
      });
      assert.notEqual(artifactA.artifactId, artifactB.artifactId);
    });
  });

  test("Postgres assessment idempotency creates one graph for concurrent matching requests", async () => {
    await withIntegrationStore(async ({ pool, store }) => {
      const idempotencyKey = ids("idem");
      const requestFingerprint = `sha256:${"a".repeat(64)}`;
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          store.createAssessmentGraphIdempotently(
            makeIdempotentAssessmentGraph({
              idempotencyKey,
              requestFingerprint
            })
          )
        )
      );

      assert.equal(results.some((result) => result.kind === "IN_PROGRESS"), false);
      const assessmentIds = new Set<string>();
      for (const result of results) {
        if (result.kind !== "IN_PROGRESS") {
          assessmentIds.add(result.assessment.assessmentId);
        }
      }
      assert.equal(assessmentIds.size, 1);
      assert.equal(results.filter((result) => result.kind === "CREATED").length, 1);
      assert.equal(results.filter((result) => result.kind === "REPLAYED").length, 19);

      const counts = await pool.query<{
        assessments: string;
        attempts: string;
        jobs: string;
        idempotency: string;
      }>(
        `SELECT
           (SELECT COUNT(*) FROM governance_assessments) AS assessments,
           (SELECT COUNT(*) FROM governance_assessment_attempts) AS attempts,
           (SELECT COUNT(*) FROM governance_jobs) AS jobs,
           (SELECT COUNT(*) FROM assessment_idempotency) AS idempotency`
      );
      assert.equal(Number(counts.rows[0].assessments), 1);
      assert.equal(Number(counts.rows[0].attempts), 1);
      assert.equal(Number(counts.rows[0].jobs), 1);
      assert.equal(Number(counts.rows[0].idempotency), 1);
    });
  });

  test("Postgres assessment idempotency rejects conflicting fingerprints and permits different keys", async () => {
    await withIntegrationStore(async ({ pool, store }) => {
      const idempotencyKey = ids("idem");
      const first = await store.createAssessmentGraphIdempotently(
        makeIdempotentAssessmentGraph({
          idempotencyKey,
          requestFingerprint: `sha256:${"b".repeat(64)}`
        })
      );
      assert.equal(first.kind, "CREATED");

      await assert.rejects(
        () =>
          store.createAssessmentGraphIdempotently(
            makeIdempotentAssessmentGraph({
              idempotencyKey,
              requestFingerprint: `sha256:${"c".repeat(64)}`,
              subjectDigest: `sha256:${"4".repeat(64)}`
            })
          ),
        /Idempotency key was already used/
      );

      const secondKey = await store.createAssessmentGraphIdempotently(
        makeIdempotentAssessmentGraph({
          idempotencyKey: ids("idem"),
          requestFingerprint: `sha256:${"b".repeat(64)}`
        })
      );
      assert.equal(secondKey.kind, "CREATED");
      assert.notEqual(secondKey.assessment.assessmentId, first.assessment.assessmentId);

      const counts = await pool.query<{ assessments: string; jobs: string; idempotency: string }>(
        `SELECT
           (SELECT COUNT(*) FROM governance_assessments) AS assessments,
           (SELECT COUNT(*) FROM governance_jobs) AS jobs,
           (SELECT COUNT(*) FROM assessment_idempotency) AS idempotency`
      );
      assert.equal(Number(counts.rows[0].assessments), 2);
      assert.equal(Number(counts.rows[0].jobs), 2);
      assert.equal(Number(counts.rows[0].idempotency), 2);
    });
  });

  test("Postgres queue claiming uses row locks and lease generations", async () => {
    await withIntegrationStore(async ({ pool, store }) => {
      const competingStore = new GovernanceStore(pool);
      const seed = await seedAssessment(store);

      const [claimA, claimB] = await Promise.all([
        store.claimNextGovernanceJob({ workerId: "worker-a", leaseDurationSeconds: 30 }),
        competingStore.claimNextGovernanceJob({ workerId: "worker-b", leaseDurationSeconds: 30 })
      ]);
      const claims = [claimA, claimB].filter(Boolean);
      assert.equal(claims.length, 1);
      const firstClaim = claims[0]!;
      assert.equal(firstClaim.leaseGeneration, 1);

      const liveReclaim = await competingStore.claimNextGovernanceJob({
        workerId: "worker-b",
        leaseDurationSeconds: 30
      });
      assert.equal(liveReclaim, null);

      await pool.query(
        `UPDATE governance_jobs
         SET status = 'RUNNING', lease_expires_at = NOW() - interval '1 second'
         WHERE job_id = $1`,
        [seed.jobId]
      );
      const expiredHeartbeat = await store.heartbeatJob(
        seed.jobId,
        firstClaim.workerId!,
        firstClaim.leaseGeneration,
        30
      );
      assert.equal(expiredHeartbeat, false);
      const expiredComplete = await store.completeJob(seed.jobId, firstClaim.workerId!, firstClaim.leaseGeneration);
      assert.equal(expiredComplete, null);

      const reclaimed = await competingStore.claimNextGovernanceJob({
        workerId: "worker-b",
        leaseDurationSeconds: 30
      });
      assert.ok(reclaimed);
      assert.equal(reclaimed.workerId, "worker-b");
      assert.equal(reclaimed.leaseGeneration, firstClaim.leaseGeneration + 1);

      const staleHeartbeat = await store.heartbeatJob(seed.jobId, firstClaim.workerId!, firstClaim.leaseGeneration, 30);
      assert.equal(staleHeartbeat, false);
      const beforeHeartbeat = await store.getGovernanceJob(seed.jobId);
      await competingStore.heartbeatJob(seed.jobId, "worker-b", reclaimed.leaseGeneration, 60);
      const afterHeartbeat = await store.getGovernanceJob(seed.jobId);
      assert.ok(beforeHeartbeat?.leaseExpiresAt);
      assert.ok(afterHeartbeat?.leaseExpiresAt);
      assert.ok(Date.parse(afterHeartbeat.leaseExpiresAt) > Date.parse(beforeHeartbeat.leaseExpiresAt));

      const staleComplete = await store.completeJob(seed.jobId, firstClaim.workerId!, firstClaim.leaseGeneration);
      assert.equal(staleComplete, null);
      const completed = await competingStore.completeJob(seed.jobId, "worker-b", reclaimed.leaseGeneration);
      assert.equal(completed?.status, "COMPLETE");
    });
  });

  test("Postgres evidence finalization permits exactly one atomic completion", async () => {
    await withIntegrationStore(async ({ pool, store }) => {
      const seed = await seedAssessment(store, { assessmentStatus: "RUNNING", attemptStatus: "RUNNING" });
      const claimed = await store.claimNextGovernanceJob({ workerId: "worker-a", leaseDurationSeconds: 30 });
      assert.ok(claimed);
      await store.transitionJobToRunning(seed.jobId, "worker-a", claimed.leaseGeneration);
      const manifest = await attachPassingEvidence(store, seed);

      const completionInput = {
        assessmentId: seed.assessmentId,
        attemptId: seed.attemptId,
        jobId: seed.jobId,
        workerId: "worker-a",
        leaseGeneration: claimed.leaseGeneration,
        manifest: {
          evidenceManifestId: ids("manifest"),
          assessmentId: seed.assessmentId,
          attemptId: seed.attemptId,
          evidenceManifestHash: manifest.evidenceManifestHash,
          manifestJson: JSON.stringify(manifest)
        },
        evidenceValidatorIds: ["canonical.structure"]
      };

      const results = await Promise.allSettled([
        store.completeAttemptAtomically(completionInput),
        store.completeAttemptAtomically({
          ...completionInput,
          manifest: { ...completionInput.manifest, evidenceManifestId: ids("manifest") }
        })
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(results.filter((result) => result.status === "rejected").length, 1);

      const manifestCount = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM evidence_manifests WHERE assessment_id = $1`,
        [seed.assessmentId]
      );
      assert.equal(Number(manifestCount.rows[0].count), 1);
      const selectedCount = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM assessment_evidence WHERE assessment_id = $1 AND selected_for_decision = TRUE`,
        [seed.assessmentId]
      );
      assert.equal(Number(selectedCount.rows[0].count), 1);
      assert.equal((await store.getAssessment(seed.assessmentId))?.status, "DECIDING");
    });
  });

  test("Postgres decision issuance is concurrency-safe and idempotent", async () => {
    await withIntegrationStore(async ({ pool, store }) => {
      const seed = await seedAssessment(store, { assessmentStatus: "RUNNING", attemptStatus: "RUNNING" });
      const claimed = await store.claimNextGovernanceJob({ workerId: "worker-a", leaseDurationSeconds: 30 });
      assert.ok(claimed);
      await store.transitionJobToRunning(seed.jobId, "worker-a", claimed.leaseGeneration);
      const manifest = await attachPassingEvidence(store, seed);
      await store.completeAttemptAtomically({
        assessmentId: seed.assessmentId,
        attemptId: seed.attemptId,
        jobId: seed.jobId,
        workerId: "worker-a",
        leaseGeneration: claimed.leaseGeneration,
        manifest: {
          evidenceManifestId: ids("manifest"),
          assessmentId: seed.assessmentId,
          attemptId: seed.attemptId,
          evidenceManifestHash: manifest.evidenceManifestHash,
          manifestJson: JSON.stringify(manifest)
        },
        evidenceValidatorIds: ["canonical.structure"]
      });

      const issuerA = new GovernanceDecisionIssuerImpl({
        governanceStore: store,
        now: () => "2026-06-27T01:00:00.000Z"
      });
      const issuerB = new GovernanceDecisionIssuerImpl({
        governanceStore: new GovernanceStore(pool),
        now: () => "2026-06-27T01:00:01.000Z"
      });
      const [decisionA, decisionB] = await Promise.all([
        issuerA.issue({ assessmentId: seed.assessmentId, issuer: "issuer-a" }),
        issuerB.issue({ assessmentId: seed.assessmentId, issuer: "issuer-b" })
      ]);

      assert.equal(decisionA.decisionHash, decisionB.decisionHash);
      assert.equal(decisionA.decisionCore.decision, "PASS");
      assert.equal((await store.getAssessment(seed.assessmentId))?.status, "COMPLETE");
      const issuedCount = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM issued_decisions WHERE assessment_id = $1`,
        [seed.assessmentId]
      );
      assert.equal(Number(issuedCount.rows[0].count), 1);
    });
  });
}
