import { createHash } from "node:crypto";
import { z } from "zod";
import { GOVERNANCE_DECISION_SCHEMA_VERSION } from "./decision.js";

export const EVIDENCE_SCHEMA_VERSION = 1 as const;

export const evidenceSourceSchema = z.enum([
  "DEEPRUN_EXECUTED",
  "IMPORTED_VERIFIED",
  "IMPORTED_UNVERIFIED"
]);

export const evidenceStatusSchema = z.enum(["PASS", "FAIL", "ERROR", "SKIPPED"]);

export const evidenceArtifactReferenceSchema = z.object({
  kind: z.string().min(1),
  path: z.string().min(1),
  contentType: z.string().optional(),
  digest: z.string().min(1).optional()
});

export const evidenceRecordSchema = z.object({
  evidenceSchemaVersion: z.literal(EVIDENCE_SCHEMA_VERSION),
  subjectDigest: z.string().min(1),
  validator: z.object({
    id: z.string().min(1),
    version: z.string().min(1),
    implementationDigest: z.string().min(1).optional()
  }),
  executionEnvironment: z.object({
    imageDigest: z.string().min(1).optional(),
    toolchainDigest: z.string().min(1).optional(),
    workerIdentity: z.string().min(1).optional(),
    isolationClass: z.string().min(1)
  }),
  status: evidenceStatusSchema,
  reasonCodes: z.array(z.string().min(1)),
  startedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }),
  outputArtifacts: z.array(evidenceArtifactReferenceSchema),
  source: evidenceSourceSchema
});

export const evidenceCoreSchema = z.object({
  schemaVersion: z.literal(EVIDENCE_SCHEMA_VERSION),
  subjectDigest: z.string().min(1),
  validatorId: z.string().min(1),
  validatorVersion: z.string().min(1),
  validatorImplementationDigest: z.string().min(1),
  profileDigest: z.string().min(1),
  executionContractHash: z.string().min(1),
  trustClass: evidenceSourceSchema,
  status: evidenceStatusSchema,
  reasonCodes: z.array(z.string().min(1)),
  resultArtifactDigests: z.array(z.string().min(1))
});

export const evidenceEnvelopeSchema = z.object({
  evidenceCore: evidenceCoreSchema,
  evidenceCoreHash: z.string().length(64),
  attemptId: z.string().min(1),
  workerId: z.string().min(1).optional(),
  startedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }),
  logReferences: z.array(z.string().min(1))
});

export const evidenceManifestSchema = z.object({
  evidenceManifestSchemaVersion: z.literal(1),
  decisionSchemaVersion: z.literal(GOVERNANCE_DECISION_SCHEMA_VERSION),
  subjectDigest: z.string().min(1),
  records: z.array(evidenceRecordSchema),
  evidenceCoreHashes: z.array(z.string().length(64)).optional()
});

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

export function buildEvidenceCoreHash(evidenceCore: EvidenceCore): string {
  const parsed = evidenceCoreSchema.parse(evidenceCore);
  return createHash("sha256").update(canonicalJson(parsed)).digest("hex");
}

export function finalizeEvidenceEnvelope(input: Omit<EvidenceEnvelope, "evidenceCoreHash">): EvidenceEnvelope {
  const evidenceCore = evidenceCoreSchema.parse(input.evidenceCore);
  return evidenceEnvelopeSchema.parse({
    ...input,
    evidenceCore,
    evidenceCoreHash: buildEvidenceCoreHash(evidenceCore)
  });
}

export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;
export type EvidenceStatus = z.infer<typeof evidenceStatusSchema>;
export type EvidenceArtifactReference = z.infer<typeof evidenceArtifactReferenceSchema>;
export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;
export type EvidenceCore = z.infer<typeof evidenceCoreSchema>;
export type EvidenceEnvelope = z.infer<typeof evidenceEnvelopeSchema>;
export type EvidenceManifest = z.infer<typeof evidenceManifestSchema>;
