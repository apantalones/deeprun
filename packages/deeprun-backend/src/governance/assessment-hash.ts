import { createHash } from "node:crypto";

/**
 * Deterministic canonical JSON serializer (key-sorted, no whitespace).
 * Used wherever we need a stable hash over a structured value.
 */
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
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(",")}}`;
}

/**
 * Compute the assessmentInputHash that binds all authority inputs together.
 *
 * The hash covers:
 *   - subjectDigest   (who/what is being assessed)
 *   - profileDigest   (which validators run)
 *   - policyDigest    (which rules apply)
 *   - executionContractHash  (under which execution terms)
 *
 * A mismatch between the stored hash and a recomputed one means authority
 * state was mutated after the assessment was created — a terminal error.
 */
export function buildAssessmentInputHash(input: {
  subjectDigest: string;
  profileDigest: string;
  policyDigest: string;
  executionContractHash: string;
}): string {
  const payload = {
    schemaVersion: 1,
    subjectDigest: input.subjectDigest,
    profileDigest: input.profileDigest,
    policyDigest: input.policyDigest,
    executionContractHash: input.executionContractHash
  };
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

/**
 * Compute the evidence manifest hash from a manifest core object.
 * The core excludes assessmentId/attemptId so the hash is portable across
 * executions with identical authority inputs and results.
 */
export function buildEvidenceManifestHash(manifestCore: unknown): string {
  return createHash("sha256").update(canonicalJson(manifestCore)).digest("hex");
}
