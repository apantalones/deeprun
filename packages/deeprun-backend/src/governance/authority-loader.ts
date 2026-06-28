import { buildAssessmentInputHash } from "./assessment-hash.js";
import { buildProfileDigest } from "./profiles.js";
import type { GovernanceStore } from "./governance-store.js";
import type {
  PersistedAssessmentAuthority,
  PersistedProfileSnapshot,
  PersistedPolicySnapshot,
  PersistedExecutionContractSnapshot
} from "./assessment-types.js";

// ---------------------------------------------------------------------------
// Authority digest mismatch error
// ---------------------------------------------------------------------------

export class AssessmentAuthorityStateMismatchError extends Error {
  readonly code = "ASSESSMENT_AUTHORITY_STATE_MISMATCH" as const;
  readonly field: string;
  readonly expected: string;
  readonly actual: string;

  constructor(field: string, expected: string, actual: string) {
    super(
      `Authority state mismatch on ${field}: persisted assessment records expected ${expected} but recomputed ${actual}.`
    );
    this.field = field;
    this.expected = expected;
    this.actual = actual;
  }
}

export class AssessmentAuthorityMissingError extends Error {
  readonly code = "ASSESSMENT_AUTHORITY_STATE_MISMATCH" as const;
  readonly field: string;

  constructor(field: string, detail: string) {
    super(`Authority state missing for ${field}: ${detail}`);
    this.field = field;
  }
}

// ---------------------------------------------------------------------------
// Canonical JSON for policy digest computation
// (mirrors the pattern in profiles.ts and evidence.ts)
// ---------------------------------------------------------------------------

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

import { createHash } from "node:crypto";

function sha256OfCanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

// ---------------------------------------------------------------------------
// Authority loader
// ---------------------------------------------------------------------------

/**
 * Reload all persisted authority inputs for an assessment and verify that
 * every stored digest still matches the recomputed value.
 *
 * A mismatch produces AssessmentAuthorityStateMismatchError which the
 * evaluator turns into a terminal ASSESSMENT_AUTHORITY_STATE_MISMATCH error.
 * This is NOT a validation failure — it means governance state is corrupt.
 */
export async function loadAndVerifyAssessmentAuthority(
  governanceStore: GovernanceStore,
  assessmentId: string,
  attemptId: string
): Promise<PersistedAssessmentAuthority> {
  // -------------------------------------------------------------------------
  // 1. Load core records
  // -------------------------------------------------------------------------
  const assessment = await governanceStore.getAssessment(assessmentId);
  if (!assessment) {
    throw new AssessmentAuthorityMissingError(
      "assessment",
      `Assessment ${assessmentId} not found in Postgres.`
    );
  }

  const attempt = await governanceStore.getAttempt(attemptId);
  if (!attempt) {
    throw new AssessmentAuthorityMissingError(
      "attempt",
      `Attempt ${attemptId} not found in Postgres.`
    );
  }

  if (attempt.assessmentId !== assessmentId) {
    throw new AssessmentAuthorityStateMismatchError(
      "attempt.assessmentId",
      assessmentId,
      attempt.assessmentId
    );
  }

  // -------------------------------------------------------------------------
  // 2. Load snapshots
  // -------------------------------------------------------------------------
  const profileSnapshot = await governanceStore.getProfileSnapshot(
    assessment.profileId,
    assessment.profileVersion
  );
  if (!profileSnapshot) {
    throw new AssessmentAuthorityMissingError(
      "profileSnapshot",
      `No snapshot for profile ${assessment.profileId}@${assessment.profileVersion}.`
    );
  }

  const policySnapshot = await governanceStore.getPolicySnapshot(
    assessment.policyId,
    assessment.policyVersion
  );
  if (!policySnapshot) {
    throw new AssessmentAuthorityMissingError(
      "policySnapshot",
      `No snapshot for policy ${assessment.policyId}@${assessment.policyVersion}.`
    );
  }

  const executionContractSnapshot = await governanceStore.getExecutionContractSnapshot(
    assessment.executionContractHash
  );
  if (!executionContractSnapshot) {
    throw new AssessmentAuthorityMissingError(
      "executionContractSnapshot",
      `No snapshot for executionContractHash ${assessment.executionContractHash}.`
    );
  }

  // -------------------------------------------------------------------------
  // 3. Verify profile digest
  //    The stored profileDigest must match the digest computed from the snapshot.
  // -------------------------------------------------------------------------
  const profileObject = JSON.parse(profileSnapshot.profileJson) as unknown;
  const recomputedProfileDigest = buildProfileDigest(profileObject as Parameters<typeof buildProfileDigest>[0]);
  if (recomputedProfileDigest !== assessment.profileDigest) {
    throw new AssessmentAuthorityStateMismatchError(
      "profileDigest",
      assessment.profileDigest,
      recomputedProfileDigest
    );
  }

  // -------------------------------------------------------------------------
  // 4. Verify policy digest
  //    Policy is stored as opaque JSON; its digest is sha256(canonicalJson(policy)).
  // -------------------------------------------------------------------------
  const policyObject = JSON.parse(policySnapshot.policyJson) as unknown;
  const recomputedPolicyDigest = sha256OfCanonicalJson(policyObject);
  if (recomputedPolicyDigest !== assessment.policyDigest) {
    throw new AssessmentAuthorityStateMismatchError(
      "policyDigest",
      assessment.policyDigest,
      recomputedPolicyDigest
    );
  }

  // -------------------------------------------------------------------------
  // 5. Verify execution contract hash
  //    The executionContractHash stored in the snapshot row must equal the
  //    hash referenced in the assessment.
  // -------------------------------------------------------------------------
  if (executionContractSnapshot.executionContractHash !== assessment.executionContractHash) {
    throw new AssessmentAuthorityStateMismatchError(
      "executionContractHash",
      assessment.executionContractHash,
      executionContractSnapshot.executionContractHash
    );
  }

  // -------------------------------------------------------------------------
  // 6. Verify assessmentInputHash
  //    Recompute from all four authority inputs and compare to stored value.
  // -------------------------------------------------------------------------
  const recomputedInputHash = buildAssessmentInputHash({
    subjectDigest: assessment.subjectDigest,
    profileDigest: assessment.profileDigest,
    policyDigest: assessment.policyDigest,
    executionContractHash: assessment.executionContractHash
  });
  if (recomputedInputHash !== assessment.assessmentInputHash) {
    throw new AssessmentAuthorityStateMismatchError(
      "assessmentInputHash",
      assessment.assessmentInputHash,
      recomputedInputHash
    );
  }

  return {
    assessment,
    attempt,
    profileSnapshot,
    policySnapshot,
    executionContractSnapshot
  };
}
