# Evidence Contract

Evidence is persisted, normalized validation output. It is not the same thing as a governance decision: evidence records describe what validators observed, while decisions decide whether those observations satisfy a policy.

## Schema

Current evidence schema version: `1`

```ts
interface EvidenceRecord {
  evidenceSchemaVersion: 1;
  subjectDigest: string;
  validator: {
    id: string;
    version: string;
    implementationDigest?: string;
  };
  executionEnvironment: {
    imageDigest?: string;
    toolchainDigest?: string;
    workerIdentity?: string;
    isolationClass: string;
  };
  status: "PASS" | "FAIL" | "ERROR" | "SKIPPED";
  reasonCodes: string[];
  startedAt: string;
  completedAt: string;
  outputArtifacts: ArtifactReference[];
  source: "DEEPRUN_EXECUTED" | "IMPORTED_VERIFIED" | "IMPORTED_UNVERIFIED";
}
```

## Trust Classes

### `DEEPRUN_EXECUTED`

DeepRun ran the validator and persisted the result. This is the highest current evidence trust class.

### `IMPORTED_VERIFIED`

DeepRun imported evidence with a verifiable origin, such as a signed report or accepted external attestation.

### `IMPORTED_UNVERIFIED`

DeepRun imported evidence without independently verifying its origin. Policy may allow this for advisory checks, but it should not be treated as equivalent to DeepRun-executed evidence.

## Evidence Manifest

An evidence manifest groups evidence records for one subject and binds the evidence set to the current governance decision schema family.

```ts
interface EvidenceManifest {
  evidenceManifestSchemaVersion: 1;
  decisionSchemaVersion: 3;
  subjectDigest: string;
  records: EvidenceRecord[];
}
```

Future decision cores should reference `evidenceManifestHash` rather than individual raw validator outputs. This lets DeepRun preserve a small deterministic decision identity while retaining detailed diagnostic evidence separately.

## Evidence Core And Envelope

Evidence has the same stability problem as decisions: operational metadata should not accidentally redefine semantic validation meaning.

`EvidenceCore` contains the authoritative validation result:

```ts
interface EvidenceCore {
  schemaVersion: 1;
  subjectDigest: string;
  validatorId: string;
  validatorVersion: string;
  validatorImplementationDigest: string;
  profileDigest: string;
  executionContractHash: string;
  trustClass: "DEEPRUN_EXECUTED" | "IMPORTED_VERIFIED" | "IMPORTED_UNVERIFIED";
  status: "PASS" | "FAIL" | "ERROR" | "SKIPPED";
  reasonCodes: string[];
  resultArtifactDigests: string[];
}
```

`EvidenceEnvelope` contains attempt and operations metadata:

```ts
interface EvidenceEnvelope {
  evidenceCore: EvidenceCore;
  evidenceCoreHash: string;
  attemptId: string;
  workerId?: string;
  startedAt: string;
  completedAt: string;
  logReferences: string[];
}
```

The recommended v1 decision binding is:

```text
decisionHash
  -> evidenceManifestHash
      -> ordered evidenceCoreHash values
      -> separately persisted execution envelopes
```

This keeps semantic evidence identity stable while preserving exact attempt history for audits.
