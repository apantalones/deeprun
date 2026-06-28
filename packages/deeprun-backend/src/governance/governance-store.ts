import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Digest } from "./artifacts.js";
import type {
  ArtifactRecord,
  ArtifactRepository,
  ArtifactIdempotencyClaimResult,
  ClaimArtifactIngestionInput,
  CompleteArtifactIngestionClaimInput,
  CreateArtifactRecordInput,
  SourceTreeRecord
} from "./artifact-repository.js";
import type {
  AssessmentRecord,
  AssessmentAttemptRecord,
  GovernanceJobRecord,
  EvidenceCoreRecord,
  EvidenceEnvelopeRecord,
  AssessmentEvidenceLink,
  EvidenceManifestRecord,
  IssuedDecisionRecord,
  CreateAssessmentInput,
  CreateAssessmentAttemptInput,
  CreateGovernanceJobInput,
  IdempotentCreateAssessmentGraphInput,
  IdempotentCreateAssessmentGraphResult,
  PersistEvidenceCoreInput,
  PersistEvidenceEnvelopeInput,
  CreateEvidenceManifestInput,
  PersistIssuedDecisionInput,
  PersistedProfileSnapshot,
  PersistedPolicySnapshot,
  PersistedExecutionContractSnapshot,
  AssessmentStatus,
  AssessmentAttemptStatus,
  GovernanceJobStatus
} from "./assessment-types.js";

// ---------------------------------------------------------------------------
// DDL – embedded to keep migrations self-contained in the store
// ---------------------------------------------------------------------------

export const governanceSchemaSql = `
CREATE TABLE IF NOT EXISTS governance_profile_snapshots (
  profile_id          TEXT        NOT NULL,
  profile_version     TEXT        NOT NULL,
  profile_digest      TEXT        NOT NULL,
  profile_json        TEXT        NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (profile_id, profile_version)
);

CREATE TABLE IF NOT EXISTS governance_policy_snapshots (
  policy_id           TEXT        NOT NULL,
  policy_version      TEXT        NOT NULL,
  policy_digest       TEXT        NOT NULL,
  policy_json         TEXT        NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (policy_id, policy_version)
);

CREATE TABLE IF NOT EXISTS governance_execution_contract_snapshots (
  execution_contract_hash TEXT    NOT NULL PRIMARY KEY,
  contract_json           TEXT    NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS governance_artifact_blobs (
  blob_digest    TEXT        NOT NULL PRIMARY KEY,
  storage_key    TEXT        NOT NULL,
  media_type     TEXT        NOT NULL,
  size_bytes     BIGINT      NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS governance_source_trees (
  source_tree_digest       TEXT        NOT NULL PRIMARY KEY,
  manifest_schema_version  INTEGER     NOT NULL,
  manifest_json            TEXT        NOT NULL,
  manifest_hash            TEXT        NOT NULL,
  normalized_bundle_digest TEXT        NOT NULL,
  file_count               INTEGER     NOT NULL,
  total_bytes              BIGINT      NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS governance_artifacts (
  artifact_id        TEXT        NOT NULL PRIMARY KEY,
  organization_id    TEXT        NOT NULL,
  blob_digest        TEXT        NOT NULL REFERENCES governance_artifact_blobs(blob_digest),
  source_tree_digest TEXT        NOT NULL REFERENCES governance_source_trees(source_tree_digest),
  original_filename  TEXT,
  created_by         TEXT        NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gov_artifacts_org
  ON governance_artifacts (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS artifact_ingestion_idempotency (
  organization_id       TEXT        NOT NULL,
  idempotency_key       TEXT        NOT NULL,
  expected_blob_digest  TEXT        NOT NULL,
  status                TEXT        NOT NULL
                          CHECK (status IN ('IN_PROGRESS','COMPLETE')),
  claim_generation      INTEGER     NOT NULL DEFAULT 0,
  claim_owner           TEXT,
  claim_expires_at      TIMESTAMPTZ,
  artifact_id           TEXT        REFERENCES governance_artifacts(artifact_id) ON DELETE SET NULL,
  error_code            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at          TIMESTAMPTZ,
  PRIMARY KEY (organization_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_artifact_ingestion_idempotency_artifact
  ON artifact_ingestion_idempotency (artifact_id)
  WHERE artifact_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS governance_assessments (
  assessment_id           TEXT        NOT NULL PRIMARY KEY,
  organization_id         TEXT        NOT NULL,
  artifact_id             TEXT        NOT NULL,
  subject_digest          TEXT        NOT NULL,
  profile_id              TEXT        NOT NULL,
  profile_version         TEXT        NOT NULL,
  profile_digest          TEXT        NOT NULL,
  policy_id               TEXT        NOT NULL,
  policy_version          TEXT        NOT NULL,
  policy_digest           TEXT        NOT NULL,
  execution_contract_hash TEXT        NOT NULL,
  assessment_input_hash   TEXT        NOT NULL,
  decision_hash           TEXT,
  error_code              TEXT,
  error_message           TEXT,
  gate_id                 TEXT,
  requested_by            TEXT        NOT NULL,
  status                  TEXT        NOT NULL DEFAULT 'QUEUED'
                            CHECK (status IN ('QUEUED','RUNNING','DECIDING','COMPLETE','ERROR','CANCELLED')),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE governance_assessments
  ADD COLUMN IF NOT EXISTS decision_hash TEXT;

ALTER TABLE governance_assessments
  ADD COLUMN IF NOT EXISTS error_code TEXT;

ALTER TABLE governance_assessments
  ADD COLUMN IF NOT EXISTS error_message TEXT;

CREATE INDEX IF NOT EXISTS idx_gov_assessments_org_status
  ON governance_assessments (organization_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS assessment_idempotency (
  organization_id      TEXT        NOT NULL,
  idempotency_key      TEXT        NOT NULL,
  request_fingerprint  TEXT        NOT NULL,
  status               TEXT        NOT NULL
                         CHECK (status IN ('IN_PROGRESS','COMPLETE')),
  assessment_id         TEXT        REFERENCES governance_assessments(assessment_id) ON DELETE CASCADE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at         TIMESTAMPTZ,
  PRIMARY KEY (organization_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_assessment_idempotency_assessment
  ON assessment_idempotency (assessment_id)
  WHERE assessment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS governance_assessment_attempts (
  attempt_id      TEXT        NOT NULL PRIMARY KEY,
  assessment_id   TEXT        NOT NULL REFERENCES governance_assessments(assessment_id) ON DELETE CASCADE,
  attempt_number  INTEGER     NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'QUEUED'
                    CHECK (status IN ('QUEUED','RUNNING','COMPLETE','ERROR','CANCELLED')),
  worker_id       TEXT,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  error_code      TEXT,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (assessment_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_gov_attempts_assessment_id
  ON governance_assessment_attempts (assessment_id, attempt_number);

CREATE TABLE IF NOT EXISTS governance_jobs (
  job_id            TEXT        NOT NULL PRIMARY KEY,
  assessment_id     TEXT        NOT NULL REFERENCES governance_assessments(assessment_id) ON DELETE CASCADE,
  attempt_id        TEXT        NOT NULL REFERENCES governance_assessment_attempts(attempt_id) ON DELETE CASCADE,
  job_type          TEXT        NOT NULL DEFAULT 'GOVERNANCE_ASSESSMENT'
                      CHECK (job_type IN ('GOVERNANCE_ASSESSMENT')),
  status            TEXT        NOT NULL DEFAULT 'AVAILABLE'
                      CHECK (status IN ('AVAILABLE','CLAIMED','RUNNING','COMPLETE','FAILED','CANCELLED')),
  worker_id         TEXT,
  claimed_at        TIMESTAMPTZ,
  lease_expires_at  TIMESTAMPTZ,
  heartbeat_at      TIMESTAMPTZ,
  lease_generation  INTEGER     NOT NULL DEFAULT 0,
  claim_count       INTEGER     NOT NULL DEFAULT 0,
  available_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error_code   TEXT,
  last_error_message TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gov_jobs_available
  ON governance_jobs (status, available_at ASC)
  WHERE status = 'AVAILABLE';

CREATE INDEX IF NOT EXISTS idx_gov_jobs_lease
  ON governance_jobs (lease_expires_at)
  WHERE status IN ('CLAIMED', 'RUNNING');

ALTER TABLE governance_jobs
  ADD COLUMN IF NOT EXISTS lease_generation INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS evidence_cores (
  evidence_core_hash              TEXT NOT NULL PRIMARY KEY,
  schema_version                  INTEGER NOT NULL,
  subject_digest                  TEXT NOT NULL,
  profile_digest                  TEXT NOT NULL,
  validator_id                    TEXT NOT NULL,
  validator_version               TEXT NOT NULL,
  validator_implementation_digest TEXT NOT NULL,
  execution_contract_hash         TEXT NOT NULL,
  trust_class                     TEXT NOT NULL,
  status                          TEXT NOT NULL
                                    CHECK (status IN ('PASS','FAIL','ERROR','SKIPPED')),
  reason_codes_json               TEXT NOT NULL DEFAULT '[]',
  output_artifact_digests_json    TEXT NOT NULL DEFAULT '[]',
  core_json                       TEXT NOT NULL,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_evidence_cores_subject
  ON evidence_cores (subject_digest, validator_id);

CREATE TABLE IF NOT EXISTS evidence_envelopes (
  evidence_envelope_id  TEXT        NOT NULL PRIMARY KEY,
  evidence_core_hash    TEXT        NOT NULL REFERENCES evidence_cores(evidence_core_hash),
  assessment_id         TEXT        NOT NULL REFERENCES governance_assessments(assessment_id) ON DELETE CASCADE,
  attempt_id            TEXT        NOT NULL REFERENCES governance_assessment_attempts(attempt_id) ON DELETE CASCADE,
  worker_id             TEXT,
  started_at            TIMESTAMPTZ NOT NULL,
  completed_at          TIMESTAMPTZ NOT NULL,
  diagnostics_json      TEXT        NOT NULL DEFAULT '[]',
  log_artifact_refs_json TEXT       NOT NULL DEFAULT '[]',
  envelope_json         TEXT        NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_evidence_envelopes_attempt
  ON evidence_envelopes (attempt_id, evidence_core_hash);

CREATE TABLE IF NOT EXISTS assessment_evidence (
  assessment_id         TEXT    NOT NULL REFERENCES governance_assessments(assessment_id) ON DELETE CASCADE,
  attempt_id            TEXT    NOT NULL REFERENCES governance_assessment_attempts(attempt_id) ON DELETE CASCADE,
  validator_id          TEXT    NOT NULL,
  evidence_core_hash    TEXT    NOT NULL REFERENCES evidence_cores(evidence_core_hash),
  evidence_envelope_id  TEXT    NOT NULL REFERENCES evidence_envelopes(evidence_envelope_id),
  selected_for_decision BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (assessment_id, attempt_id, validator_id)
);

CREATE INDEX IF NOT EXISTS idx_assessment_evidence_selected
  ON assessment_evidence (assessment_id, selected_for_decision)
  WHERE selected_for_decision = TRUE;

CREATE TABLE IF NOT EXISTS evidence_manifests (
  evidence_manifest_id    TEXT        NOT NULL PRIMARY KEY,
  assessment_id           TEXT        NOT NULL REFERENCES governance_assessments(assessment_id) ON DELETE CASCADE,
  attempt_id              TEXT        NOT NULL REFERENCES governance_assessment_attempts(attempt_id) ON DELETE CASCADE,
  evidence_manifest_hash  TEXT        NOT NULL,
  manifest_json           TEXT        NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (assessment_id, attempt_id)
);

CREATE INDEX IF NOT EXISTS idx_evidence_manifests_assessment
  ON evidence_manifests (assessment_id);

CREATE TABLE IF NOT EXISTS issued_decisions (
  assessment_id        TEXT        NOT NULL PRIMARY KEY REFERENCES governance_assessments(assessment_id) ON DELETE CASCADE,
  organization_id      TEXT        NOT NULL,
  decision_hash        TEXT        NOT NULL UNIQUE,
  decision_core_json   TEXT        NOT NULL,
  issued_decision_json TEXT        NOT NULL,
  issued_at            TIMESTAMPTZ NOT NULL,
  issuer               TEXT        NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_issued_decisions_org_hash
  ON issued_decisions (organization_id, decision_hash);
`;

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

interface DbAssessmentRow {
  assessment_id: string;
  organization_id: string;
  artifact_id: string;
  subject_digest: string;
  profile_id: string;
  profile_version: string;
  profile_digest: string;
  policy_id: string;
  policy_version: string;
  policy_digest: string;
  execution_contract_hash: string;
  assessment_input_hash: string;
  decision_hash: string | null;
  error_code: string | null;
  error_message: string | null;
  gate_id: string | null;
  requested_by: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

function mapAssessment(row: DbAssessmentRow): AssessmentRecord {
  return {
    assessmentId: row.assessment_id,
    organizationId: row.organization_id,
    artifactId: row.artifact_id,
    subjectDigest: row.subject_digest,
    profileId: row.profile_id,
    profileVersion: row.profile_version,
    profileDigest: row.profile_digest,
    policyId: row.policy_id,
    policyVersion: row.policy_version,
    policyDigest: row.policy_digest,
    executionContractHash: row.execution_contract_hash,
    assessmentInputHash: row.assessment_input_hash,
    decisionHash: row.decision_hash,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    gateId: row.gate_id,
    requestedBy: row.requested_by,
    status: row.status as AssessmentStatus,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

interface DbAttemptRow {
  attempt_id: string;
  assessment_id: string;
  attempt_number: number;
  status: string;
  worker_id: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapAttempt(row: DbAttemptRow): AssessmentAttemptRecord {
  return {
    attemptId: row.attempt_id,
    assessmentId: row.assessment_id,
    attemptNumber: row.attempt_number,
    status: row.status as AssessmentAttemptStatus,
    workerId: row.worker_id,
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

interface DbJobRow {
  job_id: string;
  assessment_id: string;
  attempt_id: string;
  job_type: string;
  status: string;
  worker_id: string | null;
  claimed_at: Date | null;
  lease_expires_at: Date | null;
  heartbeat_at: Date | null;
  lease_generation: number;
  claim_count: number;
  available_at: Date;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapJob(row: DbJobRow): GovernanceJobRecord {
  return {
    jobId: row.job_id,
    assessmentId: row.assessment_id,
    attemptId: row.attempt_id,
    jobType: row.job_type as "GOVERNANCE_ASSESSMENT",
    status: row.status as GovernanceJobStatus,
    workerId: row.worker_id,
    claimedAt: row.claimed_at?.toISOString() ?? null,
    leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
    heartbeatAt: row.heartbeat_at?.toISOString() ?? null,
    leaseGeneration: row.lease_generation,
    claimCount: row.claim_count,
    availableAt: row.available_at.toISOString(),
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

// ---------------------------------------------------------------------------
// Artifact row mappers
// ---------------------------------------------------------------------------

function formatDigest(digest: Digest): string {
  return `${digest.algorithm}:${digest.value}`;
}

function parseDigest(serialized: string): Digest {
  const [algorithm, value] = serialized.split(":", 2);
  if (algorithm !== "sha256" || !value) {
    throw new Error(`Unsupported digest format: ${serialized}`);
  }
  return { algorithm, value };
}

interface DbArtifactRow {
  artifact_id: string;
  organization_id: string;
  blob_digest: string;
  source_tree_digest: string;
  original_filename: string | null;
  created_by: string;
  created_at: Date;
}

function mapArtifact(row: DbArtifactRow): ArtifactRecord {
  return {
    artifactId: row.artifact_id,
    organizationId: row.organization_id,
    blobDigest: parseDigest(row.blob_digest),
    sourceTreeDigest: parseDigest(row.source_tree_digest),
    originalFilename: row.original_filename ?? undefined,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString()
  };
}

interface DbSourceTreeRow {
  source_tree_digest: string;
  manifest_schema_version: number;
  manifest_json: string;
  manifest_hash: string;
  normalized_bundle_digest: string;
  file_count: number;
  total_bytes: string | number;
  created_at: Date;
}

function mapSourceTree(row: DbSourceTreeRow): SourceTreeRecord {
  return {
    sourceTreeDigest: parseDigest(row.source_tree_digest),
    manifestSchemaVersion: row.manifest_schema_version,
    manifest: JSON.parse(row.manifest_json),
    manifestHash: row.manifest_hash,
    normalizedBundleDigest: parseDigest(row.normalized_bundle_digest),
    fileCount: row.file_count,
    totalBytes: Number(row.total_bytes),
    createdAt: row.created_at.toISOString()
  };
}

// ---------------------------------------------------------------------------
// GovernanceStore
// ---------------------------------------------------------------------------

export class AssessmentIdempotencyConflictError extends Error {
  readonly code = "ASSESSMENT_IDEMPOTENCY_CONFLICT";

  constructor() {
    super("Idempotency key was already used for a different assessment request.");
    this.name = "AssessmentIdempotencyConflictError";
  }
}

export class ArtifactIdempotencyClaimLostError extends Error {
  readonly code = "ARTIFACT_IDEMPOTENCY_CLAIM_LOST";

  constructor() {
    super("Artifact ingestion claim is no longer current.");
    this.name = "ArtifactIdempotencyClaimLostError";
  }
}

export class GovernanceStore implements ArtifactRepository {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(governanceSchemaSql);
  }

  // -----------------------------------------------------------------------
  // Artifacts
  // -----------------------------------------------------------------------

  async claimArtifactIngestion(
    input: ClaimArtifactIngestionInput
  ): Promise<ArtifactIdempotencyClaimResult> {
    const leaseSecs = Math.max(30, input.leaseDurationSeconds ?? 300);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const inserted = await client.query<{
        claim_generation: number;
        claim_owner: string;
        claim_expires_at: Date;
      }>(
        `INSERT INTO artifact_ingestion_idempotency (
           organization_id, idempotency_key, expected_blob_digest,
           status, claim_generation, claim_owner, claim_expires_at
         ) VALUES ($1, $2, $3, 'IN_PROGRESS', 1, $4, NOW() + make_interval(secs => $5))
         ON CONFLICT (organization_id, idempotency_key) DO NOTHING
         RETURNING claim_generation, claim_owner, claim_expires_at`,
        [
          input.organizationId,
          input.idempotencyKey,
          input.expectedBlobDigest,
          input.claimOwner,
          leaseSecs
        ]
      );

      if (inserted.rows[0]) {
        await client.query("COMMIT");
        return {
          kind: "CLAIMED",
          claimGeneration: inserted.rows[0].claim_generation,
          claimOwner: inserted.rows[0].claim_owner,
          expiresAt: inserted.rows[0].claim_expires_at.toISOString()
        };
      }

      const existing = await client.query<{
        expected_blob_digest: string;
        status: string;
        claim_generation: number;
        claim_owner: string | null;
        claim_expires_at: Date | null;
        artifact_id: string | null;
      }>(
        `SELECT expected_blob_digest, status, claim_generation, claim_owner, claim_expires_at, artifact_id
         FROM artifact_ingestion_idempotency
         WHERE organization_id = $1 AND idempotency_key = $2
         FOR UPDATE`,
        [input.organizationId, input.idempotencyKey]
      );
      const row = existing.rows[0];
      if (!row || row.expected_blob_digest !== input.expectedBlobDigest) {
        await client.query("COMMIT");
        return { kind: "CONFLICT" };
      }

      if (row.status === "COMPLETE" && row.artifact_id) {
        const artifact = await client.query<DbArtifactRow>(
          `SELECT * FROM governance_artifacts WHERE artifact_id = $1 AND organization_id = $2`,
          [row.artifact_id, input.organizationId]
        );
        if (!artifact.rows[0]) {
          throw new Error(`Artifact idempotency record references missing artifact ${row.artifact_id}.`);
        }
        await client.query("COMMIT");
        return {
          kind: "REPLAYED",
          artifact: mapArtifact(artifact.rows[0])
        };
      }

      if (row.claim_expires_at && row.claim_expires_at.getTime() > Date.now()) {
        await client.query("COMMIT");
        return {
          kind: "IN_PROGRESS",
          retryAfterSeconds: Math.max(1, Math.ceil((row.claim_expires_at.getTime() - Date.now()) / 1000))
        };
      }

      const reclaimed = await client.query<{
        claim_generation: number;
        claim_owner: string;
        claim_expires_at: Date;
      }>(
        `UPDATE artifact_ingestion_idempotency
         SET status = 'IN_PROGRESS',
             claim_generation = claim_generation + 1,
             claim_owner = $3,
             claim_expires_at = NOW() + make_interval(secs => $4),
             error_code = NULL,
             updated_at = NOW()
         WHERE organization_id = $1
           AND idempotency_key = $2
           AND expected_blob_digest = $5
           AND status = 'IN_PROGRESS'
           AND (claim_expires_at IS NULL OR claim_expires_at <= NOW())
         RETURNING claim_generation, claim_owner, claim_expires_at`,
        [
          input.organizationId,
          input.idempotencyKey,
          input.claimOwner,
          leaseSecs,
          input.expectedBlobDigest
        ]
      );
      if (!reclaimed.rows[0]) {
        await client.query("COMMIT");
        return {
          kind: "IN_PROGRESS",
          retryAfterSeconds: 2
        };
      }

      await client.query("COMMIT");
      return {
        kind: "CLAIMED",
        claimGeneration: reclaimed.rows[0].claim_generation,
        claimOwner: reclaimed.rows[0].claim_owner,
        expiresAt: reclaimed.rows[0].claim_expires_at.toISOString()
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async renewArtifactIngestionClaim(input: {
    organizationId: string;
    idempotencyKey: string;
    expectedBlobDigest: string;
    claimGeneration: number;
    claimOwner: string;
    leaseDurationSeconds?: number;
  }): Promise<boolean> {
    const leaseSecs = Math.max(30, input.leaseDurationSeconds ?? 300);
    const result = await this.pool.query(
      `UPDATE artifact_ingestion_idempotency
       SET claim_expires_at = NOW() + make_interval(secs => $6),
           updated_at = NOW()
       WHERE organization_id = $1
         AND idempotency_key = $2
         AND expected_blob_digest = $3
         AND claim_generation = $4
         AND claim_owner = $5
         AND status = 'IN_PROGRESS'
         AND claim_expires_at > NOW()`,
      [
        input.organizationId,
        input.idempotencyKey,
        input.expectedBlobDigest,
        input.claimGeneration,
        input.claimOwner,
        leaseSecs
      ]
    );
    return Number(result.rowCount ?? 0) === 1;
  }

  async completeArtifactIngestionClaimAndCreateArtifact(
    input: CompleteArtifactIngestionClaimInput
  ): Promise<ArtifactRecord> {
    const artifactBlobDigest = formatDigest(input.blob.blobDigest);
    const sourceTreeDigest = formatDigest(input.sourceTree.sourceTreeDigest);
    const normalizedBundleDigest = formatDigest(input.sourceTree.normalizedBundleDigest);
    const client = await this.pool.connect();

    if (input.idempotency.expectedBlobDigest !== artifactBlobDigest) {
      throw new ArtifactIdempotencyClaimLostError();
    }

    try {
      await client.query("BEGIN");

      const claim = await client.query<{ status: string }>(
        `SELECT status
         FROM artifact_ingestion_idempotency
         WHERE organization_id = $1
           AND idempotency_key = $2
           AND expected_blob_digest = $3
           AND claim_generation = $4
           AND claim_owner = $5
           AND status = 'IN_PROGRESS'
           AND claim_expires_at > NOW()
         FOR UPDATE`,
        [
          input.idempotency.organizationId,
          input.idempotency.idempotencyKey,
          input.idempotency.expectedBlobDigest,
          input.idempotency.claimGeneration,
          input.idempotency.claimOwner
        ]
      );
      if (!claim.rows[0]) {
        throw new ArtifactIdempotencyClaimLostError();
      }

      await client.query(
        `INSERT INTO governance_artifact_blobs (
           blob_digest, storage_key, media_type, size_bytes
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT (blob_digest) DO UPDATE
           SET storage_key = EXCLUDED.storage_key,
               media_type  = EXCLUDED.media_type,
               size_bytes  = EXCLUDED.size_bytes`,
        [
          artifactBlobDigest,
          input.blob.storageKey,
          input.blob.mediaType,
          input.blob.sizeBytes
        ]
      );

      await client.query(
        `INSERT INTO governance_source_trees (
           source_tree_digest, manifest_schema_version, manifest_json, manifest_hash,
           normalized_bundle_digest, file_count, total_bytes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (source_tree_digest) DO UPDATE
           SET manifest_schema_version  = EXCLUDED.manifest_schema_version,
               manifest_json            = EXCLUDED.manifest_json,
               manifest_hash            = EXCLUDED.manifest_hash,
               normalized_bundle_digest = EXCLUDED.normalized_bundle_digest,
               file_count               = EXCLUDED.file_count,
               total_bytes              = EXCLUDED.total_bytes`,
        [
          sourceTreeDigest,
          input.sourceTree.manifestSchemaVersion,
          JSON.stringify(input.sourceTree.manifest),
          input.sourceTree.manifestHash,
          normalizedBundleDigest,
          input.sourceTree.fileCount,
          input.sourceTree.totalBytes
        ]
      );

      const artifactResult = await client.query<DbArtifactRow>(
        `INSERT INTO governance_artifacts (
           artifact_id, organization_id, blob_digest, source_tree_digest,
           original_filename, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (artifact_id) DO UPDATE
           SET organization_id    = EXCLUDED.organization_id,
               blob_digest        = EXCLUDED.blob_digest,
               source_tree_digest = EXCLUDED.source_tree_digest,
               original_filename  = EXCLUDED.original_filename,
               created_by         = EXCLUDED.created_by
         RETURNING *`,
        [
          input.artifactId,
          input.organizationId,
          artifactBlobDigest,
          sourceTreeDigest,
          input.originalFilename ?? null,
          input.createdBy
        ]
      );

      const completedClaim = await client.query(
        `UPDATE artifact_ingestion_idempotency
         SET status = 'COMPLETE',
             artifact_id = $6,
             completed_at = NOW(),
             updated_at = NOW()
         WHERE organization_id = $1
           AND idempotency_key = $2
           AND expected_blob_digest = $3
           AND claim_generation = $4
           AND claim_owner = $5
           AND status = 'IN_PROGRESS'
           AND claim_expires_at > NOW()`,
        [
          input.idempotency.organizationId,
          input.idempotency.idempotencyKey,
          input.idempotency.expectedBlobDigest,
          input.idempotency.claimGeneration,
          input.idempotency.claimOwner,
          input.artifactId
        ]
      );
      if (Number(completedClaim.rowCount ?? 0) !== 1) {
        throw new ArtifactIdempotencyClaimLostError();
      }

      await client.query("COMMIT");
      return mapArtifact(artifactResult.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createArtifact(input: CreateArtifactRecordInput): Promise<ArtifactRecord> {
    const artifactBlobDigest = formatDigest(input.blob.blobDigest);
    const sourceTreeDigest = formatDigest(input.sourceTree.sourceTreeDigest);
    const normalizedBundleDigest = formatDigest(input.sourceTree.normalizedBundleDigest);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO governance_artifact_blobs (
           blob_digest, storage_key, media_type, size_bytes
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT (blob_digest) DO UPDATE
           SET storage_key = EXCLUDED.storage_key,
               media_type  = EXCLUDED.media_type,
               size_bytes  = EXCLUDED.size_bytes`,
        [
          artifactBlobDigest,
          input.blob.storageKey,
          input.blob.mediaType,
          input.blob.sizeBytes
        ]
      );

      await client.query(
        `INSERT INTO governance_source_trees (
           source_tree_digest, manifest_schema_version, manifest_json, manifest_hash,
           normalized_bundle_digest, file_count, total_bytes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (source_tree_digest) DO UPDATE
           SET manifest_schema_version  = EXCLUDED.manifest_schema_version,
               manifest_json            = EXCLUDED.manifest_json,
               manifest_hash            = EXCLUDED.manifest_hash,
               normalized_bundle_digest = EXCLUDED.normalized_bundle_digest,
               file_count               = EXCLUDED.file_count,
               total_bytes              = EXCLUDED.total_bytes`,
        [
          sourceTreeDigest,
          input.sourceTree.manifestSchemaVersion,
          JSON.stringify(input.sourceTree.manifest),
          input.sourceTree.manifestHash,
          normalizedBundleDigest,
          input.sourceTree.fileCount,
          input.sourceTree.totalBytes
        ]
      );

      const artifactResult = await client.query<DbArtifactRow>(
        `INSERT INTO governance_artifacts (
           artifact_id, organization_id, blob_digest, source_tree_digest,
           original_filename, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (artifact_id) DO UPDATE
           SET organization_id    = EXCLUDED.organization_id,
               blob_digest        = EXCLUDED.blob_digest,
               source_tree_digest = EXCLUDED.source_tree_digest,
               original_filename  = EXCLUDED.original_filename,
               created_by         = EXCLUDED.created_by
         RETURNING *`,
        [
          input.artifactId,
          input.organizationId,
          artifactBlobDigest,
          sourceTreeDigest,
          input.originalFilename ?? null,
          input.createdBy
        ]
      );

      await client.query("COMMIT");
      return mapArtifact(artifactResult.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getArtifactForOrganization(
    artifactId: string,
    organizationId: string
  ): Promise<ArtifactRecord | null> {
    const result = await this.pool.query<DbArtifactRow>(
      `SELECT *
       FROM governance_artifacts
       WHERE artifact_id = $1 AND organization_id = $2`,
      [artifactId, organizationId]
    );
    return result.rows[0] ? mapArtifact(result.rows[0]) : null;
  }

  async getSourceTree(sourceTreeDigest: Digest): Promise<SourceTreeRecord | null> {
    const result = await this.pool.query<DbSourceTreeRow>(
      `SELECT *
       FROM governance_source_trees
       WHERE source_tree_digest = $1`,
      [formatDigest(sourceTreeDigest)]
    );
    return result.rows[0] ? mapSourceTree(result.rows[0]) : null;
  }

  // -----------------------------------------------------------------------
  // Snapshots
  // -----------------------------------------------------------------------

  async upsertProfileSnapshot(input: PersistedProfileSnapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO governance_profile_snapshots
         (profile_id, profile_version, profile_digest, profile_json)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (profile_id, profile_version) DO UPDATE
         SET profile_digest = EXCLUDED.profile_digest,
             profile_json   = EXCLUDED.profile_json`,
      [input.profileId, input.profileVersion, input.profileDigest, input.profileJson]
    );
  }

  async getProfileSnapshot(
    profileId: string,
    profileVersion: string
  ): Promise<PersistedProfileSnapshot | null> {
    const result = await this.pool.query<{
      profile_id: string;
      profile_version: string;
      profile_digest: string;
      profile_json: string;
    }>(
      `SELECT profile_id, profile_version, profile_digest, profile_json
       FROM governance_profile_snapshots
       WHERE profile_id = $1 AND profile_version = $2`,
      [profileId, profileVersion]
    );

    const row = result.rows[0];
    if (!row) return null;
    return {
      profileId: row.profile_id,
      profileVersion: row.profile_version,
      profileDigest: row.profile_digest,
      profileJson: row.profile_json
    };
  }

  async upsertPolicySnapshot(input: PersistedPolicySnapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO governance_policy_snapshots
         (policy_id, policy_version, policy_digest, policy_json)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (policy_id, policy_version) DO UPDATE
         SET policy_digest = EXCLUDED.policy_digest,
             policy_json   = EXCLUDED.policy_json`,
      [input.policyId, input.policyVersion, input.policyDigest, input.policyJson]
    );
  }

  async getPolicySnapshot(
    policyId: string,
    policyVersion: string
  ): Promise<PersistedPolicySnapshot | null> {
    const result = await this.pool.query<{
      policy_id: string;
      policy_version: string;
      policy_digest: string;
      policy_json: string;
    }>(
      `SELECT policy_id, policy_version, policy_digest, policy_json
       FROM governance_policy_snapshots
       WHERE policy_id = $1 AND policy_version = $2`,
      [policyId, policyVersion]
    );

    const row = result.rows[0];
    if (!row) return null;
    return {
      policyId: row.policy_id,
      policyVersion: row.policy_version,
      policyDigest: row.policy_digest,
      policyJson: row.policy_json
    };
  }

  async upsertExecutionContractSnapshot(
    input: PersistedExecutionContractSnapshot
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO governance_execution_contract_snapshots
         (execution_contract_hash, contract_json)
       VALUES ($1, $2)
       ON CONFLICT (execution_contract_hash) DO NOTHING`,
      [input.executionContractHash, input.contractJson]
    );
  }

  async getExecutionContractSnapshot(
    executionContractHash: string
  ): Promise<PersistedExecutionContractSnapshot | null> {
    const result = await this.pool.query<{
      execution_contract_hash: string;
      contract_json: string;
    }>(
      `SELECT execution_contract_hash, contract_json
       FROM governance_execution_contract_snapshots
       WHERE execution_contract_hash = $1`,
      [executionContractHash]
    );

    const row = result.rows[0];
    if (!row) return null;
    return {
      executionContractHash: row.execution_contract_hash,
      contractJson: row.contract_json
    };
  }

  // -----------------------------------------------------------------------
  // Assessments
  // -----------------------------------------------------------------------

  async createAssessment(input: CreateAssessmentInput): Promise<AssessmentRecord> {
    const result = await this.pool.query<DbAssessmentRow>(
      `INSERT INTO governance_assessments (
         assessment_id, organization_id, artifact_id, subject_digest,
         profile_id, profile_version, profile_digest,
         policy_id, policy_version, policy_digest,
         execution_contract_hash, assessment_input_hash,
         gate_id, requested_by, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'QUEUED')
       RETURNING *`,
      [
        input.assessmentId,
        input.organizationId,
        input.artifactId,
        input.subjectDigest,
        input.profileId,
        input.profileVersion,
        input.profileDigest,
        input.policyId,
        input.policyVersion,
        input.policyDigest,
        input.executionContractHash,
        input.assessmentInputHash,
        input.gateId ?? null,
        input.requestedBy
      ]
    );
    return mapAssessment(result.rows[0]);
  }

  async createAssessmentGraphIdempotently(
    input: IdempotentCreateAssessmentGraphInput
  ): Promise<IdempotentCreateAssessmentGraphResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const idempotencyInsert = await client.query<{
        organization_id: string;
      }>(
        `INSERT INTO assessment_idempotency (
           organization_id, idempotency_key, request_fingerprint, status
         ) VALUES ($1, $2, $3, 'IN_PROGRESS')
         ON CONFLICT (organization_id, idempotency_key) DO NOTHING
         RETURNING organization_id`,
        [
          input.idempotency.organizationId,
          input.idempotency.idempotencyKey,
          input.idempotency.requestFingerprint
        ]
      );

      if (!idempotencyInsert.rows[0]) {
        const existing = await client.query<{
          request_fingerprint: string;
          status: string;
          assessment_id: string | null;
        }>(
          `SELECT request_fingerprint, status, assessment_id
           FROM assessment_idempotency
           WHERE organization_id = $1 AND idempotency_key = $2
           FOR UPDATE`,
          [input.idempotency.organizationId, input.idempotency.idempotencyKey]
        );
        const row = existing.rows[0];
        if (!row || row.request_fingerprint !== input.idempotency.requestFingerprint) {
          throw new AssessmentIdempotencyConflictError();
        }
        if (row.status !== "COMPLETE" || !row.assessment_id) {
          await client.query("COMMIT");
          return {
            kind: "IN_PROGRESS",
            retryAfterSeconds: 2
          };
        }

        const assessmentResult = await client.query<DbAssessmentRow>(
          `SELECT * FROM governance_assessments WHERE assessment_id = $1`,
          [row.assessment_id]
        );
        const assessment = assessmentResult.rows[0];
        if (!assessment) {
          throw new Error(`Assessment idempotency record references missing assessment ${row.assessment_id}.`);
        }
        await client.query("COMMIT");
        return {
          kind: "REPLAYED",
          assessment: mapAssessment(assessment)
        };
      }

      await client.query(
        `INSERT INTO governance_profile_snapshots
           (profile_id, profile_version, profile_digest, profile_json)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (profile_id, profile_version) DO UPDATE
           SET profile_digest = EXCLUDED.profile_digest,
               profile_json   = EXCLUDED.profile_json`,
        [
          input.profileSnapshot.profileId,
          input.profileSnapshot.profileVersion,
          input.profileSnapshot.profileDigest,
          input.profileSnapshot.profileJson
        ]
      );
      await client.query(
        `INSERT INTO governance_policy_snapshots
           (policy_id, policy_version, policy_digest, policy_json)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (policy_id, policy_version) DO UPDATE
           SET policy_digest = EXCLUDED.policy_digest,
               policy_json   = EXCLUDED.policy_json`,
        [
          input.policySnapshot.policyId,
          input.policySnapshot.policyVersion,
          input.policySnapshot.policyDigest,
          input.policySnapshot.policyJson
        ]
      );
      await client.query(
        `INSERT INTO governance_execution_contract_snapshots
           (execution_contract_hash, contract_json)
         VALUES ($1, $2)
         ON CONFLICT (execution_contract_hash) DO NOTHING`,
        [
          input.executionContractSnapshot.executionContractHash,
          input.executionContractSnapshot.contractJson
        ]
      );

      const assessmentResult = await client.query<DbAssessmentRow>(
        `INSERT INTO governance_assessments (
           assessment_id, organization_id, artifact_id, subject_digest,
           profile_id, profile_version, profile_digest,
           policy_id, policy_version, policy_digest,
           execution_contract_hash, assessment_input_hash,
           gate_id, requested_by, status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'QUEUED')
         RETURNING *`,
        [
          input.assessment.assessmentId,
          input.assessment.organizationId,
          input.assessment.artifactId,
          input.assessment.subjectDigest,
          input.assessment.profileId,
          input.assessment.profileVersion,
          input.assessment.profileDigest,
          input.assessment.policyId,
          input.assessment.policyVersion,
          input.assessment.policyDigest,
          input.assessment.executionContractHash,
          input.assessment.assessmentInputHash,
          input.assessment.gateId ?? null,
          input.assessment.requestedBy
        ]
      );

      await client.query(
        `INSERT INTO governance_assessment_attempts (
           attempt_id, assessment_id, attempt_number, status
         ) VALUES ($1, $2, $3, 'QUEUED')`,
        [
          input.attempt.attemptId,
          input.attempt.assessmentId,
          input.attempt.attemptNumber
        ]
      );

      await client.query(
        `INSERT INTO governance_jobs (
           job_id, assessment_id, attempt_id, job_type, status, available_at
         ) VALUES ($1, $2, $3, 'GOVERNANCE_ASSESSMENT', 'AVAILABLE', $4::timestamptz)`,
        [
          input.job.jobId,
          input.job.assessmentId,
          input.job.attemptId,
          input.job.availableAt ?? new Date().toISOString()
        ]
      );

      await client.query(
        `UPDATE assessment_idempotency
         SET status = 'COMPLETE',
             assessment_id = $3,
             completed_at = NOW()
         WHERE organization_id = $1 AND idempotency_key = $2`,
        [
          input.idempotency.organizationId,
          input.idempotency.idempotencyKey,
          input.assessment.assessmentId
        ]
      );

      await client.query("COMMIT");
      return {
        kind: "CREATED",
        assessment: mapAssessment(assessmentResult.rows[0])
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getAssessment(assessmentId: string): Promise<AssessmentRecord | null> {
    const result = await this.pool.query<DbAssessmentRow>(
      `SELECT * FROM governance_assessments WHERE assessment_id = $1`,
      [assessmentId]
    );
    return result.rows[0] ? mapAssessment(result.rows[0]) : null;
  }

  async updateAssessmentStatus(
    assessmentId: string,
    status: AssessmentStatus,
    patch?: {
      errorCode?: string | null;
      errorMessage?: string | null;
    }
  ): Promise<AssessmentRecord | null> {
    const result = await this.pool.query<DbAssessmentRow>(
      `UPDATE governance_assessments
       SET status = $2,
           error_code = COALESCE($3, error_code),
           error_message = COALESCE($4, error_message),
           updated_at = NOW()
       WHERE assessment_id = $1
       RETURNING *`,
      [assessmentId, status, patch?.errorCode ?? null, patch?.errorMessage ?? null]
    );
    return result.rows[0] ? mapAssessment(result.rows[0]) : null;
  }

  // -----------------------------------------------------------------------
  // Attempts
  // -----------------------------------------------------------------------

  async createAssessmentAttempt(
    input: CreateAssessmentAttemptInput
  ): Promise<AssessmentAttemptRecord> {
    const result = await this.pool.query<DbAttemptRow>(
      `INSERT INTO governance_assessment_attempts (
         attempt_id, assessment_id, attempt_number, status
       ) VALUES ($1, $2, $3, 'QUEUED')
       RETURNING *`,
      [input.attemptId, input.assessmentId, input.attemptNumber]
    );
    return mapAttempt(result.rows[0]);
  }

  async getAttempt(attemptId: string): Promise<AssessmentAttemptRecord | null> {
    const result = await this.pool.query<DbAttemptRow>(
      `SELECT * FROM governance_assessment_attempts WHERE attempt_id = $1`,
      [attemptId]
    );
    return result.rows[0] ? mapAttempt(result.rows[0]) : null;
  }

  async listAttemptsByAssessment(assessmentId: string): Promise<AssessmentAttemptRecord[]> {
    const result = await this.pool.query<DbAttemptRow>(
      `SELECT * FROM governance_assessment_attempts
       WHERE assessment_id = $1
       ORDER BY attempt_number ASC`,
      [assessmentId]
    );
    return result.rows.map(mapAttempt);
  }

  async updateAttemptStatus(
    attemptId: string,
    status: AssessmentAttemptStatus,
    patch?: {
      workerId?: string | null;
      errorCode?: string | null;
      errorMessage?: string | null;
    }
  ): Promise<AssessmentAttemptRecord | null> {
    const now = new Date().toISOString();
    const startedAt = status === "RUNNING" ? now : undefined;
    const completedAt =
      status === "COMPLETE" || status === "ERROR" || status === "CANCELLED" ? now : undefined;

    const result = await this.pool.query<DbAttemptRow>(
      `UPDATE governance_assessment_attempts
       SET status        = $2,
           worker_id     = COALESCE($3, worker_id),
           started_at    = COALESCE($4::timestamptz, started_at),
           completed_at  = COALESCE($5::timestamptz, completed_at),
           error_code    = COALESCE($6, error_code),
           error_message = COALESCE($7, error_message),
           updated_at    = NOW()
       WHERE attempt_id = $1
       RETURNING *`,
      [
        attemptId,
        status,
        patch?.workerId ?? null,
        startedAt ?? null,
        completedAt ?? null,
        patch?.errorCode ?? null,
        patch?.errorMessage ?? null
      ]
    );
    return result.rows[0] ? mapAttempt(result.rows[0]) : null;
  }

  // -----------------------------------------------------------------------
  // Governance Jobs
  // -----------------------------------------------------------------------

  async createGovernanceJob(input: CreateGovernanceJobInput): Promise<GovernanceJobRecord> {
    const availableAt = input.availableAt ?? new Date().toISOString();
    const result = await this.pool.query<DbJobRow>(
      `INSERT INTO governance_jobs (
         job_id, assessment_id, attempt_id, job_type, status, available_at
       ) VALUES ($1, $2, $3, 'GOVERNANCE_ASSESSMENT', 'AVAILABLE', $4::timestamptz)
       RETURNING *`,
      [input.jobId, input.assessmentId, input.attemptId, availableAt]
    );
    return mapJob(result.rows[0]);
  }

  /**
   * Atomically claim one available governance job using FOR UPDATE SKIP LOCKED.
   * Returns the claimed job or null if none is available.
   */
  async claimNextGovernanceJob(input: {
    workerId: string;
    leaseDurationSeconds?: number;
  }): Promise<GovernanceJobRecord | null> {
    const leaseSecs = Math.max(30, input.leaseDurationSeconds ?? 300);

    const result = await this.pool.query<DbJobRow>(
      `WITH candidate AS (
         SELECT job_id
         FROM governance_jobs
         WHERE (
             status = 'AVAILABLE'
             AND available_at <= NOW()
           )
           OR (
             status IN ('CLAIMED','RUNNING')
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at <= NOW()
           )
         ORDER BY available_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE governance_jobs gj
       SET status           = 'CLAIMED',
           worker_id        = $1,
           claimed_at       = NOW(),
           lease_expires_at = NOW() + make_interval(secs => $2),
           heartbeat_at     = NOW(),
           lease_generation  = gj.lease_generation + 1,
           claim_count      = gj.claim_count + 1,
           updated_at       = NOW()
       FROM candidate
       WHERE gj.job_id = candidate.job_id
       RETURNING gj.*`,
      [input.workerId, leaseSecs]
    );
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }

  async heartbeatJob(
    jobId: string,
    workerId: string,
    leaseGeneration?: number,
    leaseDurationSeconds?: number
  ): Promise<boolean> {
    const leaseSecs = Math.max(30, leaseDurationSeconds ?? 300);
    const result = await this.pool.query(
      `UPDATE governance_jobs
       SET heartbeat_at = NOW(),
           lease_expires_at = NOW() + make_interval(secs => $4),
           updated_at = NOW()
       WHERE job_id = $1
         AND worker_id = $2
         AND ($3::integer IS NULL OR lease_generation = $3)
         AND status IN ('CLAIMED','RUNNING')
         AND lease_expires_at > NOW()`,
      [jobId, workerId, leaseGeneration ?? null, leaseSecs]
    );
    return Number(result.rowCount ?? 0) > 0;
  }

  async transitionJobToRunning(
    jobId: string,
    workerId: string,
    leaseGeneration?: number
  ): Promise<GovernanceJobRecord | null> {
    const result = await this.pool.query<DbJobRow>(
      `UPDATE governance_jobs
       SET status = 'RUNNING', updated_at = NOW()
       WHERE job_id = $1
         AND worker_id = $2
         AND ($3::integer IS NULL OR lease_generation = $3)
         AND status = 'CLAIMED'
         AND lease_expires_at > NOW()
       RETURNING *`,
      [jobId, workerId, leaseGeneration ?? null]
    );
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }

  async completeJob(jobId: string, workerId: string, leaseGeneration?: number): Promise<GovernanceJobRecord | null> {
    const result = await this.pool.query<DbJobRow>(
      `UPDATE governance_jobs
       SET status = 'COMPLETE', lease_expires_at = NULL, updated_at = NOW()
       WHERE job_id = $1
         AND worker_id = $2
         AND ($3::integer IS NULL OR lease_generation = $3)
         AND status IN ('CLAIMED','RUNNING')
         AND lease_expires_at > NOW()
       RETURNING *`,
      [jobId, workerId, leaseGeneration ?? null]
    );
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }

  async failJob(
    jobId: string,
    workerId: string,
    error: { code: string; message: string },
    rescheduleAt?: string,
    leaseGeneration?: number
  ): Promise<GovernanceJobRecord | null> {
    if (rescheduleAt) {
      // Retryable: put back as AVAILABLE at a future time
      const result = await this.pool.query<DbJobRow>(
        `UPDATE governance_jobs
         SET status             = 'AVAILABLE',
             worker_id          = NULL,
             lease_expires_at   = NULL,
             available_at       = $3::timestamptz,
             last_error_code    = $4,
             last_error_message = $5,
             updated_at         = NOW()
         WHERE job_id = $1
           AND worker_id = $2
           AND ($6::integer IS NULL OR lease_generation = $6)
           AND status IN ('CLAIMED','RUNNING')
           AND lease_expires_at > NOW()
         RETURNING *`,
        [jobId, workerId, rescheduleAt, error.code, error.message, leaseGeneration ?? null]
      );
      return result.rows[0] ? mapJob(result.rows[0]) : null;
    }

    // Non-retryable: terminal FAILED
    const result = await this.pool.query<DbJobRow>(
      `UPDATE governance_jobs
       SET status             = 'FAILED',
           lease_expires_at   = NULL,
           last_error_code    = $3,
           last_error_message = $4,
           updated_at         = NOW()
       WHERE job_id = $1
         AND worker_id = $2
         AND ($5::integer IS NULL OR lease_generation = $5)
         AND status IN ('CLAIMED','RUNNING')
         AND lease_expires_at > NOW()
       RETURNING *`,
      [jobId, workerId, error.code, error.message, leaseGeneration ?? null]
    );
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }

  async cancelJob(jobId: string, workerId?: string, leaseGeneration?: number): Promise<GovernanceJobRecord | null> {
    const result = await this.pool.query<DbJobRow>(
      `UPDATE governance_jobs
       SET status = 'CANCELLED', lease_expires_at = NULL, updated_at = NOW()
       WHERE job_id = $1
         AND ($2::text IS NULL OR worker_id = $2)
         AND ($3::integer IS NULL OR lease_generation = $3)
         AND status IN ('AVAILABLE','CLAIMED','RUNNING')
         AND ($2::text IS NULL OR lease_expires_at > NOW())
       RETURNING *`,
      [jobId, workerId ?? null, leaseGeneration ?? null]
    );
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }

  async getGovernanceJob(jobId: string): Promise<GovernanceJobRecord | null> {
    const result = await this.pool.query<DbJobRow>(
      `SELECT * FROM governance_jobs WHERE job_id = $1`,
      [jobId]
    );
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }

  async getGovernanceJobByAttempt(attemptId: string): Promise<GovernanceJobRecord | null> {
    const result = await this.pool.query<DbJobRow>(
      `SELECT * FROM governance_jobs WHERE attempt_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [attemptId]
    );
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }

  // -----------------------------------------------------------------------
  // Evidence Cores
  // -----------------------------------------------------------------------

  /**
   * Upsert an evidence core. Cores are content-addressed: if the hash already
   * exists the row is left unchanged (semantically identical evidence).
   */
  async upsertEvidenceCore(input: PersistEvidenceCoreInput): Promise<EvidenceCoreRecord> {
    const result = await this.pool.query<{
      evidence_core_hash: string;
      schema_version: number;
      subject_digest: string;
      profile_digest: string;
      validator_id: string;
      validator_version: string;
      validator_implementation_digest: string;
      execution_contract_hash: string;
      trust_class: string;
      status: string;
      reason_codes_json: string;
      output_artifact_digests_json: string;
      core_json: string;
      created_at: Date;
    }>(
      `INSERT INTO evidence_cores (
         evidence_core_hash, schema_version, subject_digest, profile_digest,
         validator_id, validator_version, validator_implementation_digest,
         execution_contract_hash, trust_class, status,
         reason_codes_json, output_artifact_digests_json, core_json
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (evidence_core_hash) DO NOTHING
       RETURNING *`,
      [
        input.evidenceCoreHash,
        input.schemaVersion,
        input.subjectDigest,
        input.profileDigest,
        input.validatorId,
        input.validatorVersion,
        input.validatorImplementationDigest,
        input.executionContractHash,
        input.trustClass,
        input.status,
        JSON.stringify(input.reasonCodes),
        JSON.stringify(input.outputArtifactDigests),
        input.coreJson
      ]
    );

    if (result.rows[0]) {
      return this.mapEvidenceCore(result.rows[0]);
    }

    // Already existed — fetch it
    const existing = await this.pool.query<{
      evidence_core_hash: string;
      schema_version: number;
      subject_digest: string;
      profile_digest: string;
      validator_id: string;
      validator_version: string;
      validator_implementation_digest: string;
      execution_contract_hash: string;
      trust_class: string;
      status: string;
      reason_codes_json: string;
      output_artifact_digests_json: string;
      core_json: string;
      created_at: Date;
    }>(
      `SELECT * FROM evidence_cores WHERE evidence_core_hash = $1`,
      [input.evidenceCoreHash]
    );
    return this.mapEvidenceCore(existing.rows[0]);
  }

  private mapEvidenceCore(row: {
    evidence_core_hash: string;
    schema_version: number;
    subject_digest: string;
    profile_digest: string;
    validator_id: string;
    validator_version: string;
    validator_implementation_digest: string;
    execution_contract_hash: string;
    trust_class: string;
    status: string;
    reason_codes_json: string;
    output_artifact_digests_json: string;
    core_json: string;
    created_at: Date;
  }): EvidenceCoreRecord {
    return {
      evidenceCoreHash: row.evidence_core_hash,
      schemaVersion: row.schema_version,
      subjectDigest: row.subject_digest,
      profileDigest: row.profile_digest,
      validatorId: row.validator_id,
      validatorVersion: row.validator_version,
      validatorImplementationDigest: row.validator_implementation_digest,
      executionContractHash: row.execution_contract_hash,
      trustClass: row.trust_class,
      status: row.status,
      reasonCodesJson: row.reason_codes_json,
      outputArtifactDigestsJson: row.output_artifact_digests_json,
      coreJson: row.core_json,
      createdAt: row.created_at.toISOString()
    };
  }

  async getEvidenceCore(evidenceCoreHash: string): Promise<EvidenceCoreRecord | null> {
    const result = await this.pool.query<{
      evidence_core_hash: string;
      schema_version: number;
      subject_digest: string;
      profile_digest: string;
      validator_id: string;
      validator_version: string;
      validator_implementation_digest: string;
      execution_contract_hash: string;
      trust_class: string;
      status: string;
      reason_codes_json: string;
      output_artifact_digests_json: string;
      core_json: string;
      created_at: Date;
    }>(
      `SELECT * FROM evidence_cores WHERE evidence_core_hash = $1`,
      [evidenceCoreHash]
    );
    return result.rows[0] ? this.mapEvidenceCore(result.rows[0]) : null;
  }

  // -----------------------------------------------------------------------
  // Evidence Envelopes
  // -----------------------------------------------------------------------

  async persistEvidenceEnvelope(
    input: PersistEvidenceEnvelopeInput
  ): Promise<EvidenceEnvelopeRecord> {
    const result = await this.pool.query<{
      evidence_envelope_id: string;
      evidence_core_hash: string;
      assessment_id: string;
      attempt_id: string;
      worker_id: string | null;
      started_at: Date;
      completed_at: Date;
      diagnostics_json: string;
      log_artifact_refs_json: string;
      envelope_json: string;
      created_at: Date;
    }>(
      `INSERT INTO evidence_envelopes (
         evidence_envelope_id, evidence_core_hash, assessment_id, attempt_id,
         worker_id, started_at, completed_at,
         diagnostics_json, log_artifact_refs_json, envelope_json
       ) VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz,$8,$9,$10)
       RETURNING *`,
      [
        input.evidenceEnvelopeId,
        input.evidenceCoreHash,
        input.assessmentId,
        input.attemptId,
        input.workerId ?? null,
        input.startedAt,
        input.completedAt,
        JSON.stringify(input.diagnostics),
        JSON.stringify(input.logArtifactRefs),
        input.envelopeJson
      ]
    );
    const row = result.rows[0];
    return {
      evidenceEnvelopeId: row.evidence_envelope_id,
      evidenceCoreHash: row.evidence_core_hash,
      assessmentId: row.assessment_id,
      attemptId: row.attempt_id,
      workerId: row.worker_id,
      startedAt: row.started_at.toISOString(),
      completedAt: row.completed_at.toISOString(),
      diagnosticsJson: row.diagnostics_json,
      logArtifactRefsJson: row.log_artifact_refs_json,
      envelopeJson: row.envelope_json,
      createdAt: row.created_at.toISOString()
    };
  }

  async getEvidenceEnvelopesByAttempt(attemptId: string): Promise<EvidenceEnvelopeRecord[]> {
    const result = await this.pool.query<{
      evidence_envelope_id: string;
      evidence_core_hash: string;
      assessment_id: string;
      attempt_id: string;
      worker_id: string | null;
      started_at: Date;
      completed_at: Date;
      diagnostics_json: string;
      log_artifact_refs_json: string;
      envelope_json: string;
      created_at: Date;
    }>(
      `SELECT * FROM evidence_envelopes WHERE attempt_id = $1 ORDER BY created_at ASC`,
      [attemptId]
    );
    return result.rows.map((row) => ({
      evidenceEnvelopeId: row.evidence_envelope_id,
      evidenceCoreHash: row.evidence_core_hash,
      assessmentId: row.assessment_id,
      attemptId: row.attempt_id,
      workerId: row.worker_id,
      startedAt: row.started_at.toISOString(),
      completedAt: row.completed_at.toISOString(),
      diagnosticsJson: row.diagnostics_json,
      logArtifactRefsJson: row.log_artifact_refs_json,
      envelopeJson: row.envelope_json,
      createdAt: row.created_at.toISOString()
    }));
  }

  // -----------------------------------------------------------------------
  // Assessment ↔ Evidence Links
  // -----------------------------------------------------------------------

  async linkEvidenceToAssessment(input: {
    assessmentId: string;
    attemptId: string;
    validatorId: string;
    evidenceCoreHash: string;
    evidenceEnvelopeId: string;
  }): Promise<void> {
    const finalized = await this.pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM evidence_manifests
         WHERE assessment_id = $1 AND attempt_id = $2
       ) AS exists`,
      [input.assessmentId, input.attemptId]
    );
    if (finalized.rows[0]?.exists) {
      throw new Error(
        `Cannot attach evidence after manifest finalization for assessment ${input.assessmentId}, attempt ${input.attemptId}.`
      );
    }

    await this.pool.query(
      `INSERT INTO assessment_evidence (
         assessment_id, attempt_id, validator_id,
         evidence_core_hash, evidence_envelope_id, selected_for_decision
       ) VALUES ($1,$2,$3,$4,$5,FALSE)
       ON CONFLICT (assessment_id, attempt_id, validator_id) DO UPDATE
         SET evidence_core_hash   = EXCLUDED.evidence_core_hash,
             evidence_envelope_id = EXCLUDED.evidence_envelope_id`,
      [
        input.assessmentId,
        input.attemptId,
        input.validatorId,
        input.evidenceCoreHash,
        input.evidenceEnvelopeId
      ]
    );
  }

  async getEvidenceLinksByAttempt(
    assessmentId: string,
    attemptId: string
  ): Promise<AssessmentEvidenceLink[]> {
    const result = await this.pool.query<{
      assessment_id: string;
      attempt_id: string;
      validator_id: string;
      evidence_core_hash: string;
      evidence_envelope_id: string;
      selected_for_decision: boolean;
    }>(
      `SELECT * FROM assessment_evidence
       WHERE assessment_id = $1 AND attempt_id = $2
       ORDER BY validator_id ASC`,
      [assessmentId, attemptId]
    );
    return result.rows.map((row) => ({
      assessmentId: row.assessment_id,
      attemptId: row.attempt_id,
      validatorId: row.validator_id,
      evidenceCoreHash: row.evidence_core_hash,
      evidenceEnvelopeId: row.evidence_envelope_id,
      selectedForDecision: row.selected_for_decision
    }));
  }

  async getSelectedEvidenceLinks(assessmentId: string): Promise<AssessmentEvidenceLink[]> {
    const result = await this.pool.query<{
      assessment_id: string;
      attempt_id: string;
      validator_id: string;
      evidence_core_hash: string;
      evidence_envelope_id: string;
      selected_for_decision: boolean;
    }>(
      `SELECT * FROM assessment_evidence
       WHERE assessment_id = $1 AND selected_for_decision = TRUE
       ORDER BY validator_id ASC`,
      [assessmentId]
    );
    return result.rows.map((row) => ({
      assessmentId: row.assessment_id,
      attemptId: row.attempt_id,
      validatorId: row.validator_id,
      evidenceCoreHash: row.evidence_core_hash,
      evidenceEnvelopeId: row.evidence_envelope_id,
      selectedForDecision: row.selected_for_decision
    }));
  }

  // -----------------------------------------------------------------------
  // Evidence Manifests
  // -----------------------------------------------------------------------

  async persistEvidenceManifest(
    input: CreateEvidenceManifestInput
  ): Promise<EvidenceManifestRecord> {
    const result = await this.pool.query<{
      evidence_manifest_id: string;
      assessment_id: string;
      attempt_id: string;
      evidence_manifest_hash: string;
      manifest_json: string;
      created_at: Date;
    }>(
      `INSERT INTO evidence_manifests (
         evidence_manifest_id, assessment_id, attempt_id,
         evidence_manifest_hash, manifest_json
       ) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (assessment_id, attempt_id) DO UPDATE
         SET evidence_manifest_hash = EXCLUDED.evidence_manifest_hash,
             manifest_json          = EXCLUDED.manifest_json
       RETURNING *`,
      [
        input.evidenceManifestId,
        input.assessmentId,
        input.attemptId,
        input.evidenceManifestHash,
        input.manifestJson
      ]
    );
    const row = result.rows[0];
    return {
      evidenceManifestId: row.evidence_manifest_id,
      assessmentId: row.assessment_id,
      attemptId: row.attempt_id,
      evidenceManifestHash: row.evidence_manifest_hash,
      manifestJson: row.manifest_json,
      createdAt: row.created_at.toISOString()
    };
  }

  async getEvidenceManifestByAttempt(
    assessmentId: string,
    attemptId: string
  ): Promise<EvidenceManifestRecord | null> {
    const result = await this.pool.query<{
      evidence_manifest_id: string;
      assessment_id: string;
      attempt_id: string;
      evidence_manifest_hash: string;
      manifest_json: string;
      created_at: Date;
    }>(
      `SELECT * FROM evidence_manifests WHERE assessment_id = $1 AND attempt_id = $2`,
      [assessmentId, attemptId]
    );
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    return {
      evidenceManifestId: row.evidence_manifest_id,
      assessmentId: row.assessment_id,
      attemptId: row.attempt_id,
      evidenceManifestHash: row.evidence_manifest_hash,
      manifestJson: row.manifest_json,
      createdAt: row.created_at.toISOString()
    };
  }

  async getLatestEvidenceManifest(
    assessmentId: string
  ): Promise<EvidenceManifestRecord | null> {
    const result = await this.pool.query<{
      evidence_manifest_id: string;
      assessment_id: string;
      attempt_id: string;
      evidence_manifest_hash: string;
      manifest_json: string;
      created_at: Date;
    }>(
      `SELECT * FROM evidence_manifests
       WHERE assessment_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [assessmentId]
    );
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    return {
      evidenceManifestId: row.evidence_manifest_id,
      assessmentId: row.assessment_id,
      attemptId: row.attempt_id,
      evidenceManifestHash: row.evidence_manifest_hash,
      manifestJson: row.manifest_json,
      createdAt: row.created_at.toISOString()
    };
  }

  async listDecidingAssessmentsWithoutDecision(limit = 100): Promise<AssessmentRecord[]> {
    const result = await this.pool.query<DbAssessmentRow>(
      `SELECT a.*
       FROM governance_assessments a
       LEFT JOIN issued_decisions d ON d.assessment_id = a.assessment_id
       WHERE a.status = 'DECIDING'
         AND d.assessment_id IS NULL
       ORDER BY a.updated_at ASC
       LIMIT $1`,
      [Math.max(1, Math.min(limit, 1000))]
    );
    return result.rows.map(mapAssessment);
  }

  // -----------------------------------------------------------------------
  // Issued Decisions
  // -----------------------------------------------------------------------

  private mapIssuedDecision(row: {
    assessment_id: string;
    organization_id: string;
    decision_hash: string;
    decision_core_json: string;
    issued_decision_json: string;
    issued_at: Date;
    issuer: string;
    created_at: Date;
  }): IssuedDecisionRecord {
    return {
      assessmentId: row.assessment_id,
      organizationId: row.organization_id,
      decisionHash: row.decision_hash,
      decisionCoreJson: row.decision_core_json,
      issuedDecisionJson: row.issued_decision_json,
      issuedAt: row.issued_at.toISOString(),
      issuer: row.issuer,
      createdAt: row.created_at.toISOString()
    };
  }

  async getIssuedDecisionByAssessment(
    assessmentId: string
  ): Promise<IssuedDecisionRecord | null> {
    const result = await this.pool.query<{
      assessment_id: string;
      organization_id: string;
      decision_hash: string;
      decision_core_json: string;
      issued_decision_json: string;
      issued_at: Date;
      issuer: string;
      created_at: Date;
    }>(
      `SELECT * FROM issued_decisions WHERE assessment_id = $1`,
      [assessmentId]
    );
    return result.rows[0] ? this.mapIssuedDecision(result.rows[0]) : null;
  }

  async getIssuedDecisionByHash(input: {
    organizationId: string;
    decisionHash: string;
  }): Promise<IssuedDecisionRecord | null> {
    const result = await this.pool.query<{
      assessment_id: string;
      organization_id: string;
      decision_hash: string;
      decision_core_json: string;
      issued_decision_json: string;
      issued_at: Date;
      issuer: string;
      created_at: Date;
    }>(
      `SELECT * FROM issued_decisions
       WHERE organization_id = $1 AND decision_hash = $2`,
      [input.organizationId, input.decisionHash]
    );
    return result.rows[0] ? this.mapIssuedDecision(result.rows[0]) : null;
  }

  async persistIssuedDecisionAtomically(
    input: PersistIssuedDecisionInput
  ): Promise<IssuedDecisionRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const assessmentResult = await client.query<{
        assessment_id: string;
        organization_id: string;
        status: string;
        decision_hash: string | null;
      }>(
        `SELECT assessment_id, organization_id, status, decision_hash
         FROM governance_assessments
         WHERE assessment_id = $1
         FOR UPDATE`,
        [input.assessmentId]
      );
      const assessment = assessmentResult.rows[0];
      if (!assessment) {
        throw new Error(`Assessment ${input.assessmentId} not found.`);
      }

      const existing = await client.query<{
        assessment_id: string;
        organization_id: string;
        decision_hash: string;
        decision_core_json: string;
        issued_decision_json: string;
        issued_at: Date;
        issuer: string;
        created_at: Date;
      }>(
        `SELECT * FROM issued_decisions WHERE assessment_id = $1 FOR UPDATE`,
        [input.assessmentId]
      );

      if (existing.rows[0]) {
        if (existing.rows[0].decision_hash !== input.decisionHash) {
          throw new Error(
            `Decision hash conflict for assessment ${input.assessmentId}: stored ${existing.rows[0].decision_hash}, recomputed ${input.decisionHash}.`
          );
        }
        await client.query("COMMIT");
        return this.mapIssuedDecision(existing.rows[0]);
      }

      if (assessment.status !== "DECIDING") {
        throw new Error(
          `Assessment ${input.assessmentId} must be DECIDING to issue a decision (status=${assessment.status}).`
        );
      }

      const insertResult = await client.query<{
        assessment_id: string;
        organization_id: string;
        decision_hash: string;
        decision_core_json: string;
        issued_decision_json: string;
        issued_at: Date;
        issuer: string;
        created_at: Date;
      }>(
        `INSERT INTO issued_decisions (
           assessment_id, organization_id, decision_hash, decision_core_json,
           issued_decision_json, issued_at, issuer
         ) VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7)
         RETURNING *`,
        [
          input.assessmentId,
          assessment.organization_id,
          input.decisionHash,
          input.decisionCoreJson,
          input.issuedDecisionJson,
          input.issuedAt,
          input.issuer
        ]
      );

      await client.query(
        `UPDATE governance_assessments
         SET decision_hash = $2, status = 'COMPLETE', updated_at = NOW()
         WHERE assessment_id = $1`,
        [input.assessmentId, input.decisionHash]
      );

      await client.query("COMMIT");
      return this.mapIssuedDecision(insertResult.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // -----------------------------------------------------------------------
  // Atomic attempt-completion transaction
  //
  // Verifies the attempt is RUNNING and the assessment is RUNNING, then:
  //   1. marks evidence as selected_for_decision
  //   2. persists the manifest
  //   3. marks the attempt COMPLETE
  //   4. marks the job COMPLETE
  //   5. moves the assessment to DECIDING
  //
  // All in one transaction so no partial state can be observed.
  // -----------------------------------------------------------------------

  async completeAttemptAtomically(input: {
    assessmentId: string;
    attemptId: string;
    jobId: string;
    workerId: string;
    leaseGeneration?: number;
    manifest: CreateEvidenceManifestInput;
    evidenceValidatorIds: string[];
  }): Promise<{ manifestRecord: EvidenceManifestRecord; assessmentRecord: AssessmentRecord }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Verify attempt is RUNNING
      const attemptCheck = await client.query<{ status: string }>(
        `SELECT status FROM governance_assessment_attempts WHERE attempt_id = $1 FOR UPDATE`,
        [input.attemptId]
      );
      if (attemptCheck.rows[0]?.status !== "RUNNING") {
        throw new Error(
          `Attempt ${input.attemptId} is not RUNNING (status=${attemptCheck.rows[0]?.status ?? "not found"})`
        );
      }

      // Verify assessment is RUNNING
      const assessmentCheck = await client.query<{ status: string }>(
        `SELECT status FROM governance_assessments WHERE assessment_id = $1 FOR UPDATE`,
        [input.assessmentId]
      );
      if (assessmentCheck.rows[0]?.status !== "RUNNING") {
        throw new Error(
          `Assessment ${input.assessmentId} is not RUNNING (status=${assessmentCheck.rows[0]?.status ?? "not found"})`
        );
      }

      // Verify required evidence records exist
      if (input.evidenceValidatorIds.length > 0) {
        const existing = await client.query<{ count: string }>(
          `SELECT COUNT(*) as count FROM assessment_evidence
           WHERE assessment_id = $1 AND attempt_id = $2`,
          [input.assessmentId, input.attemptId]
        );
        const count = Number(existing.rows[0]?.count ?? 0);
        if (count < input.evidenceValidatorIds.length) {
          throw new Error(
            `Expected ${input.evidenceValidatorIds.length} evidence records, found ${count}`
          );
        }
      }

      // Mark evidence as selected_for_decision
      await client.query(
        `UPDATE assessment_evidence
         SET selected_for_decision = TRUE
         WHERE assessment_id = $1 AND attempt_id = $2`,
        [input.assessmentId, input.attemptId]
      );

      // Persist manifest
      const manifestResult = await client.query<{
        evidence_manifest_id: string;
        assessment_id: string;
        attempt_id: string;
        evidence_manifest_hash: string;
        manifest_json: string;
        created_at: Date;
      }>(
        `INSERT INTO evidence_manifests (
           evidence_manifest_id, assessment_id, attempt_id,
           evidence_manifest_hash, manifest_json
         ) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (assessment_id, attempt_id) DO UPDATE
           SET evidence_manifest_hash = EXCLUDED.evidence_manifest_hash,
               manifest_json          = EXCLUDED.manifest_json
         RETURNING *`,
        [
          input.manifest.evidenceManifestId,
          input.assessmentId,
          input.attemptId,
          input.manifest.evidenceManifestHash,
          input.manifest.manifestJson
        ]
      );

      // Mark attempt COMPLETE
      await client.query(
        `UPDATE governance_assessment_attempts
         SET status = 'COMPLETE', completed_at = NOW(), updated_at = NOW()
         WHERE attempt_id = $1`,
        [input.attemptId]
      );

      // Mark job COMPLETE
      const jobCompleteResult = await client.query(
        `UPDATE governance_jobs
         SET status = 'COMPLETE', lease_expires_at = NULL, updated_at = NOW()
         WHERE job_id = $1
           AND worker_id = $2
           AND ($3::integer IS NULL OR lease_generation = $3)
           AND status IN ('CLAIMED','RUNNING')
           AND lease_expires_at > NOW()`,
        [input.jobId, input.workerId, input.leaseGeneration ?? null]
      );
      if (Number(jobCompleteResult.rowCount ?? 0) !== 1) {
        throw new Error(`Job ${input.jobId} is no longer owned by worker ${input.workerId}.`);
      }

      // Move assessment to DECIDING
      const assessmentResult = await client.query<DbAssessmentRow>(
        `UPDATE governance_assessments
         SET status = 'DECIDING', updated_at = NOW()
         WHERE assessment_id = $1
         RETURNING *`,
        [input.assessmentId]
      );

      await client.query("COMMIT");

      const mRow = manifestResult.rows[0];
      const manifestRecord: EvidenceManifestRecord = {
        evidenceManifestId: mRow.evidence_manifest_id,
        assessmentId: mRow.assessment_id,
        attemptId: mRow.attempt_id,
        evidenceManifestHash: mRow.evidence_manifest_hash,
        manifestJson: mRow.manifest_json,
        createdAt: mRow.created_at.toISOString()
      };

      return {
        manifestRecord,
        assessmentRecord: mapAssessment(assessmentResult.rows[0])
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
