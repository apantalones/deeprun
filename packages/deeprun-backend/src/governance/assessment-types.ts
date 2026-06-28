/**
 * Persisted assessment authority types.
 *
 * These are the authoritative inputs that the governance evaluator reloads from
 * Postgres before any validation begins. The queue payload carries only IDs.
 */

export type AssessmentStatus =
  | "QUEUED"
  | "RUNNING"
  | "DECIDING"
  | "COMPLETE"
  | "ERROR"
  | "CANCELLED";

export type AssessmentAttemptStatus =
  | "QUEUED"
  | "RUNNING"
  | "COMPLETE"
  | "ERROR"
  | "CANCELLED";

export type GovernanceJobStatus =
  | "AVAILABLE"
  | "CLAIMED"
  | "RUNNING"
  | "COMPLETE"
  | "FAILED"
  | "CANCELLED";

export type GovernanceJobType = "GOVERNANCE_ASSESSMENT";

// ---------------------------------------------------------------------------
// Assessment record – persisted when POST /v1/assessments is called
// ---------------------------------------------------------------------------

export interface AssessmentRecord {
  assessmentId: string;
  organizationId: string;
  artifactId: string;
  /** sha256:<hex> */
  subjectDigest: string;
  profileId: string;
  profileVersion: string;
  profileDigest: string;
  policyId: string;
  policyVersion: string;
  policyDigest: string;
  executionContractHash: string;
  /** sha256 of canonical(subjectDigest, profileDigest, policyDigest, executionContractHash) */
  assessmentInputHash: string;
  decisionHash?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  gateId: string | null;
  requestedBy: string;
  status: AssessmentStatus;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Attempt record – one per execution attempt
// ---------------------------------------------------------------------------

export interface AssessmentAttemptRecord {
  attemptId: string;
  assessmentId: string;
  attemptNumber: number;
  status: AssessmentAttemptStatus;
  workerId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Governance job – the durable queue record
// ---------------------------------------------------------------------------

export interface GovernanceJobRecord {
  jobId: string;
  assessmentId: string;
  attemptId: string;
  jobType: GovernanceJobType;
  status: GovernanceJobStatus;
  workerId: string | null;
  claimedAt: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  leaseGeneration: number;
  claimCount: number;
  availableAt: string;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Persisted authority inputs – reloaded by the evaluator before validation
// ---------------------------------------------------------------------------

export interface PersistedProfileSnapshot {
  profileId: string;
  profileVersion: string;
  profileDigest: string;
  profileJson: string;
}

export interface PersistedPolicySnapshot {
  policyId: string;
  policyVersion: string;
  policyDigest: string;
  policyJson: string;
}

export interface PersistedExecutionContractSnapshot {
  executionContractHash: string;
  contractJson: string;
}

/**
 * The complete set of authority inputs the governance evaluator must reload
 * before any validation begins. Nothing from the queue payload is treated as
 * authoritative state.
 */
export interface PersistedAssessmentAuthority {
  assessment: AssessmentRecord;
  attempt: AssessmentAttemptRecord;
  profileSnapshot: PersistedProfileSnapshot;
  policySnapshot: PersistedPolicySnapshot;
  executionContractSnapshot: PersistedExecutionContractSnapshot;
}

// ---------------------------------------------------------------------------
// Evidence core / envelope / manifest – persisted after each validator run
// ---------------------------------------------------------------------------

export interface EvidenceCoreRecord {
  evidenceCoreHash: string;
  schemaVersion: number;
  subjectDigest: string;
  profileDigest: string;
  validatorId: string;
  validatorVersion: string;
  validatorImplementationDigest: string;
  executionContractHash: string;
  trustClass: string;
  status: string;
  reasonCodesJson: string;
  outputArtifactDigestsJson: string;
  coreJson: string;
  createdAt: string;
}

export interface EvidenceEnvelopeRecord {
  evidenceEnvelopeId: string;
  evidenceCoreHash: string;
  assessmentId: string;
  attemptId: string;
  workerId: string | null;
  startedAt: string;
  completedAt: string;
  diagnosticsJson: string;
  logArtifactRefsJson: string;
  envelopeJson: string;
  createdAt: string;
}

export interface AssessmentEvidenceLink {
  assessmentId: string;
  attemptId: string;
  validatorId: string;
  evidenceCoreHash: string;
  evidenceEnvelopeId: string;
  selectedForDecision: boolean;
}

export interface EvidenceManifestRecord {
  evidenceManifestId: string;
  assessmentId: string;
  attemptId: string;
  evidenceManifestHash: string;
  manifestJson: string;
  createdAt: string;
}

export interface IssuedDecisionRecord {
  assessmentId: string;
  organizationId: string;
  decisionHash: string;
  decisionCoreJson: string;
  issuedDecisionJson: string;
  issuedAt: string;
  issuer: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Create inputs
// ---------------------------------------------------------------------------

export interface CreateAssessmentInput {
  assessmentId: string;
  organizationId: string;
  artifactId: string;
  subjectDigest: string;
  profileId: string;
  profileVersion: string;
  profileDigest: string;
  policyId: string;
  policyVersion: string;
  policyDigest: string;
  executionContractHash: string;
  assessmentInputHash: string;
  gateId: string | null;
  requestedBy: string;
}

export interface CreateAssessmentAttemptInput {
  attemptId: string;
  assessmentId: string;
  attemptNumber: number;
}

export interface CreateGovernanceJobInput {
  jobId: string;
  assessmentId: string;
  attemptId: string;
  availableAt?: string;
}

export interface CreateAssessmentGraphInput {
  assessment: CreateAssessmentInput;
  attempt: CreateAssessmentAttemptInput;
  job: CreateGovernanceJobInput;
  profileSnapshot: PersistedProfileSnapshot;
  policySnapshot: PersistedPolicySnapshot;
  executionContractSnapshot: PersistedExecutionContractSnapshot;
}

export interface IdempotentCreateAssessmentGraphInput extends CreateAssessmentGraphInput {
  idempotency: {
    organizationId: string;
    idempotencyKey: string;
    requestFingerprint: string;
  };
}

export type IdempotentCreateAssessmentGraphResult =
  | {
      kind: "CREATED";
      assessment: AssessmentRecord;
    }
  | {
      kind: "REPLAYED";
      assessment: AssessmentRecord;
    }
  | {
      kind: "IN_PROGRESS";
      retryAfterSeconds: number;
    };

export interface PersistEvidenceCoreInput {
  evidenceCoreHash: string;
  schemaVersion: number;
  subjectDigest: string;
  profileDigest: string;
  validatorId: string;
  validatorVersion: string;
  validatorImplementationDigest: string;
  executionContractHash: string;
  trustClass: string;
  status: string;
  reasonCodes: string[];
  outputArtifactDigests: string[];
  coreJson: string;
}

export interface PersistEvidenceEnvelopeInput {
  evidenceEnvelopeId: string;
  evidenceCoreHash: string;
  assessmentId: string;
  attemptId: string;
  workerId: string | null;
  startedAt: string;
  completedAt: string;
  diagnostics: unknown[];
  logArtifactRefs: string[];
  envelopeJson: string;
}

export interface CreateEvidenceManifestInput {
  evidenceManifestId: string;
  assessmentId: string;
  attemptId: string;
  evidenceManifestHash: string;
  manifestJson: string;
}

export interface PersistIssuedDecisionInput {
  assessmentId: string;
  decisionHash: string;
  decisionCoreJson: string;
  issuedDecisionJson: string;
  issuedAt: string;
  issuer: string;
}
