import type { EvidenceCore } from "./evidence.js";
import type { ValidatorEvidenceResult } from "./assessment-evidence.js";
import type { PersistedAssessmentAuthority } from "./assessment-types.js";

// ---------------------------------------------------------------------------
// Evaluation outcome
// ---------------------------------------------------------------------------

export type EvaluationOutcome =
  | { kind: "COMPLETE"; manifestHash: string }
  | { kind: "CANCELLED" }
  | { kind: "AUTHORITY_ERROR"; errorCode: string; errorMessage: string }
  | { kind: "INFRASTRUCTURE_ERROR"; errorCode: string; errorMessage: string; retryable: boolean };

// ---------------------------------------------------------------------------
// GovernanceEvaluator
//
// Responsible for:
//   - reloading persisted assessment inputs from Postgres
//   - verifying all authority digests
//   - materializing the governed artifact
//   - verifying sourceTreeDigest
//   - invoking the profile adapter
//   - persisting evidence
//   - completing the attempt atomically
//
// Does NOT claim queue jobs or construct HTTP responses.
// ---------------------------------------------------------------------------

export interface GovernanceEvaluator {
  evaluate(input: {
    assessmentId: string;
    attemptId: string;
    jobId: string;
    workerId: string;
    leaseGeneration?: number;
    signal?: AbortSignal;
  }): Promise<EvaluationOutcome>;
}

// ---------------------------------------------------------------------------
// ValidationProfileAdapter
//
// Responsible for:
//   - executing the validators defined by the profile
//   - translating validator output into normalized ValidatorEvidenceResult[]
//   - returning structured results rather than directly issuing decisions
//
// Does NOT assign trust classes (the evaluator does that).
// Does NOT claim jobs or persist evidence.
// ---------------------------------------------------------------------------

export interface ValidationProfileAdapter {
  readonly profileId: string;
  readonly profileVersion: string;
  readonly implementationDigest: string;

  evaluate(input: {
    workspacePath: string;
    authority: PersistedAssessmentAuthority;
    signal?: AbortSignal;
  }): Promise<ValidatorEvidenceResult[]>;
}

// ---------------------------------------------------------------------------
// EvidenceCore helpers for the adapter layer
// ---------------------------------------------------------------------------

/**
 * Stable validator descriptor attached to each evidence core.
 * The implementationDigest changes when the validator logic changes,
 * which is reflected in a different evidenceCoreHash.
 */
export interface ValidatorDescriptor {
  id: string;
  version: string;
  implementationDigest: string;
}
