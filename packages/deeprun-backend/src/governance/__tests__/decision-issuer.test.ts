import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildEvidenceManifestCore, finalizeAssessmentEvidenceManifest } from "../assessment-evidence.js";
import { buildAssessmentInputHash } from "../assessment-hash.js";
import { GovernanceDecisionIssuerImpl, DecisionIssuanceError } from "../decision-issuer.js";
import { buildEvidenceCoreHash, EVIDENCE_SCHEMA_VERSION, type EvidenceCore } from "../evidence.js";
import { buildProfileDigest, type ProfileDescriptor } from "../profiles.js";
import { GovernanceReasonCode } from "../reason-codes.js";
import type { GovernanceStore } from "../governance-store.js";
import type {
  AssessmentAttemptRecord,
  AssessmentEvidenceLink,
  AssessmentRecord,
  EvidenceCoreRecord,
  EvidenceManifestRecord,
  IssuedDecisionRecord,
  PersistIssuedDecisionInput,
  PersistedExecutionContractSnapshot,
  PersistedPolicySnapshot,
  PersistedProfileSnapshot
} from "../assessment-types.js";

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

function makeFixture(overrides?: {
  evidenceStatus?: EvidenceCore["status"];
  evidenceReasonCodes?: string[];
  trustClass?: EvidenceCore["trustClass"];
  subjectDigest?: string;
  manifestSubjectDigest?: string;
}): {
  store: GovernanceStore;
  assessment: AssessmentRecord;
  attempt: AssessmentAttemptRecord;
  issued: IssuedDecisionRecord[];
  evidenceCoreHash: string;
  manifestHash: string;
} {
  const now = "2026-06-27T00:00:00.000Z";
  const subjectDigest = overrides?.subjectDigest ?? `sha256:${"1".repeat(64)}`;
  const profile: ProfileDescriptor = {
    profileSchemaVersion: 1,
    id: "deeprun-baseline",
    version: "1.0.0",
    validatorSet: [{ id: "canonical.structure", version: "1.0.0" }]
  };
  const profileDigest = buildProfileDigest(profile);
  const policy = { policySchemaVersion: 1, id: "deeprun-baseline", version: "1.0.0" };
  const policyDigest = sha256Canonical(policy);
  const executionContractHash = `sha256:${"2".repeat(64)}`;
  const assessmentInputHash = buildAssessmentInputHash({
    subjectDigest,
    profileDigest,
    policyDigest,
    executionContractHash
  });

  const assessment: AssessmentRecord = {
    assessmentId: "asmt-issuer",
    organizationId: "org-issuer",
    artifactId: "art-issuer",
    subjectDigest,
    profileId: profile.id,
    profileVersion: profile.version,
    profileDigest,
    policyId: policy.id,
    policyVersion: policy.version,
    policyDigest,
    executionContractHash,
    assessmentInputHash,
    decisionHash: null,
    gateId: "gate-issuer",
    requestedBy: "tester",
    status: "DECIDING",
    createdAt: now,
    updatedAt: now
  };
  const attempt: AssessmentAttemptRecord = {
    attemptId: "att-selected",
    assessmentId: assessment.assessmentId,
    attemptNumber: 1,
    status: "COMPLETE",
    workerId: "worker",
    startedAt: now,
    completedAt: now,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now
  };
  const profileSnapshot: PersistedProfileSnapshot = {
    profileId: profile.id,
    profileVersion: profile.version,
    profileDigest,
    profileJson: JSON.stringify(profile)
  };
  const policySnapshot: PersistedPolicySnapshot = {
    policyId: policy.id,
    policyVersion: policy.version,
    policyDigest,
    policyJson: JSON.stringify(policy)
  };
  const executionContractSnapshot: PersistedExecutionContractSnapshot = {
    executionContractHash,
    contractJson: JSON.stringify({ executionContractHash, resourceLimits: { cpu: 1 } })
  };

  const evidenceCore: EvidenceCore = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    subjectDigest,
    validatorId: "canonical.structure",
    validatorVersion: "1.0.0",
    validatorImplementationDigest: `sha256:${"3".repeat(64)}`,
    profileDigest,
    executionContractHash,
    trustClass: overrides?.trustClass ?? "DEEPRUN_EXECUTED",
    status: overrides?.evidenceStatus ?? "PASS",
    reasonCodes: overrides?.evidenceReasonCodes ?? [],
    resultArtifactDigests: []
  };
  const evidenceCoreHash = buildEvidenceCoreHash(evidenceCore);
  const evidenceRecord: EvidenceCoreRecord = {
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
    reasonCodesJson: JSON.stringify(evidenceCore.reasonCodes),
    outputArtifactDigestsJson: JSON.stringify(evidenceCore.resultArtifactDigests),
    coreJson: JSON.stringify(evidenceCore),
    createdAt: now
  };

  const manifestCore = buildEvidenceManifestCore({
    subjectDigest: overrides?.manifestSubjectDigest ?? subjectDigest,
    profileDigest,
    executionContractHash,
    entries: [
      {
        validatorId: evidenceCore.validatorId,
        validatorVersion: evidenceCore.validatorVersion,
        evidenceCoreHash
      }
    ]
  });
  const manifest = finalizeAssessmentEvidenceManifest({
    assessmentId: assessment.assessmentId,
    attemptId: attempt.attemptId,
    manifestCore
  });
  const manifestRecord: EvidenceManifestRecord = {
    evidenceManifestId: "manifest-issuer",
    assessmentId: assessment.assessmentId,
    attemptId: attempt.attemptId,
    evidenceManifestHash: manifest.evidenceManifestHash,
    manifestJson: JSON.stringify(manifest),
    createdAt: now
  };
  const selectedLinks: AssessmentEvidenceLink[] = [
    {
      assessmentId: assessment.assessmentId,
      attemptId: attempt.attemptId,
      validatorId: evidenceCore.validatorId,
      evidenceCoreHash,
      evidenceEnvelopeId: "env-selected",
      selectedForDecision: true
    },
    {
      assessmentId: assessment.assessmentId,
      attemptId: "att-unselected",
      validatorId: "canonical.structure",
      evidenceCoreHash: "0".repeat(64),
      evidenceEnvelopeId: "env-unselected",
      selectedForDecision: false
    }
  ];
  const issued: IssuedDecisionRecord[] = [];

  const store = {
    getIssuedDecisionByAssessment: async () => issued[0] ?? null,
    getSelectedEvidenceLinks: async () => selectedLinks.filter((link) => link.selectedForDecision),
    getAssessment: async () => assessment,
    getAttempt: async (attemptId: string) => (attemptId === attempt.attemptId ? attempt : null),
    getProfileSnapshot: async () => profileSnapshot,
    getPolicySnapshot: async () => policySnapshot,
    getExecutionContractSnapshot: async () => executionContractSnapshot,
    getEvidenceManifestByAttempt: async () => manifestRecord,
    getEvidenceCore: async (hash: string) => (hash === evidenceCoreHash ? evidenceRecord : null),
    updateAssessmentStatus: async (_assessmentId: string, status: AssessmentRecord["status"]) => {
      assessment.status = status;
      return assessment;
    },
    persistIssuedDecisionAtomically: async (input: PersistIssuedDecisionInput) => {
      if (issued[0]) {
        if (issued[0].decisionHash !== input.decisionHash) {
          throw new Error("decision hash conflict");
        }
        return issued[0];
      }
      assessment.status = "COMPLETE";
      assessment.decisionHash = input.decisionHash;
      const record: IssuedDecisionRecord = {
        assessmentId: input.assessmentId,
        organizationId: assessment.organizationId,
        decisionHash: input.decisionHash,
        decisionCoreJson: input.decisionCoreJson,
        issuedDecisionJson: input.issuedDecisionJson,
        issuedAt: input.issuedAt,
        issuer: input.issuer,
        createdAt: input.issuedAt
      };
      issued.push(record);
      return record;
    }
  } as unknown as GovernanceStore;

  return {
    store,
    assessment,
    attempt,
    issued,
    evidenceCoreHash,
    manifestHash: manifest.evidenceManifestHash
  };
}

test("issuer creates a deterministic PASS decision from selected persisted evidence", async () => {
  const fixture = makeFixture();
  const issuer = new GovernanceDecisionIssuerImpl({
    governanceStore: fixture.store,
    now: () => "2026-06-27T01:00:00.000Z"
  });

  const issued = await issuer.issue({
    assessmentId: fixture.assessment.assessmentId,
    issuer: "deeprun-control-plane"
  });

  assert.equal(issued.decisionCore.decision, "PASS");
  assert.deepEqual(issued.decisionCore.reasonCodes, []);
  assert.equal(issued.decisionCore.evidenceManifestHash, fixture.manifestHash);
  assert.equal(fixture.assessment.status, "COMPLETE");
  assert.equal(fixture.assessment.decisionHash, issued.decisionHash);
});

test("different issuedAt and issuer values do not change decisionHash", async () => {
  const fixtureA = makeFixture();
  const fixtureB = makeFixture();
  const issuerA = new GovernanceDecisionIssuerImpl({
    governanceStore: fixtureA.store,
    now: () => "2026-06-27T01:00:00.000Z"
  });
  const issuerB = new GovernanceDecisionIssuerImpl({
    governanceStore: fixtureB.store,
    now: () => "2026-06-28T01:00:00.000Z"
  });

  const decisionA = await issuerA.issue({ assessmentId: "asmt-issuer", issuer: "issuer-a" });
  const decisionB = await issuerB.issue({ assessmentId: "asmt-issuer", issuer: "issuer-b" });

  assert.equal(decisionA.decisionHash, decisionB.decisionHash);
});

test("changing evidenceManifestHash changes decisionHash", async () => {
  const fixtureA = makeFixture();
  const fixtureB = makeFixture({
    evidenceReasonCodes: ["EXTRA_REASON"],
    evidenceStatus: "FAIL"
  });
  const issuerA = new GovernanceDecisionIssuerImpl({ governanceStore: fixtureA.store });
  const issuerB = new GovernanceDecisionIssuerImpl({ governanceStore: fixtureB.store });

  const decisionA = await issuerA.issue({ assessmentId: "asmt-issuer", issuer: "issuer" });
  const decisionB = await issuerB.issue({ assessmentId: "asmt-issuer", issuer: "issuer" });

  assert.notEqual(decisionA.decisionCore.evidenceManifestHash, decisionB.decisionCore.evidenceManifestHash);
  assert.notEqual(decisionA.decisionHash, decisionB.decisionHash);
});

test("required FAIL evidence creates a deterministic FAIL decision", async () => {
  const fixture = makeFixture({
    evidenceStatus: "FAIL",
    evidenceReasonCodes: ["STRUCTURE_INVALID"]
  });
  const issuer = new GovernanceDecisionIssuerImpl({ governanceStore: fixture.store });

  const decision = await issuer.issue({ assessmentId: "asmt-issuer", issuer: "issuer" });

  assert.equal(decision.decisionCore.decision, "FAIL");
  assert.deepEqual(decision.decisionCore.reasonCodes, [
    GovernanceReasonCode.REQUIRED_EVIDENCE_FAILED,
    "STRUCTURE_INVALID"
  ].sort());
});

test("required ERROR evidence produces no decision and marks assessment ERROR", async () => {
  const fixture = makeFixture({ evidenceStatus: "ERROR" });
  const issuer = new GovernanceDecisionIssuerImpl({ governanceStore: fixture.store });

  await assert.rejects(
    () => issuer.issue({ assessmentId: "asmt-issuer", issuer: "issuer" }),
    (error) =>
      error instanceof DecisionIssuanceError &&
      error.code === GovernanceReasonCode.REQUIRED_EVIDENCE_ERROR
  );

  assert.equal(fixture.issued.length, 0);
  assert.equal(fixture.assessment.status, "ERROR");
});

test("evidence bound to another subject is rejected", async () => {
  const fixture = makeFixture({
    subjectDigest: `sha256:${"1".repeat(64)}`,
    manifestSubjectDigest: `sha256:${"9".repeat(64)}`
  });
  const issuer = new GovernanceDecisionIssuerImpl({ governanceStore: fixture.store });

  await assert.rejects(
    () => issuer.issue({ assessmentId: "asmt-issuer", issuer: "issuer" }),
    (error) =>
      error instanceof DecisionIssuanceError &&
      error.code === GovernanceReasonCode.SUBJECT_BINDING_MISMATCH
  );
});

test("repeated issuance returns the existing persisted decision", async () => {
  const fixture = makeFixture();
  const issuer = new GovernanceDecisionIssuerImpl({ governanceStore: fixture.store });

  const first = await issuer.issue({ assessmentId: "asmt-issuer", issuer: "issuer-a" });
  fixture.assessment.status = "ERROR";
  const second = await issuer.issue({ assessmentId: "asmt-issuer", issuer: "issuer-b" });

  assert.equal(first.decisionHash, second.decisionHash);
  assert.equal(fixture.issued.length, 1);
});
