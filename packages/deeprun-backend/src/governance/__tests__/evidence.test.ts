import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEvidenceCoreHash,
  EVIDENCE_SCHEMA_VERSION,
  finalizeEvidenceEnvelope,
  evidenceManifestSchema,
  evidenceRecordSchema,
  evidenceSourceSchema
} from "../evidence.js";
import { GOVERNANCE_DECISION_SCHEMA_VERSION } from "../decision.js";

test("evidence source trust classes are explicit", () => {
  assert.deepEqual(evidenceSourceSchema.options, [
    "DEEPRUN_EXECUTED",
    "IMPORTED_VERIFIED",
    "IMPORTED_UNVERIFIED"
  ]);
});

test("evidence record binds validator, environment, source, and subject digest", () => {
  const record = evidenceRecordSchema.parse({
    evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION,
    subjectDigest: "sha256:subject",
    validator: {
      id: "node-fastify-prisma.structure",
      version: "1.0.0",
      implementationDigest: "sha256:validator"
    },
    executionEnvironment: {
      imageDigest: "sha256:image",
      workerIdentity: "worker-1",
      isolationClass: "container-hardened"
    },
    status: "PASS",
    reasonCodes: [],
    startedAt: "2026-06-26T00:00:00.000Z",
    completedAt: "2026-06-26T00:00:01.000Z",
    outputArtifacts: [],
    source: "DEEPRUN_EXECUTED"
  });

  assert.equal(record.subjectDigest, "sha256:subject");
  assert.equal(record.source, "DEEPRUN_EXECUTED");
});

test("evidence manifest binds records to the governance decision schema version", () => {
  const manifest = evidenceManifestSchema.parse({
    evidenceManifestSchemaVersion: 1,
    decisionSchemaVersion: GOVERNANCE_DECISION_SCHEMA_VERSION,
    subjectDigest: "sha256:subject",
    records: []
  });

  assert.equal(manifest.decisionSchemaVersion, 3);
  assert.equal(manifest.subjectDigest, "sha256:subject");
});

test("evidence core hash excludes operational envelope metadata", () => {
  const evidenceCore = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    subjectDigest: "sha256:subject",
    validatorId: "node-fastify-prisma.typecheck",
    validatorVersion: "1.0.0",
    validatorImplementationDigest: "sha256:validator",
    profileDigest: "sha256:profile",
    executionContractHash: "sha256:contract",
    trustClass: "DEEPRUN_EXECUTED" as const,
    status: "PASS" as const,
    reasonCodes: [],
    resultArtifactDigests: ["sha256:result"]
  };

  const envelopeA = finalizeEvidenceEnvelope({
    evidenceCore,
    attemptId: "attempt-a",
    workerId: "worker-a",
    startedAt: "2026-06-26T00:00:00.000Z",
    completedAt: "2026-06-26T00:00:01.000Z",
    logReferences: ["log-a"]
  });
  const envelopeB = finalizeEvidenceEnvelope({
    evidenceCore,
    attemptId: "attempt-b",
    workerId: "worker-b",
    startedAt: "2026-06-27T00:00:00.000Z",
    completedAt: "2026-06-27T00:00:01.000Z",
    logReferences: ["log-b"]
  });

  assert.equal(envelopeA.evidenceCoreHash, envelopeB.evidenceCoreHash);
  assert.equal(envelopeA.evidenceCoreHash, buildEvidenceCoreHash(evidenceCore));
});
