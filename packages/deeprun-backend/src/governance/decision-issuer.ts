import { createHash } from "node:crypto";
import {
  finalizeIssuedDecision,
  GOVERNANCE_DECISION_SCHEMA_VERSION,
  issuedDecisionSchema,
  type DecisionCore,
  type IssuedDecision
} from "./decision.js";
import { evidenceCoreSchema, type EvidenceCore } from "./evidence.js";
import { assessmentEvidenceManifestSchema } from "./assessment-evidence.js";
import { loadAndVerifyAssessmentAuthority } from "./authority-loader.js";
import { profileDescriptorSchema } from "./profiles.js";
import { GovernanceReasonCode, normalizeGovernanceReasonCodes } from "./reason-codes.js";
import type { GovernanceStore } from "./governance-store.js";
import type { EvidenceManifestRecord, IssuedDecisionRecord } from "./assessment-types.js";

export interface GovernanceDecisionIssuer {
  issue(input: {
    assessmentId: string;
    issuer: string;
  }): Promise<IssuedDecision>;
}

export class DecisionIssuanceError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

interface GovernanceDecisionIssuerOptions {
  governanceStore: GovernanceStore;
  now?: () => string;
}

export class GovernanceDecisionIssuerImpl implements GovernanceDecisionIssuer {
  private readonly governanceStore: GovernanceStore;
  private readonly now: () => string;

  constructor(options: GovernanceDecisionIssuerOptions) {
    this.governanceStore = options.governanceStore;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async issue(input: { assessmentId: string; issuer: string }): Promise<IssuedDecision> {
    const existing = await this.governanceStore.getIssuedDecisionByAssessment(input.assessmentId);
    if (existing) {
      return issuedDecisionFromRecord(existing);
    }

    try {
      const selectedLinks = await this.governanceStore.getSelectedEvidenceLinks(input.assessmentId);
      const selectedAttemptIds = Array.from(new Set(selectedLinks.map((link) => link.attemptId)));
      if (selectedAttemptIds.length !== 1) {
        throw new DecisionIssuanceError(
          GovernanceReasonCode.REQUIRED_EVIDENCE_MISSING,
          `Assessment ${input.assessmentId} must have exactly one selected evidence attempt.`
        );
      }

      const attemptId = selectedAttemptIds[0];
      const authority = await loadAndVerifyAssessmentAuthority(
        this.governanceStore,
        input.assessmentId,
        attemptId
      );

      if (authority.assessment.status !== "DECIDING") {
        throw new DecisionIssuanceError(
          GovernanceReasonCode.ASSESSMENT_NOT_COMPLETE,
          `Assessment ${input.assessmentId} must be DECIDING before decision issuance.`
        );
      }

      if (authority.attempt.status !== "COMPLETE") {
        throw new DecisionIssuanceError(
          GovernanceReasonCode.ASSESSMENT_NOT_COMPLETE,
          `Selected attempt ${attemptId} must be COMPLETE before decision issuance.`
        );
      }

      const manifestRecord = await this.governanceStore.getEvidenceManifestByAttempt(
        input.assessmentId,
        attemptId
      );
      if (!manifestRecord) {
        throw new DecisionIssuanceError(
          GovernanceReasonCode.REQUIRED_EVIDENCE_MISSING,
          `Assessment ${input.assessmentId} does not have a selected evidence manifest.`
        );
      }

      const manifest = verifyEvidenceManifest(manifestRecord, {
        assessmentId: input.assessmentId,
        attemptId,
        subjectDigest: authority.assessment.subjectDigest,
        profileDigest: authority.assessment.profileDigest,
        executionContractHash: authority.assessment.executionContractHash
      });

      const profile = profileDescriptorSchema.parse(
        JSON.parse(authority.profileSnapshot.profileJson)
      );
      const evidenceByValidator = await this.loadRequiredEvidence(
        manifest.manifestCore.entries,
        profile.validatorSet.map((validator) => validator.id)
      );

      const reasonCodes: string[] = [];
      for (const validator of profile.validatorSet) {
        const core = evidenceByValidator.get(validator.id);
        if (!core) {
          throw new DecisionIssuanceError(
            GovernanceReasonCode.REQUIRED_EVIDENCE_MISSING,
            `Required validator ${validator.id} is missing evidence.`
          );
        }

        verifyEvidenceCoreBinding(core, {
          subjectDigest: authority.assessment.subjectDigest,
          profileDigest: authority.assessment.profileDigest,
          executionContractHash: authority.assessment.executionContractHash
        });

        if (core.trustClass !== "DEEPRUN_EXECUTED") {
          throw new DecisionIssuanceError(
            GovernanceReasonCode.EVIDENCE_TRUST_INSUFFICIENT,
            `Required validator ${validator.id} has insufficient evidence trust.`
          );
        }

        if (core.status === "ERROR") {
          throw new DecisionIssuanceError(
            GovernanceReasonCode.REQUIRED_EVIDENCE_ERROR,
            `Required validator ${validator.id} produced ERROR evidence.`
          );
        }

        if (core.status === "FAIL") {
          reasonCodes.push(GovernanceReasonCode.REQUIRED_EVIDENCE_FAILED, ...core.reasonCodes);
        }

        if (core.status === "SKIPPED") {
          reasonCodes.push(GovernanceReasonCode.REQUIRED_EVIDENCE_SKIPPED, ...core.reasonCodes);
        }
      }

      const normalizedReasonCodes = normalizeGovernanceReasonCodes(reasonCodes);
      const decisionCore: DecisionCore = {
        decisionSchemaVersion: GOVERNANCE_DECISION_SCHEMA_VERSION,
        subject: {
          digest: authority.assessment.subjectDigest
        },
        profile: {
          id: authority.assessment.profileId,
          version: authority.assessment.profileVersion,
          digest: authority.assessment.profileDigest
        },
        policy: {
          id: authority.assessment.policyId,
          version: authority.assessment.policyVersion,
          digest: authority.assessment.policyDigest
        },
        executionContractHash: authority.assessment.executionContractHash,
        evidenceManifestHash: manifest.evidenceManifestHash,
        controlPlaneIdentityHash: buildControlPlaneIdentityHash(
          authority.executionContractSnapshot.contractJson
        ),
        decision: normalizedReasonCodes.length === 0 ? "PASS" : "FAIL",
        reasonCodes: normalizedReasonCodes,
        artifactReferences: []
      };

      const issued = finalizeIssuedDecision({
        decisionCore,
        issuedAt: this.now(),
        issuer: input.issuer
      });

      const persisted = await this.governanceStore.persistIssuedDecisionAtomically({
        assessmentId: input.assessmentId,
        decisionHash: issued.decisionHash,
        decisionCoreJson: JSON.stringify(issued.decisionCore),
        issuedDecisionJson: JSON.stringify(issued),
        issuedAt: issued.issuedAt,
        issuer: issued.issuer
      });

      if (persisted.decisionHash !== issued.decisionHash) {
        throw new DecisionIssuanceError(
          "DECISION_HASH_CONFLICT",
          `Persisted decision hash ${persisted.decisionHash} did not match recomputed hash ${issued.decisionHash}.`
        );
      }

      return issuedDecisionFromRecord(persisted);
    } catch (error) {
      if (error instanceof DecisionIssuanceError) {
        await this.governanceStore
          .updateAssessmentStatus(input.assessmentId, "ERROR", {
            errorCode: error.code,
            errorMessage: error.message
          })
          .catch(() => undefined);
      }
      throw error;
    }
  }

  private async loadRequiredEvidence(
    entries: Array<{ validatorId: string; evidenceCoreHash: string }>,
    requiredValidatorIds: string[]
  ): Promise<Map<string, EvidenceCore>> {
    const entriesByValidator = new Map(entries.map((entry) => [entry.validatorId, entry]));
    const evidenceByValidator = new Map<string, EvidenceCore>();

    for (const validatorId of requiredValidatorIds) {
      const entry = entriesByValidator.get(validatorId);
      if (!entry) {
        continue;
      }
      const record = await this.governanceStore.getEvidenceCore(entry.evidenceCoreHash);
      if (!record) {
        continue;
      }
      evidenceByValidator.set(
        validatorId,
        evidenceCoreSchema.parse(JSON.parse(record.coreJson))
      );
    }

    return evidenceByValidator;
  }
}

function issuedDecisionFromRecord(record: IssuedDecisionRecord): IssuedDecision {
  return issuedDecisionSchema.parse(JSON.parse(record.issuedDecisionJson));
}

function verifyEvidenceManifest(
  record: EvidenceManifestRecord,
  expected: {
    assessmentId: string;
    attemptId: string;
    subjectDigest: string;
    profileDigest: string;
    executionContractHash: string;
  }
) {
  const manifest = assessmentEvidenceManifestSchema.parse(JSON.parse(record.manifestJson));

  if (manifest.assessmentId !== expected.assessmentId || record.assessmentId !== expected.assessmentId) {
    throw new DecisionIssuanceError(
      GovernanceReasonCode.SUBJECT_BINDING_MISMATCH,
      "Evidence manifest assessment binding does not match."
    );
  }
  if (manifest.attemptId !== expected.attemptId || record.attemptId !== expected.attemptId) {
    throw new DecisionIssuanceError(
      GovernanceReasonCode.REQUIRED_EVIDENCE_MISSING,
      "Evidence manifest attempt binding does not match the selected attempt."
    );
  }
  if (manifest.evidenceManifestHash !== record.evidenceManifestHash) {
    throw new DecisionIssuanceError(
      GovernanceReasonCode.REQUIRED_EVIDENCE_MISSING,
      "Evidence manifest record hash does not match the persisted manifest body."
    );
  }
  if (manifest.manifestCore.subjectDigest !== expected.subjectDigest) {
    throw new DecisionIssuanceError(
      GovernanceReasonCode.SUBJECT_BINDING_MISMATCH,
      "Evidence manifest subject binding does not match the assessment subject."
    );
  }
  if (manifest.manifestCore.profileDigest !== expected.profileDigest) {
    throw new DecisionIssuanceError(
      GovernanceReasonCode.PROFILE_BINDING_MISMATCH,
      "Evidence manifest profile binding does not match the assessment profile."
    );
  }
  if (manifest.manifestCore.executionContractHash !== expected.executionContractHash) {
    throw new DecisionIssuanceError(
      GovernanceReasonCode.EXECUTION_CONTRACT_MISMATCH,
      "Evidence manifest execution contract binding does not match the assessment contract."
    );
  }

  return manifest;
}

function verifyEvidenceCoreBinding(
  core: EvidenceCore,
  expected: {
    subjectDigest: string;
    profileDigest: string;
    executionContractHash: string;
  }
): void {
  if (core.subjectDigest !== expected.subjectDigest) {
    throw new DecisionIssuanceError(
      GovernanceReasonCode.SUBJECT_BINDING_MISMATCH,
      "Evidence core subject binding does not match."
    );
  }
  if (core.profileDigest !== expected.profileDigest) {
    throw new DecisionIssuanceError(
      GovernanceReasonCode.PROFILE_BINDING_MISMATCH,
      "Evidence core profile binding does not match."
    );
  }
  if (core.executionContractHash !== expected.executionContractHash) {
    throw new DecisionIssuanceError(
      GovernanceReasonCode.EXECUTION_CONTRACT_MISMATCH,
      "Evidence core execution contract binding does not match."
    );
  }
}

function buildControlPlaneIdentityHash(contractJson: string): string {
  return createHash("sha256").update(contractJson).digest("hex");
}
