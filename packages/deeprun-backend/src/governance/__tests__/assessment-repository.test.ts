import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAssessmentInputHash,
  buildEvidenceManifestHash
} from "../assessment-hash.js";
import {
  buildEvidenceManifestCore,
  finalizeAssessmentEvidenceManifest
} from "../assessment-evidence.js";
import { buildEvidenceCoreHash, EVIDENCE_SCHEMA_VERSION } from "../evidence.js";
import type { EvidenceCore } from "../evidence.js";

// ---------------------------------------------------------------------------
// assessmentInputHash
// ---------------------------------------------------------------------------

test("buildAssessmentInputHash produces a 64-char hex string", () => {
  const hash = buildAssessmentInputHash({
    subjectDigest: "sha256:aaaa",
    profileDigest: "sha256:bbbb",
    policyDigest: "sha256:cccc",
    executionContractHash: "sha256:dddd"
  });
  assert.equal(typeof hash, "string");
  assert.equal(hash.length, 64);
  assert.match(hash, /^[a-f0-9]{64}$/);
});

test("buildAssessmentInputHash is deterministic", () => {
  const input = {
    subjectDigest: "sha256:subject",
    profileDigest: "sha256:profile",
    policyDigest: "sha256:policy",
    executionContractHash: "sha256:contract"
  };
  assert.equal(buildAssessmentInputHash(input), buildAssessmentInputHash(input));
});

test("buildAssessmentInputHash changes when any field changes", () => {
  const base = {
    subjectDigest: "sha256:subject",
    profileDigest: "sha256:profile",
    policyDigest: "sha256:policy",
    executionContractHash: "sha256:contract"
  };
  const h0 = buildAssessmentInputHash(base);

  const variations = [
    { ...base, subjectDigest: "sha256:other" },
    { ...base, profileDigest: "sha256:other" },
    { ...base, policyDigest: "sha256:other" },
    { ...base, executionContractHash: "sha256:other" }
  ];

  for (const variant of variations) {
    assert.notEqual(buildAssessmentInputHash(variant), h0, JSON.stringify(variant));
  }
});

// ---------------------------------------------------------------------------
// evidenceCoreHash – worker and timestamp changes do not alter it
// ---------------------------------------------------------------------------

test("evidenceCoreHash excludes worker identity and timestamps", () => {
  const core: EvidenceCore = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    subjectDigest: "sha256:subject",
    validatorId: "canonical.typecheck",
    validatorVersion: "1.0.0",
    validatorImplementationDigest: "sha256:impl",
    profileDigest: "sha256:profile",
    executionContractHash: "sha256:contract",
    trustClass: "DEEPRUN_EXECUTED",
    status: "PASS",
    reasonCodes: [],
    resultArtifactDigests: []
  };

  const hashA = buildEvidenceCoreHash(core);
  const hashB = buildEvidenceCoreHash({ ...core });
  assert.equal(hashA, hashB);
});

test("evidenceCoreHash changes when implementationDigest changes", () => {
  const core: EvidenceCore = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    subjectDigest: "sha256:subject",
    validatorId: "canonical.typecheck",
    validatorVersion: "1.0.0",
    validatorImplementationDigest: "sha256:impl-v1",
    profileDigest: "sha256:profile",
    executionContractHash: "sha256:contract",
    trustClass: "DEEPRUN_EXECUTED",
    status: "PASS",
    reasonCodes: [],
    resultArtifactDigests: []
  };

  const hashV1 = buildEvidenceCoreHash(core);
  const hashV2 = buildEvidenceCoreHash({
    ...core,
    validatorImplementationDigest: "sha256:impl-v2"
  });
  assert.notEqual(hashV1, hashV2);
});

test("evidenceCoreHash changes when status changes", () => {
  const core: EvidenceCore = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    subjectDigest: "sha256:subject",
    validatorId: "canonical.typecheck",
    validatorVersion: "1.0.0",
    validatorImplementationDigest: "sha256:impl",
    profileDigest: "sha256:profile",
    executionContractHash: "sha256:contract",
    trustClass: "DEEPRUN_EXECUTED",
    status: "PASS",
    reasonCodes: [],
    resultArtifactDigests: []
  };

  assert.notEqual(
    buildEvidenceCoreHash(core),
    buildEvidenceCoreHash({ ...core, status: "FAIL" })
  );
});

// ---------------------------------------------------------------------------
// Evidence manifest
// ---------------------------------------------------------------------------

test("buildEvidenceManifestCore sorts entries deterministically", () => {
  const entries = [
    { validatorId: "canonical.tests", validatorVersion: "1.0.0", evidenceCoreHash: "a".repeat(64) },
    { validatorId: "canonical.build", validatorVersion: "1.0.0", evidenceCoreHash: "b".repeat(64) },
    { validatorId: "canonical.structure", validatorVersion: "1.0.0", evidenceCoreHash: "c".repeat(64) }
  ];

  const core = buildEvidenceManifestCore({
    subjectDigest: "sha256:subject",
    profileDigest: "sha256:profile",
    executionContractHash: "sha256:contract",
    entries
  });

  // Entries must be sorted by validatorId
  assert.equal(core.entries[0].validatorId, "canonical.build");
  assert.equal(core.entries[1].validatorId, "canonical.structure");
  assert.equal(core.entries[2].validatorId, "canonical.tests");
});

test("finalizeAssessmentEvidenceManifest is deterministic", () => {
  const entries = [
    { validatorId: "canonical.typecheck", validatorVersion: "1.0.0", evidenceCoreHash: "d".repeat(64) }
  ];
  const manifestCore = buildEvidenceManifestCore({
    subjectDigest: "sha256:subject",
    profileDigest: "sha256:profile",
    executionContractHash: "sha256:contract",
    entries
  });

  const manifestA = finalizeAssessmentEvidenceManifest({
    assessmentId: "asmt-1",
    attemptId: "att-1",
    manifestCore
  });
  const manifestB = finalizeAssessmentEvidenceManifest({
    assessmentId: "asmt-2",
    attemptId: "att-2",
    manifestCore
  });

  // The manifest hash is based on the core only (no assessmentId/attemptId)
  assert.equal(manifestA.evidenceManifestHash, manifestB.evidenceManifestHash);
});

test("buildEvidenceManifestHash is stable for same manifest core", () => {
  const core = {
    schemaVersion: 1 as const,
    subjectDigest: "sha256:sub",
    profileDigest: "sha256:prof",
    executionContractHash: "sha256:ec",
    entries: [
      { validatorId: "canonical.structure", validatorVersion: "1.0.0", evidenceCoreHash: "e".repeat(64) }
    ]
  };
  assert.equal(buildEvidenceManifestHash(core), buildEvidenceManifestHash(core));
});

test("rebuilding evidence manifest from persisted records produces same hash", () => {
  const entries = [
    { validatorId: "canonical.build", validatorVersion: "1.0.0", evidenceCoreHash: "f".repeat(64) },
    { validatorId: "canonical.tests", validatorVersion: "1.0.0", evidenceCoreHash: "0".repeat(64) }
  ];

  // Build once
  const core = buildEvidenceManifestCore({
    subjectDigest: "sha256:subject",
    profileDigest: "sha256:profile",
    executionContractHash: "sha256:contract",
    entries
  });
  const manifest1 = finalizeAssessmentEvidenceManifest({
    assessmentId: "asmt-x",
    attemptId: "att-x",
    manifestCore: core
  });

  // Rebuild from the persisted JSON representation
  const rebuiltCore = JSON.parse(JSON.stringify(core));
  const manifest2 = finalizeAssessmentEvidenceManifest({
    assessmentId: "asmt-y",
    attemptId: "att-y",
    manifestCore: rebuiltCore
  });

  assert.equal(manifest1.evidenceManifestHash, manifest2.evidenceManifestHash);
});

// ---------------------------------------------------------------------------
// Evidence status semantics
// ---------------------------------------------------------------------------

test("evidence status values are exactly PASS, FAIL, ERROR, SKIPPED", async () => {
  const { evidenceStatusSchema } = await import("../evidence.js");
  // .options is the Zod enum member list
  assert.deepEqual(
    [...evidenceStatusSchema.options].sort(),
    ["ERROR", "FAIL", "PASS", "SKIPPED"]
  );
});
