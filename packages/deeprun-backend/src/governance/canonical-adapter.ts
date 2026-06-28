import { createHash } from "node:crypto";
import type { ValidationProfileAdapter, ValidatorDescriptor } from "./evaluator-types.js";
import type { ValidatorEvidenceResult } from "./assessment-evidence.js";
import type { PersistedAssessmentAuthority } from "./assessment-types.js";
import { runHeavyProjectValidation } from "../agent/validation/heavy-validator.js";
import type { EvidenceCore, EvidenceStatus } from "./evidence.js";
import { EVIDENCE_SCHEMA_VERSION } from "./evidence.js";

// ---------------------------------------------------------------------------
// Canonical validator identifiers
//
// Each top-level check in HeavyValidationResult maps to one evidence record.
// Individual AST rule violations remain as reasonCodes within each record;
// they do not become separate evidence records.
// ---------------------------------------------------------------------------

interface CanonicalValidatorSpec {
  descriptor: ValidatorDescriptor;
  /**
   * The check IDs from HeavyValidationCheck that this validator aggregates.
   * If a check's status is "skip" the corresponding evidence status is SKIPPED.
   * If a check is not present in the result at all, evidence is SKIPPED with
   * reason code PREREQUISITE_CHECK_NOT_PRODUCED.
   */
  checkIds: string[];
}

/**
 * Compute a stable implementation digest from the declared validator ID and
 * version. In production this would be replaced by a digest of the actual
 * validator source, but a hash of the descriptor is stable and deterministic
 * for the first adapter slice.
 */
function descriptorDigest(id: string, version: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ id, version, adapterVersion: "1.0.0" }))
    .digest("hex");
}

const CANONICAL_VALIDATORS: CanonicalValidatorSpec[] = [
  {
    descriptor: {
      id: "canonical.structure",
      version: "1.0.0",
      implementationDigest: descriptorDigest("canonical.structure", "1.0.0")
    },
    checkIds: ["architecture", "production_config"]
  },
  {
    descriptor: {
      id: "canonical.dependencies",
      version: "1.0.0",
      implementationDigest: descriptorDigest("canonical.dependencies", "1.0.0")
    },
    checkIds: ["install"]
  },
  {
    descriptor: {
      id: "canonical.prisma",
      version: "1.0.0",
      implementationDigest: descriptorDigest("canonical.prisma", "1.0.0")
    },
    checkIds: ["migration", "seed"]
  },
  {
    descriptor: {
      id: "canonical.typecheck",
      version: "1.0.0",
      implementationDigest: descriptorDigest("canonical.typecheck", "1.0.0")
    },
    checkIds: ["typecheck"]
  },
  {
    descriptor: {
      id: "canonical.build",
      version: "1.0.0",
      implementationDigest: descriptorDigest("canonical.build", "1.0.0")
    },
    checkIds: ["build"]
  },
  {
    descriptor: {
      id: "canonical.tests",
      version: "1.0.0",
      implementationDigest: descriptorDigest("canonical.tests", "1.0.0")
    },
    checkIds: ["tests"]
  },
  {
    descriptor: {
      id: "canonical.runtime-health",
      version: "1.0.0",
      implementationDigest: descriptorDigest("canonical.runtime-health", "1.0.0")
    },
    checkIds: ["boot"]
  }
];

// Execution graph: each validator's prerequisites
// If any prerequisite produced a FAIL evidence, this validator is SKIPPED.
const PREREQUISITES: Record<string, string[]> = {
  "canonical.structure": [],
  "canonical.dependencies": ["canonical.structure"],
  "canonical.prisma": ["canonical.dependencies"],
  "canonical.typecheck": ["canonical.prisma"],
  "canonical.build": ["canonical.typecheck"],
  "canonical.tests": ["canonical.build"],
  "canonical.runtime-health": ["canonical.build"]
};

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export class CanonicalNodeFastifyPrismaAdapter implements ValidationProfileAdapter {
  readonly profileId = "node-fastify-prisma";
  readonly profileVersion = "1.0.0";
  readonly implementationDigest = descriptorDigest(
    "node-fastify-prisma-adapter",
    "1.0.0"
  );

  async evaluate(input: {
    workspacePath: string;
    authority: PersistedAssessmentAuthority;
    signal?: AbortSignal;
  }): Promise<ValidatorEvidenceResult[]> {
    const { workspacePath, authority } = input;
    const subjectDigest = authority.assessment.subjectDigest;
    const profileDigest = authority.assessment.profileDigest;
    const executionContractHash = authority.assessment.executionContractHash;

    // -----------------------------------------------------------------------
    // Run the existing heavy validator — this is the canonical execution path
    // -----------------------------------------------------------------------
    const heavyResult = await runHeavyProjectValidation({
      projectRoot: workspacePath,
      ref: null
    });

    // Index checks by ID for quick lookup
    const checksByIdMap = new Map(
      heavyResult.checks.map((c) => [c.id, c])
    );

    // -----------------------------------------------------------------------
    // Map heavy validator checks to normalized evidence records
    // -----------------------------------------------------------------------
    const results: ValidatorEvidenceResult[] = [];
    const evidenceStatusByValidatorId = new Map<string, EvidenceStatus>();

    for (const spec of CANONICAL_VALIDATORS) {
      if (input.signal?.aborted) {
        break;
      }

      const { descriptor, checkIds } = spec;

      // Check if any prerequisite has FAILED
      const prerequisites = PREREQUISITES[descriptor.id] ?? [];
      const failedPrereq = prerequisites.find(
        (prereqId) => evidenceStatusByValidatorId.get(prereqId) === "FAIL"
      );

      if (failedPrereq) {
        const skippedCore: EvidenceCore = {
          schemaVersion: EVIDENCE_SCHEMA_VERSION,
          subjectDigest,
          validatorId: descriptor.id,
          validatorVersion: descriptor.version,
          validatorImplementationDigest: descriptor.implementationDigest,
          profileDigest,
          executionContractHash,
          trustClass: "DEEPRUN_EXECUTED",
          status: "SKIPPED",
          reasonCodes: [`PREREQUISITE_FAILED:${failedPrereq}`],
          resultArtifactDigests: []
        };
        evidenceStatusByValidatorId.set(descriptor.id, "SKIPPED");
        results.push({
          evidenceCore: skippedCore,
          diagnostics: [
            {
              code: "PREREQUISITE_FAILED",
              message: `Validator ${descriptor.id} skipped because prerequisite ${failedPrereq} produced FAIL evidence.`,
              details: { prerequisite: failedPrereq }
            }
          ],
          outputArtifacts: []
        });
        continue;
      }

      // Aggregate all relevant checks for this validator
      let aggregateStatus: EvidenceStatus = "PASS";
      const reasonCodes: string[] = [];
      const diagnostics: ValidatorEvidenceResult["diagnostics"] = [];
      let allSkipped = true;

      for (const checkId of checkIds) {
        const check = checksByIdMap.get(checkId);

        if (!check) {
          // Check was not produced — treat as SKIPPED with explicit reason
          diagnostics.push({
            code: "CHECK_NOT_PRODUCED",
            message: `Expected check '${checkId}' was not produced by the heavy validator.`,
            details: { checkId }
          });
          if (aggregateStatus === "PASS") {
            aggregateStatus = "SKIPPED";
            reasonCodes.push("PREREQUISITE_CHECK_NOT_PRODUCED");
          }
          continue;
        }

        if (check.status !== "skip") {
          allSkipped = false;
        }

        if (check.status === "fail") {
          aggregateStatus = "FAIL";
          reasonCodes.push(`${checkId.toUpperCase()}_FAILED`);
          diagnostics.push({
            code: `${checkId.toUpperCase()}_FAILED`,
            message: check.message,
            details: check.details as Record<string, unknown> | undefined
          });
        } else if (check.status === "skip" && aggregateStatus === "PASS") {
          aggregateStatus = "SKIPPED";
          reasonCodes.push(`${checkId.toUpperCase()}_SKIPPED`);
          diagnostics.push({
            code: `${checkId.toUpperCase()}_SKIPPED`,
            message: check.message
          });
        }
      }

      // If every contributing check was skip, the whole record is SKIPPED
      if (allSkipped && checkIds.length > 0 && aggregateStatus !== "FAIL") {
        aggregateStatus = "SKIPPED";
      }

      const evidenceCore: EvidenceCore = {
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        subjectDigest,
        validatorId: descriptor.id,
        validatorVersion: descriptor.version,
        validatorImplementationDigest: descriptor.implementationDigest,
        profileDigest,
        executionContractHash,
        trustClass: "DEEPRUN_EXECUTED",
        status: aggregateStatus,
        reasonCodes: [...new Set(reasonCodes)],
        resultArtifactDigests: []
      };

      evidenceStatusByValidatorId.set(descriptor.id, aggregateStatus);
      results.push({ evidenceCore, diagnostics, outputArtifacts: [] });
    }

    return results;
  }
}
