import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildEvidenceCoreHash, finalizeEvidenceEnvelope } from "./evidence.js";
import {
  buildEvidenceManifestCore,
  finalizeAssessmentEvidenceManifest
} from "./assessment-evidence.js";
import { materializeNormalizedSourceTreeBundle } from "./normalized-bundle.js";
import {
  buildSourceTreeManifest,
  hashSourceTreeManifest
} from "./artifacts.js";
import {
  loadAndVerifyAssessmentAuthority,
  AssessmentAuthorityStateMismatchError,
  AssessmentAuthorityMissingError
} from "./authority-loader.js";
import type { GovernanceStore } from "./governance-store.js";
import type { ArtifactBlobStore } from "./artifact-storage.js";
import type {
  GovernanceEvaluator,
  EvaluationOutcome,
  ValidationProfileAdapter
} from "./evaluator-types.js";
import type { EvidenceManifestEntry } from "./assessment-evidence.js";
import type { Digest } from "./artifacts.js";
import type { PersistedAssessmentAuthority } from "./assessment-types.js";
import { logError, logInfo, logWarn } from "../lib/logging.js";

interface GovernanceEvaluatorImplOptions {
  governanceStore: GovernanceStore;
  blobStore: ArtifactBlobStore;
  adapters: Map<string, ValidationProfileAdapter>;
  workspaceBaseDir?: string;
  leaseDurationSeconds?: number;
}

/**
 * GovernanceEvaluatorImpl
 *
 * Implements GovernanceEvaluator. Does NOT claim jobs — that is the job
 * worker's responsibility. This class receives an already-claimed job's
 * identifiers and performs the full evaluate-persist-complete cycle.
 */
export class GovernanceEvaluatorImpl implements GovernanceEvaluator {
  private readonly governanceStore: GovernanceStore;
  private readonly blobStore: ArtifactBlobStore;
  private readonly adapters: Map<string, ValidationProfileAdapter>;
  private readonly workspaceBaseDir: string;

  constructor(options: GovernanceEvaluatorImplOptions) {
    this.governanceStore = options.governanceStore;
    this.blobStore = options.blobStore;
    this.adapters = options.adapters;
    this.workspaceBaseDir =
      options.workspaceBaseDir ?? path.join(os.tmpdir(), "deeprun-governance-workspaces");
  }

  async evaluate(input: {
    assessmentId: string;
    attemptId: string;
    jobId: string;
    workerId: string;
    leaseGeneration?: number;
    signal?: AbortSignal;
  }): Promise<EvaluationOutcome> {
    const { assessmentId, attemptId, jobId, workerId, leaseGeneration, signal } = input;
    const workspacePath = path.join(
      this.workspaceBaseDir,
      `${assessmentId}-${attemptId}-${Date.now()}`
    );

    try {
      // -------------------------------------------------------------------
      // 1. Reload and verify all authority inputs from Postgres
      // -------------------------------------------------------------------
      if (signal?.aborted) return { kind: "CANCELLED" };

      const authority = await loadAndVerifyAssessmentAuthority(
        this.governanceStore,
        assessmentId,
        attemptId
      );

      // -------------------------------------------------------------------
      // 2. Mark attempt RUNNING (assessment was already moved to RUNNING by
      //    the job worker when it claimed the job)
      // -------------------------------------------------------------------
      await this.governanceStore.updateAttemptStatus(attemptId, "RUNNING", {
        workerId
      });

      // -------------------------------------------------------------------
      // 3. Resolve and resolve the adapter for this profile
      // -------------------------------------------------------------------
      const adapterKey = `${authority.assessment.profileId}@${authority.assessment.profileVersion}`;
      const adapter = this.adapters.get(adapterKey);

      if (!adapter) {
        const errMsg = `No adapter registered for profile ${adapterKey}`;
        logWarn("governance.evaluator.no_adapter", { assessmentId, attemptId, adapterKey });
        await this.markAttemptError(attemptId, "UNSUPPORTED_PROFILE_SNAPSHOT", errMsg);
        await this.governanceStore.failJob(jobId, workerId, {
          code: "UNSUPPORTED_PROFILE_SNAPSHOT",
          message: errMsg
        }, undefined, leaseGeneration);
        await this.governanceStore.updateAssessmentStatus(assessmentId, "ERROR");
        return {
          kind: "AUTHORITY_ERROR",
          errorCode: "UNSUPPORTED_PROFILE_SNAPSHOT",
          errorMessage: errMsg
        };
      }

      // -------------------------------------------------------------------
      // 4. Materialize the normalized bundle into an isolated workspace
      // -------------------------------------------------------------------
      if (signal?.aborted) return this.handleCancellation(assessmentId, attemptId, jobId, workerId, workspacePath, leaseGeneration);

      await mkdir(workspacePath, { recursive: true });

      const normalizedBundleDigest = await this.resolveNormalizedBundleDigest(authority);

      if (!normalizedBundleDigest) {
        const errMsg = `Normalized bundle not found for artifact ${authority.assessment.artifactId}`;
        await this.markAttemptError(attemptId, "MISSING_NORMALIZED_BUNDLE", errMsg);
        await this.governanceStore.failJob(jobId, workerId, {
          code: "MISSING_NORMALIZED_BUNDLE",
          message: errMsg
        }, undefined, leaseGeneration);
        await this.governanceStore.updateAssessmentStatus(assessmentId, "ERROR");
        await this.cleanupWorkspace(workspacePath);
        return {
          kind: "AUTHORITY_ERROR",
          errorCode: "MISSING_NORMALIZED_BUNDLE",
          errorMessage: errMsg
        };
      }

      // Stream blob to a temp file and materialize
      const bundleTempPath = path.join(
        this.workspaceBaseDir,
        `bundle-${attemptId}-${Date.now()}.tar`
      );
      try {
        await this.streamBlobToFile(normalizedBundleDigest, bundleTempPath);
        await materializeNormalizedSourceTreeBundle({
          bundlePath: bundleTempPath,
          targetDir: workspacePath
        });
      } finally {
        await rm(bundleTempPath, { force: true });
      }

      // -------------------------------------------------------------------
      // 5. Rebuild manifest and verify sourceTreeDigest
      // -------------------------------------------------------------------
      if (signal?.aborted) return this.handleCancellation(assessmentId, attemptId, jobId, workerId, workspacePath, leaseGeneration);

      const rebuiltManifest = await buildSourceTreeManifest(workspacePath);
      const rebuiltHash = hashSourceTreeManifest(rebuiltManifest.manifest);
      const storedSourceTreeDigest = authority.assessment.subjectDigest;
      // subjectDigest is "sha256:<manifestHash>"
      const storedHash = storedSourceTreeDigest.startsWith("sha256:")
        ? storedSourceTreeDigest.slice(7)
        : storedSourceTreeDigest;

      if (rebuiltHash !== storedHash) {
        const errMsg = `Source tree digest mismatch after materialization: expected ${storedHash}, got ${rebuiltHash}`;
        logError("governance.evaluator.source_tree_mismatch", { assessmentId, attemptId, rebuiltHash, storedHash });
        await this.markAttemptError(attemptId, "SOURCE_TREE_DIGEST_MISMATCH", errMsg);
        await this.governanceStore.failJob(jobId, workerId, {
          code: "SOURCE_TREE_DIGEST_MISMATCH",
          message: errMsg
        }, undefined, leaseGeneration);
        await this.governanceStore.updateAssessmentStatus(assessmentId, "ERROR");
        await this.cleanupWorkspace(workspacePath);
        return {
          kind: "AUTHORITY_ERROR",
          errorCode: "SOURCE_TREE_DIGEST_MISMATCH",
          errorMessage: errMsg
        };
      }

      // -------------------------------------------------------------------
      // 6. Run the profile adapter
      // -------------------------------------------------------------------
      if (signal?.aborted) return this.handleCancellation(assessmentId, attemptId, jobId, workerId, workspacePath, leaseGeneration);

      const validatorResults = await adapter.evaluate({
        workspacePath,
        authority,
        signal
      });

      // -------------------------------------------------------------------
      // 7. Persist evidence for each validator result (one by one, so
      //    already-persisted evidence survives a worker crash)
      // -------------------------------------------------------------------
      const manifestEntries: EvidenceManifestEntry[] = [];

      for (const result of validatorResults) {
        if (signal?.aborted) {
          return this.handleCancellation(assessmentId, attemptId, jobId, workerId, workspacePath, leaseGeneration);
        }

        // The governance evaluator assigns trust class — never the adapter
        const coreWithTrust = {
          ...result.evidenceCore,
          trustClass: "DEEPRUN_EXECUTED" as const
        };

        const evidenceCoreHash = buildEvidenceCoreHash(coreWithTrust);

        // Persist core (idempotent on hash)
        await this.governanceStore.upsertEvidenceCore({
          evidenceCoreHash,
          schemaVersion: coreWithTrust.schemaVersion,
          subjectDigest: coreWithTrust.subjectDigest,
          profileDigest: coreWithTrust.profileDigest,
          validatorId: coreWithTrust.validatorId,
          validatorVersion: coreWithTrust.validatorVersion,
          validatorImplementationDigest: coreWithTrust.validatorImplementationDigest,
          executionContractHash: coreWithTrust.executionContractHash,
          trustClass: coreWithTrust.trustClass,
          status: coreWithTrust.status,
          reasonCodes: [...coreWithTrust.reasonCodes],
          outputArtifactDigests: [...coreWithTrust.resultArtifactDigests],
          coreJson: JSON.stringify(coreWithTrust)
        });

        // Build and persist envelope (unique per execution)
        const evidenceEnvelopeId = randomUUID();
        const now = new Date().toISOString();
        const envelope = finalizeEvidenceEnvelope({
          evidenceCore: coreWithTrust,
          attemptId,
          workerId,
          startedAt: now,
          completedAt: now,
          logReferences: result.outputArtifacts.map((a) => a.digest)
        });

        await this.governanceStore.persistEvidenceEnvelope({
          evidenceEnvelopeId,
          evidenceCoreHash,
          assessmentId,
          attemptId,
          workerId,
          startedAt: envelope.startedAt,
          completedAt: envelope.completedAt,
          diagnostics: result.diagnostics,
          logArtifactRefs: result.outputArtifacts.map((a) => a.digest),
          envelopeJson: JSON.stringify(envelope)
        });

        // Link evidence to assessment
        await this.governanceStore.linkEvidenceToAssessment({
          assessmentId,
          attemptId,
          validatorId: coreWithTrust.validatorId,
          evidenceCoreHash,
          evidenceEnvelopeId
        });

        manifestEntries.push({
          validatorId: coreWithTrust.validatorId,
          validatorVersion: coreWithTrust.validatorVersion,
          evidenceCoreHash
        });
      }

      // -------------------------------------------------------------------
      // 8. Build evidence manifest
      // -------------------------------------------------------------------
      if (signal?.aborted) {
        return this.handleCancellation(assessmentId, attemptId, jobId, workerId, workspacePath, leaseGeneration);
      }

      const manifestCore = buildEvidenceManifestCore({
        subjectDigest: authority.assessment.subjectDigest,
        profileDigest: authority.assessment.profileDigest,
        executionContractHash: authority.assessment.executionContractHash,
        entries: manifestEntries
      });

      const manifest = finalizeAssessmentEvidenceManifest({
        assessmentId,
        attemptId,
        manifestCore
      });

      // -------------------------------------------------------------------
      // 9. Atomic completion transaction:
      //    mark evidence selected, persist manifest, COMPLETE attempt,
      //    COMPLETE job, move assessment to DECIDING
      // -------------------------------------------------------------------
      const { manifestRecord } = await this.governanceStore.completeAttemptAtomically({
        assessmentId,
        attemptId,
        jobId,
        workerId,
        leaseGeneration,
        manifest: {
          evidenceManifestId: randomUUID(),
          assessmentId,
          attemptId,
          evidenceManifestHash: manifest.evidenceManifestHash,
          manifestJson: JSON.stringify(manifest)
        },
        evidenceValidatorIds: manifestEntries.map((e) => e.validatorId)
      });

      // -------------------------------------------------------------------
      // 10. Cleanup workspace
      // -------------------------------------------------------------------
      await this.cleanupWorkspace(workspacePath);

      logInfo("governance.evaluator.complete", {
        assessmentId,
        attemptId,
        manifestHash: manifestRecord.evidenceManifestHash
      });

      return { kind: "COMPLETE", manifestHash: manifestRecord.evidenceManifestHash };
    } catch (error) {
      // -------------------------------------------------------------------
      // Handle authority state mismatch errors — non-retryable
      // -------------------------------------------------------------------
      if (
        error instanceof AssessmentAuthorityStateMismatchError ||
        error instanceof AssessmentAuthorityMissingError
      ) {
        const errMsg = error.message;
        logError("governance.evaluator.authority_mismatch", {
          assessmentId,
          attemptId,
          error: errMsg
        });
        await this.markAttemptError(attemptId, "ASSESSMENT_AUTHORITY_STATE_MISMATCH", errMsg).catch(
          () => undefined
        );
        await this.governanceStore
          .failJob(jobId, workerId, {
            code: "ASSESSMENT_AUTHORITY_STATE_MISMATCH",
            message: errMsg
          }, undefined, leaseGeneration)
          .catch(() => undefined);
        await this.governanceStore.updateAssessmentStatus(assessmentId, "ERROR").catch(() => undefined);
        await this.cleanupWorkspace(workspacePath);

        return {
          kind: "AUTHORITY_ERROR",
          errorCode: "ASSESSMENT_AUTHORITY_STATE_MISMATCH",
          errorMessage: errMsg
        };
      }

      // -------------------------------------------------------------------
      // Infrastructure errors — retryable
      // -------------------------------------------------------------------
      const errMsg = error instanceof Error ? error.message : String(error);
      logError("governance.evaluator.infrastructure_error", {
        assessmentId,
        attemptId,
        error: errMsg
      });
      await this.markAttemptError(attemptId, "INFRASTRUCTURE_ERROR", errMsg).catch(() => undefined);
      await this.cleanupWorkspace(workspacePath);

      return {
        kind: "INFRASTRUCTURE_ERROR",
        errorCode: "INFRASTRUCTURE_ERROR",
        errorMessage: errMsg,
        retryable: true
      };
    }
  }

  private async handleCancellation(
    assessmentId: string,
    attemptId: string,
    jobId: string,
    workerId: string,
    workspacePath: string,
    leaseGeneration?: number
  ): Promise<EvaluationOutcome> {
    logInfo("governance.evaluator.cancelled", { assessmentId, attemptId });
    await this.governanceStore
      .updateAttemptStatus(attemptId, "CANCELLED")
      .catch(() => undefined);
    await this.governanceStore
      .cancelJob(jobId, workerId, leaseGeneration)
      .catch(() => undefined);
    await this.governanceStore
      .updateAssessmentStatus(assessmentId, "CANCELLED")
      .catch(() => undefined);
    await this.cleanupWorkspace(workspacePath);
    return { kind: "CANCELLED" };
  }

  private async markAttemptError(
    attemptId: string,
    errorCode: string,
    errorMessage: string
  ): Promise<void> {
    await this.governanceStore.updateAttemptStatus(attemptId, "ERROR", {
      errorCode,
      errorMessage
    });
  }

  private async resolveNormalizedBundleDigest(
    authority: PersistedAssessmentAuthority
  ): Promise<Digest | null> {
    const artifact = await this.governanceStore.getArtifactForOrganization(
      authority.assessment.artifactId,
      authority.assessment.organizationId
    );

    if (!artifact) {
      throw new AssessmentAuthorityMissingError(
        "artifact",
        `Artifact ${authority.assessment.artifactId} was not found for organization ${authority.assessment.organizationId}.`
      );
    }

    const expectedSubjectDigest = formatDigest(artifact.sourceTreeDigest);
    if (expectedSubjectDigest !== authority.assessment.subjectDigest) {
      throw new AssessmentAuthorityStateMismatchError(
        "artifact.sourceTreeDigest",
        authority.assessment.subjectDigest,
        expectedSubjectDigest
      );
    }

    const sourceTree = await this.governanceStore.getSourceTree(artifact.sourceTreeDigest);
    if (!sourceTree) {
      throw new AssessmentAuthorityMissingError(
        "sourceTree",
        `Source tree ${expectedSubjectDigest} was not found for artifact ${artifact.artifactId}.`
      );
    }

    const storedManifestDigest = formatDigest({
      algorithm: "sha256",
      value: sourceTree.manifestHash
    });
    if (storedManifestDigest !== authority.assessment.subjectDigest) {
      throw new AssessmentAuthorityStateMismatchError(
        "sourceTree.manifestHash",
        authority.assessment.subjectDigest,
        storedManifestDigest
      );
    }

    if (!(await this.blobStore.exists(sourceTree.normalizedBundleDigest))) {
      return null;
    }

    return sourceTree.normalizedBundleDigest;
  }

  private async streamBlobToFile(
    digest: { algorithm: "sha256"; value: string },
    targetPath: string
  ): Promise<void> {
    const { createWriteStream } = await import("node:fs");
    const readable = await this.blobStore.open(digest);
    const writable = createWriteStream(targetPath);
    await new Promise<void>((resolve, reject) => {
      readable.pipe(writable);
      writable.on("finish", resolve);
      writable.on("error", reject);
      readable.on("error", reject);
    });
  }

  private async cleanupWorkspace(workspacePath: string): Promise<void> {
    try {
      await rm(workspacePath, { recursive: true, force: true });
    } catch (error) {
      // Cleanup failure is logged but does not affect the completed result
      logWarn("governance.evaluator.workspace_cleanup_failed", {
        workspacePath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

function formatDigest(digest: Digest): string {
  return `${digest.algorithm}:${digest.value}`;
}
