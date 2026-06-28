import { z } from "zod";
import { buildEvidenceManifestHash } from "./assessment-hash.js";
import type { EvidenceCore } from "./evidence.js";

// ---------------------------------------------------------------------------
// Evidence manifest types (new, for the evaluator milestone)
// ---------------------------------------------------------------------------

export const evidenceManifestEntrySchema = z.object({
  validatorId: z.string().min(1),
  validatorVersion: z.string().min(1),
  evidenceCoreHash: z.string().length(64)
});

export const evidenceManifestCoreSchema = z.object({
  schemaVersion: z.literal(1),
  subjectDigest: z.string().min(1),
  profileDigest: z.string().min(1),
  executionContractHash: z.string().min(1),
  entries: z.array(evidenceManifestEntrySchema)
});

export const assessmentEvidenceManifestSchema = z.object({
  assessmentId: z.string().min(1),
  attemptId: z.string().min(1),
  manifestCore: evidenceManifestCoreSchema,
  evidenceManifestHash: z.string().length(64),
  createdAt: z.string().datetime({ offset: true })
});

export type EvidenceManifestEntry = z.infer<typeof evidenceManifestEntrySchema>;
export type EvidenceManifestCore = z.infer<typeof evidenceManifestCoreSchema>;
export type AssessmentEvidenceManifest = z.infer<typeof assessmentEvidenceManifestSchema>;

// ---------------------------------------------------------------------------
// Evidence diagnostic (per-validator execution detail)
// ---------------------------------------------------------------------------

export const evidenceDiagnosticSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  details: z.record(z.unknown()).optional()
});

export type EvidenceDiagnostic = z.infer<typeof evidenceDiagnosticSchema>;

// ---------------------------------------------------------------------------
// Produced evidence artifact reference (output of a validator run)
// ---------------------------------------------------------------------------

export const producedEvidenceArtifactSchema = z.object({
  kind: z.string().min(1),
  digest: z.string().min(1),
  sizeBytes: z.number().int().min(0)
});

export type ProducedEvidenceArtifact = z.infer<typeof producedEvidenceArtifactSchema>;

// ---------------------------------------------------------------------------
// Validator evidence result – what a ValidationProfileAdapter returns
// ---------------------------------------------------------------------------

export interface ValidatorEvidenceResult {
  evidenceCore: EvidenceCore;
  diagnostics: EvidenceDiagnostic[];
  outputArtifacts: ProducedEvidenceArtifact[];
}

// ---------------------------------------------------------------------------
// Manifest builder
// ---------------------------------------------------------------------------

/**
 * Build a deterministic evidence manifest core from a list of validator results.
 *
 * Entries are sorted by (validatorId, validatorVersion, evidenceCoreHash) to
 * guarantee the same hash regardless of evaluation order.
 */
export function buildEvidenceManifestCore(input: {
  subjectDigest: string;
  profileDigest: string;
  executionContractHash: string;
  entries: EvidenceManifestEntry[];
}): EvidenceManifestCore {
  const sortedEntries = [...input.entries].sort((a, b) => {
    const idCmp = a.validatorId.localeCompare(b.validatorId);
    if (idCmp !== 0) return idCmp;
    const vCmp = a.validatorVersion.localeCompare(b.validatorVersion);
    if (vCmp !== 0) return vCmp;
    return a.evidenceCoreHash.localeCompare(b.evidenceCoreHash);
  });

  return evidenceManifestCoreSchema.parse({
    schemaVersion: 1,
    subjectDigest: input.subjectDigest,
    profileDigest: input.profileDigest,
    executionContractHash: input.executionContractHash,
    entries: sortedEntries
  });
}

/**
 * Finalize an AssessmentEvidenceManifest, computing the manifest hash from
 * the manifest core (which excludes assessmentId/attemptId for portability).
 */
export function finalizeAssessmentEvidenceManifest(input: {
  assessmentId: string;
  attemptId: string;
  manifestCore: EvidenceManifestCore;
}): AssessmentEvidenceManifest {
  const manifestCore = evidenceManifestCoreSchema.parse(input.manifestCore);
  const evidenceManifestHash = buildEvidenceManifestHash(manifestCore);

  return assessmentEvidenceManifestSchema.parse({
    assessmentId: input.assessmentId,
    attemptId: input.attemptId,
    manifestCore,
    evidenceManifestHash,
    createdAt: new Date().toISOString()
  });
}
