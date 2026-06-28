import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildDecisionCoreHash,
  buildGovernanceDecisionHash,
  finalizeIssuedDecision,
  finalizeGovernanceDecision,
  GOVERNANCE_DECISION_SCHEMA_VERSION,
  issuedDecisionSchema,
  governanceDecisionSchema,
  persistGovernanceDecision
} from "../decision.js";

const zeroControlPlaneIdentityHash = "0000000000000000000000000000000000000000000000000000000000000000";

test("governance decision hash is stable for identical payloads", () => {
  const payload = {
    decisionSchemaVersion: GOVERNANCE_DECISION_SCHEMA_VERSION,
    decision: "PASS" as const,
    reasonCodes: [],
    reasons: [],
    runId: "11111111-1111-1111-1111-111111111111",
    contract: {
      schemaVersion: 1,
      hash: "abc123",
      determinismPolicyVersion: 1,
      normalizationPolicyVersion: 1,
      plannerPolicyVersion: 1,
      correctionRecipeVersion: 1,
      validationPolicyVersion: 1,
      governancePolicyVersion: 1,
      randomnessSeed: "forbidden:no-random-branching"
    },
    controlPlaneIdentityHash: zeroControlPlaneIdentityHash,
    artifactRefs: [
      {
        kind: "validation_target",
        path: "/tmp/project"
      }
    ]
  };

  assert.equal(buildGovernanceDecisionHash(payload), buildGovernanceDecisionHash({ ...payload }));
});

test("decision core hash excludes issued metadata", () => {
  const decisionCore = {
    decisionSchemaVersion: GOVERNANCE_DECISION_SCHEMA_VERSION,
    subject: {
      digest: "sha256:111"
    },
    profile: {
      id: "node-fastify-prisma",
      version: "1.0.0",
      digest: "sha256:222"
    },
    policy: {
      id: "deeprun-baseline",
      version: "1.0.0",
      digest: "sha256:333"
    },
    executionContractHash: "sha256:444",
    evidenceManifestHash: "sha256:555",
    controlPlaneIdentityHash: zeroControlPlaneIdentityHash,
    decision: "PASS" as const,
    reasonCodes: [],
    artifactReferences: []
  };

  const issuedA = finalizeIssuedDecision({
    decisionCore,
    issuedAt: "2026-06-26T00:00:00.000Z",
    issuer: "deeprun:test-a"
  });
  const issuedB = finalizeIssuedDecision({
    decisionCore,
    issuedAt: "2026-06-27T00:00:00.000Z",
    issuer: "deeprun:test-b"
  });

  assert.equal(issuedA.decisionHash, issuedB.decisionHash);
  assert.equal(issuedA.decisionHash, buildDecisionCoreHash(decisionCore));
  assert.equal(issuedDecisionSchema.parse(issuedA).decisionHash.length, 64);
});

test("decision core hash changes when authoritative reason codes change", () => {
  const baseCore = {
    decisionSchemaVersion: GOVERNANCE_DECISION_SCHEMA_VERSION,
    subject: {
      digest: "sha256:subject"
    },
    profile: {
      id: "node-fastify-prisma",
      version: "1.0.0",
      digest: "sha256:profile"
    },
    policy: {
      id: "deeprun-baseline",
      version: "1.0.0",
      digest: "sha256:policy"
    },
    executionContractHash: "sha256:contract",
    evidenceManifestHash: "sha256:evidence",
    controlPlaneIdentityHash: zeroControlPlaneIdentityHash,
    decision: "FAIL" as const,
    reasonCodes: ["RUN_VALIDATION_FAILED"],
    artifactReferences: []
  };

  assert.notEqual(
    buildDecisionCoreHash(baseCore),
    buildDecisionCoreHash({
      ...baseCore,
      reasonCodes: ["RUN_NOT_VALIDATED"]
    })
  );
});

test("governance decision payload is canonicalizable and includes decisionHash", () => {
  const decision = finalizeGovernanceDecision({
    decisionSchemaVersion: GOVERNANCE_DECISION_SCHEMA_VERSION,
    decision: "FAIL",
    reasonCodes: ["RUN_VALIDATION_FAILED"],
    reasons: [
      {
        code: "RUN_VALIDATION_FAILED",
        message: "validation failed"
      }
    ],
    runId: "22222222-2222-2222-2222-222222222222",
    contract: {
      schemaVersion: 1,
      hash: "def456",
      determinismPolicyVersion: 1,
      normalizationPolicyVersion: 1,
      plannerPolicyVersion: 1,
      correctionRecipeVersion: 1,
      validationPolicyVersion: 1,
      governancePolicyVersion: 1,
      randomnessSeed: "forbidden:no-random-branching"
    },
    controlPlaneIdentityHash: zeroControlPlaneIdentityHash,
    artifactRefs: []
  });

  const parsed = governanceDecisionSchema.parse(decision);
  assert.equal(parsed.decisionHash.length, 64);
  assert.equal(parsed.reasonCodes[0], "RUN_VALIDATION_FAILED");
});

test("persistGovernanceDecision writes content-addressed and latest decision files", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "deeprun-governance-decision-"));

  try {
    const decision = finalizeGovernanceDecision({
      decisionSchemaVersion: GOVERNANCE_DECISION_SCHEMA_VERSION,
      decision: "PASS",
      reasonCodes: [],
      reasons: [],
      runId: "33333333-3333-3333-3333-333333333333",
      contract: {
      schemaVersion: 1,
      hash: "ghi789",
      determinismPolicyVersion: 1,
      normalizationPolicyVersion: 1,
      plannerPolicyVersion: 1,
      correctionRecipeVersion: 1,
      validationPolicyVersion: 1,
      governancePolicyVersion: 1,
      randomnessSeed: "forbidden:no-random-branching"
    },
    controlPlaneIdentityHash: zeroControlPlaneIdentityHash,
    artifactRefs: []
  });

    const persisted = await persistGovernanceDecision({
      decision,
      rootDir: tmpRoot
    });

    const contentAddressed = JSON.parse(await readFile(persisted.decisionPath, "utf8")) as { decisionHash: string };
    const latest = JSON.parse(await readFile(persisted.latestPath, "utf8")) as { decisionHash: string };

    assert.equal(contentAddressed.decisionHash, decision.decisionHash);
    assert.equal(latest.decisionHash, decision.decisionHash);
    assert.equal(path.basename(persisted.decisionPath), `${decision.decisionHash}.json`);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});
