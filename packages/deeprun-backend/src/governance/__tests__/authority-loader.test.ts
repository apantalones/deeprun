import assert from "node:assert/strict";
import test from "node:test";
import {
  AssessmentAuthorityStateMismatchError,
  AssessmentAuthorityMissingError,
  loadAndVerifyAssessmentAuthority
} from "../authority-loader.js";
import { buildAssessmentInputHash } from "../assessment-hash.js";
import { buildProfileDigest, nodeFastifyPrismaProfileV1 } from "../profiles.js";
import { createHash } from "node:crypto";
import type { GovernanceStore } from "../governance-store.js";
import type {
  AssessmentRecord,
  AssessmentAttemptRecord,
  PersistedProfileSnapshot,
  PersistedPolicySnapshot,
  PersistedExecutionContractSnapshot
} from "../assessment-types.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const PROFILE = nodeFastifyPrismaProfileV1;
const PROFILE_JSON = JSON.stringify(PROFILE);
const PROFILE_DIGEST = buildProfileDigest(PROFILE);

const POLICY = { policySchemaVersion: 1, id: "default-policy", version: "1.0.0", rules: [] };
const POLICY_JSON = JSON.stringify(POLICY);

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        typeof value === "string" ? value : sortedJson(value)
      )
    )
    .digest("hex");
}

function sortedJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${sortedJson(v)}`).join(",")}}`;
}

const POLICY_DIGEST = createHash("sha256").update(sortedJson(POLICY)).digest("hex");
const CONTRACT_HASH = "aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd";

const SUBJECT_DIGEST = "sha256:subject-aaaa";

const ASSESSMENT_INPUT_HASH = buildAssessmentInputHash({
  subjectDigest: SUBJECT_DIGEST,
  profileDigest: PROFILE_DIGEST,
  policyDigest: POLICY_DIGEST,
  executionContractHash: CONTRACT_HASH
});

function makeAssessment(overrides?: Partial<AssessmentRecord>): AssessmentRecord {
  return {
    assessmentId: "asmt-001",
    organizationId: "org-001",
    artifactId: "art-001",
    subjectDigest: SUBJECT_DIGEST,
    profileId: PROFILE.id,
    profileVersion: PROFILE.version,
    profileDigest: PROFILE_DIGEST,
    policyId: POLICY.id,
    policyVersion: POLICY.version,
    policyDigest: POLICY_DIGEST,
    executionContractHash: CONTRACT_HASH,
    assessmentInputHash: ASSESSMENT_INPUT_HASH,
    gateId: null,
    requestedBy: "user-001",
    status: "RUNNING",
    createdAt: "2026-06-26T00:00:00.000Z",
    updatedAt: "2026-06-26T00:00:00.000Z",
    ...overrides
  };
}

function makeAttempt(overrides?: Partial<AssessmentAttemptRecord>): AssessmentAttemptRecord {
  return {
    attemptId: "att-001",
    assessmentId: "asmt-001",
    attemptNumber: 1,
    status: "RUNNING",
    workerId: "worker-001",
    startedAt: "2026-06-26T00:00:00.000Z",
    completedAt: null,
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-06-26T00:00:00.000Z",
    updatedAt: "2026-06-26T00:00:00.000Z",
    ...overrides
  };
}

function makeProfileSnapshot(): PersistedProfileSnapshot {
  return {
    profileId: PROFILE.id,
    profileVersion: PROFILE.version,
    profileDigest: PROFILE_DIGEST,
    profileJson: PROFILE_JSON
  };
}

function makePolicySnapshot(): PersistedPolicySnapshot {
  return {
    policyId: POLICY.id,
    policyVersion: POLICY.version,
    policyDigest: POLICY_DIGEST,
    policyJson: POLICY_JSON
  };
}

function makeContractSnapshot(): PersistedExecutionContractSnapshot {
  return {
    executionContractHash: CONTRACT_HASH,
    contractJson: JSON.stringify({ hash: CONTRACT_HASH, schemaVersion: 1 })
  };
}

/**
 * Build a minimal GovernanceStore mock where every method can be overridden.
 */
function makeStore(overrides?: Partial<GovernanceStore>): GovernanceStore {
  const base: Partial<GovernanceStore> = {
    getAssessment: async () => makeAssessment(),
    getAttempt: async () => makeAttempt(),
    getProfileSnapshot: async () => makeProfileSnapshot(),
    getPolicySnapshot: async () => makePolicySnapshot(),
    getExecutionContractSnapshot: async () => makeContractSnapshot(),
    ...overrides
  };
  return base as GovernanceStore;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("loadAndVerifyAssessmentAuthority succeeds with valid authority state", async () => {
  const store = makeStore();
  const authority = await loadAndVerifyAssessmentAuthority(store, "asmt-001", "att-001");
  assert.equal(authority.assessment.assessmentId, "asmt-001");
  assert.equal(authority.attempt.attemptId, "att-001");
  assert.equal(authority.profileSnapshot.profileDigest, PROFILE_DIGEST);
  assert.equal(authority.policySnapshot.policyDigest, POLICY_DIGEST);
  assert.equal(authority.executionContractSnapshot.executionContractHash, CONTRACT_HASH);
});

test("loadAndVerifyAssessmentAuthority throws missing error when assessment is absent", async () => {
  const store = makeStore({ getAssessment: async () => null });
  await assert.rejects(
    () => loadAndVerifyAssessmentAuthority(store, "asmt-001", "att-001"),
    AssessmentAuthorityMissingError
  );
});

test("loadAndVerifyAssessmentAuthority throws missing error when attempt is absent", async () => {
  const store = makeStore({ getAttempt: async () => null });
  await assert.rejects(
    () => loadAndVerifyAssessmentAuthority(store, "asmt-001", "att-001"),
    AssessmentAuthorityMissingError
  );
});

test("loadAndVerifyAssessmentAuthority throws mismatch when profile snapshot is absent", async () => {
  const store = makeStore({ getProfileSnapshot: async () => null });
  await assert.rejects(
    () => loadAndVerifyAssessmentAuthority(store, "asmt-001", "att-001"),
    AssessmentAuthorityMissingError
  );
});

test("loadAndVerifyAssessmentAuthority throws mismatch when profile digest is wrong", async () => {
  const corruptSnapshot = { ...makeProfileSnapshot(), profileDigest: "wrong" };
  // The corrupt snapshot still has the right profileJson — the recomputed digest
  // will not match the stored assessmentDigest.
  // We need the assessment to reference the wrong digest too,
  // but the stored assessment.profileDigest must differ from recomputed.
  const corruptAssessment = makeAssessment({ profileDigest: "wrong" });
  const store = makeStore({
    getAssessment: async () => corruptAssessment,
    getProfileSnapshot: async () => corruptSnapshot
  });
  await assert.rejects(
    () => loadAndVerifyAssessmentAuthority(store, "asmt-001", "att-001"),
    AssessmentAuthorityStateMismatchError
  );
});

test("loadAndVerifyAssessmentAuthority throws mismatch when assessmentInputHash is wrong", async () => {
  const corruptAssessment = makeAssessment({ assessmentInputHash: "0".repeat(64) });
  const store = makeStore({ getAssessment: async () => corruptAssessment });
  await assert.rejects(
    () => loadAndVerifyAssessmentAuthority(store, "asmt-001", "att-001"),
    AssessmentAuthorityStateMismatchError
  );
});

test("AssessmentAuthorityStateMismatchError has code ASSESSMENT_AUTHORITY_STATE_MISMATCH", () => {
  const err = new AssessmentAuthorityStateMismatchError("profileDigest", "expected", "actual");
  assert.equal(err.code, "ASSESSMENT_AUTHORITY_STATE_MISMATCH");
  assert.equal(err.field, "profileDigest");
  assert.equal(err.expected, "expected");
  assert.equal(err.actual, "actual");
});

test("AssessmentAuthorityMissingError has code ASSESSMENT_AUTHORITY_STATE_MISMATCH", () => {
  const err = new AssessmentAuthorityMissingError("profileSnapshot", "not found");
  assert.equal(err.code, "ASSESSMENT_AUTHORITY_STATE_MISMATCH");
  assert.equal(err.field, "profileSnapshot");
});
