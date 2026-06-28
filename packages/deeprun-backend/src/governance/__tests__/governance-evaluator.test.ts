import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalArtifactBlobStore } from "../artifact-storage.js";
import { buildAssessmentInputHash } from "../assessment-hash.js";
import { EVIDENCE_SCHEMA_VERSION } from "../evidence.js";
import { GovernanceEvaluatorImpl } from "../governance-evaluator.js";
import { hashSourceTreeManifest, sha256Blob } from "../artifacts.js";
import { createNormalizedSourceTreeBundle } from "../normalized-bundle.js";
import { buildProfileDigest, type ProfileDescriptor } from "../profiles.js";
import type { GovernanceStore } from "../governance-store.js";
import type { ValidationProfileAdapter } from "../evaluator-types.js";
import type {
  AssessmentRecord,
  AssessmentAttemptRecord,
  CreateEvidenceManifestInput,
  PersistedExecutionContractSnapshot,
  PersistedPolicySnapshot,
  PersistedProfileSnapshot
} from "../assessment-types.js";
import type { ArtifactRecord, SourceTreeRecord } from "../artifact-repository.js";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

test("evaluator reloads persisted artifact metadata and materializes normalized bundle", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "deeprun-evaluator-"));

  try {
    const sourceRoot = path.join(tmpRoot, "source");
    await mkdir(path.join(sourceRoot, "src"), { recursive: true });
    await writeFile(path.join(sourceRoot, "package.json"), "{\"name\":\"demo\"}\n", "utf8");
    await writeFile(path.join(sourceRoot, "src", "server.ts"), "export const ok = true;\n", "utf8");

    const bundlePath = path.join(tmpRoot, "bundle.tar");
    const bundle = await createNormalizedSourceTreeBundle({
      sourceTreeRoot: sourceRoot,
      bundlePath
    });
    const bundleBlob = await sha256Blob(bundlePath);

    const blobStore = new LocalArtifactBlobStore(path.join(tmpRoot, "objects"));
    await blobStore.putIfAbsent(bundle.normalizedBundleDigest, bundlePath, {
      mediaType: "application/x-tar",
      sizeBytes: bundleBlob.size,
      kind: "normalized_bundle"
    });

    const subjectHash = hashSourceTreeManifest(bundle.manifest);
    const subjectDigest = `sha256:${subjectHash}`;
    const profile: ProfileDescriptor = {
      profileSchemaVersion: 1,
      id: "test-profile",
      version: "1.0.0",
      validatorSet: [{ id: "canonical.structure", version: "1.0.0" }]
    };
    const profileDigest = buildProfileDigest(profile);
    const policy = { policySchemaVersion: 1, id: "test-policy", version: "1.0.0" };
    const policyDigest = sha256Canonical(policy);
    const executionContractHash = "sha256:contract";
    const assessmentInputHash = buildAssessmentInputHash({
      subjectDigest,
      profileDigest,
      policyDigest,
      executionContractHash
    });

    const assessment: AssessmentRecord = {
      assessmentId: "asmt-001",
      organizationId: "org-001",
      artifactId: "art-001",
      subjectDigest,
      profileId: profile.id,
      profileVersion: profile.version,
      profileDigest,
      policyId: "test-policy",
      policyVersion: "1.0.0",
      policyDigest,
      executionContractHash,
      assessmentInputHash,
      gateId: "gate-001",
      requestedBy: "tester",
      status: "RUNNING",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const attempt: AssessmentAttemptRecord = {
      attemptId: "att-001",
      assessmentId: assessment.assessmentId,
      attemptNumber: 1,
      status: "QUEUED",
      workerId: null,
      startedAt: null,
      completedAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const artifact: ArtifactRecord = {
      artifactId: assessment.artifactId,
      organizationId: assessment.organizationId,
      blobDigest: { algorithm: "sha256", value: "0".repeat(64) },
      sourceTreeDigest: { algorithm: "sha256", value: subjectHash },
      createdBy: "tester",
      createdAt: new Date().toISOString()
    };
    const sourceTree: SourceTreeRecord = {
      sourceTreeDigest: artifact.sourceTreeDigest,
      manifestSchemaVersion: 1,
      manifest: bundle.manifest,
      manifestHash: subjectHash,
      normalizedBundleDigest: bundle.normalizedBundleDigest,
      fileCount: bundle.manifest.files.length,
      totalBytes: bundle.manifest.files.reduce((sum, file) => sum + file.size, 0),
      createdAt: new Date().toISOString()
    };
    const profileSnapshot: PersistedProfileSnapshot = {
      profileId: profile.id,
      profileVersion: profile.version,
      profileDigest,
      profileJson: JSON.stringify(profile)
    };
    const policySnapshot: PersistedPolicySnapshot = {
      policyId: "test-policy",
      policyVersion: "1.0.0",
      policyDigest,
      policyJson: JSON.stringify(policy)
    };
    const executionContractSnapshot: PersistedExecutionContractSnapshot = {
      executionContractHash,
      contractJson: JSON.stringify({ executionContractHash })
    };

    const persistedEvidence: string[] = [];
    const linkedValidators: string[] = [];
    let completedManifestHash: string | null = null;

    const store = {
      getAssessment: async () => assessment,
      getAttempt: async () => attempt,
      getProfileSnapshot: async () => profileSnapshot,
      getPolicySnapshot: async () => policySnapshot,
      getExecutionContractSnapshot: async () => executionContractSnapshot,
      updateAttemptStatus: async (_attemptId: string, status: AssessmentAttemptRecord["status"]) => {
        attempt.status = status;
        return attempt;
      },
      updateAssessmentStatus: async (_assessmentId: string, status: AssessmentRecord["status"]) => {
        assessment.status = status;
        return assessment;
      },
      getArtifactForOrganization: async () => artifact,
      getSourceTree: async () => sourceTree,
      failJob: async () => null,
      upsertEvidenceCore: async (input: { evidenceCoreHash: string; trustClass: string }) => {
        assert.equal(input.trustClass, "DEEPRUN_EXECUTED");
        persistedEvidence.push(input.evidenceCoreHash);
        return { ...input, createdAt: new Date().toISOString() };
      },
      persistEvidenceEnvelope: async (input: { evidenceEnvelopeId: string }) => ({
        ...input,
        createdAt: new Date().toISOString()
      }),
      linkEvidenceToAssessment: async (input: { validatorId: string }) => {
        linkedValidators.push(input.validatorId);
      },
      completeAttemptAtomically: async (input: {
        manifest: CreateEvidenceManifestInput;
        evidenceValidatorIds: string[];
      }) => {
        assert.deepEqual(input.evidenceValidatorIds, ["canonical.structure"]);
        assessment.status = "DECIDING";
        attempt.status = "COMPLETE";
        completedManifestHash = input.manifest.evidenceManifestHash;
        return {
          manifestRecord: {
            ...input.manifest,
            createdAt: new Date().toISOString()
          },
          assessmentRecord: assessment
        };
      }
    } as unknown as GovernanceStore;

    let adapterSawMaterializedPackage = false;
    const adapter: ValidationProfileAdapter = {
      profileId: profile.id,
      profileVersion: profile.version,
      implementationDigest: "sha256:adapter",
      evaluate: async ({ workspacePath, authority }) => {
        const packageJson = await readFile(path.join(workspacePath, "package.json"), "utf8");
        adapterSawMaterializedPackage = packageJson.includes("\"demo\"");
        assert.equal(authority.assessment.assessmentId, assessment.assessmentId);
        return [
          {
            evidenceCore: {
              schemaVersion: EVIDENCE_SCHEMA_VERSION,
              subjectDigest,
              validatorId: "canonical.structure",
              validatorVersion: "1.0.0",
              validatorImplementationDigest: "sha256:validator",
              profileDigest,
              executionContractHash,
              trustClass: "IMPORTED_UNVERIFIED",
              status: "PASS",
              reasonCodes: [],
              resultArtifactDigests: []
            },
            diagnostics: [],
            outputArtifacts: []
          }
        ];
      }
    };

    const evaluator = new GovernanceEvaluatorImpl({
      governanceStore: store,
      blobStore,
      adapters: new Map([[`${profile.id}@${profile.version}`, adapter]]),
      workspaceBaseDir: path.join(tmpRoot, "workspaces")
    });

    const outcome = await evaluator.evaluate({
      assessmentId: assessment.assessmentId,
      attemptId: attempt.attemptId,
      jobId: "job-001",
      workerId: "worker-001"
    });

    assert.equal(outcome.kind, "COMPLETE");
    assert.equal(adapterSawMaterializedPackage, true);
    assert.equal(persistedEvidence.length, 1);
    assert.deepEqual(linkedValidators, ["canonical.structure"]);
    assert.equal(assessment.status, "DECIDING");
    assert.equal(attempt.status, "COMPLETE");
    assert.equal(completedManifestHash, outcome.manifestHash);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});
