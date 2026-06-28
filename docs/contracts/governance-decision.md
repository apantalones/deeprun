# Governance Decision Contract

The governance decision payload is the external blocking authority contract for CI and release orchestration. CI should consume it like a compiler result: read one JSON document, branch on `decision`, optionally inspect `reasonCodes`, and never scrape logs for pass/fail.

## Current Version

Current schema version: `3`

Schema v3 separates the hashable authority payload from issued/display metadata.

## Decision Core

`DecisionCore` is the identity-bearing portion of a decision. `decisionHash` is computed only from this object.

```ts
interface DecisionCore {
  decisionSchemaVersion: 3;
  subject: {
    digest: string;
    mediaType?: string;
  };
  profile: {
    id: string;
    version: string;
    digest: string;
  };
  policy: {
    id: string;
    version: string;
    digest: string;
  };
  executionContractHash: string;
  evidenceManifestHash: string;
  controlPlaneIdentityHash: string;
  decision: "PASS" | "FAIL";
  reasonCodes: string[];
  artifactReferences: ArtifactReference[];
}
```

## Issued Decision

`IssuedDecision` wraps the core with issuance metadata. Fields such as `issuedAt`, `issuer`, and `signature` do not participate in `decisionHash`.

```ts
interface IssuedDecision {
  decisionCore: DecisionCore;
  decisionHash: string;
  issuedAt: string;
  issuer: string;
  signature?: SignatureEnvelope;
}
```

This preserves stable identity for the authoritative decision even when the same decision is issued later, by a different issuer, or with a new signature envelope.

## Compatibility Projection

The current API also supports the pre-core flat v3 governance payload while the external assessment API is introduced. Treat this shape as a compatibility projection of authoritative decision core and issuance records, not as a second authority model:

```json
{
  "decisionSchemaVersion": 3,
  "decisionHash": "sha256(canonical DecisionPayloadWithoutHash)",
  "decision": "PASS",
  "reasonCodes": [],
  "reasons": [],
  "runId": "uuid",
  "contract": {
    "schemaVersion": 2,
    "hash": "sha256",
    "determinismPolicyVersion": 1,
    "normalizationPolicyVersion": 1,
    "plannerPolicyVersion": 1,
    "correctionRecipeVersion": 1,
    "validationPolicyVersion": 1,
    "governancePolicyVersion": 1,
    "randomnessSeed": "forbidden:no-random-branching"
  },
  "controlPlaneIdentityHash": "sha256",
  "artifactRefs": []
}
```

This compatibility shape remains valid for existing kernel-run governance endpoints. New governance-only assessment APIs should use `DecisionCore` plus `IssuedDecision`, then project to flat v3 only where legacy clients require it.

## Decision Hash

For `IssuedDecision`:

`decisionHash = sha256(canonicalJson(decisionCore))`

For the compatibility flat payload:

`decisionHash = sha256(canonicalJson(payloadWithoutHash))`

Canonical JSON rules used by the current implementation:

- object keys are recursively sorted
- arrays preserve order
- the hash is computed before adding `decisionHash`

Future cryptographic attestation work should evaluate RFC 8785 JSON Canonicalization Scheme for the canonical byte representation.

## Reason Codes

Stable machine-readable codes currently include:

- `EXECUTION_CONTRACT_MISSING`
- `UNSUPPORTED_CONTRACT`
- `RUN_NOT_COMPLETE`
- `RUN_NOT_VALIDATED`
- `RUN_VALIDATION_FAILED`
- `RUN_COMMIT_UNPINNED`
- `RUN_V1_READY_NOT_RUN`
- `RUN_V1_READY_FAILED`

CI should prefer `reasonCodes[]` for gating and routing. Rich human-readable reason messages are audit and UI metadata; they should not become the only source of machine behavior.

## Decision Rule

`PASS` means the subject is externally promotable under the persisted governance mode and policy represented by the decision identity.

`FAIL` means the pipeline must stop based on the decision payload.

Decision projection is deterministic over persisted, normalized state. The authority path must not read:

- request-time strictness flags
- process environment
- wall clock
- worker memory
- analytical telemetry
- transient logs
- model output

Strict v1-ready enforcement is taken from persisted validation/governance state on the run. Contract support is taken from the persisted execution-contract support verdict on the run.

The CI contract is intentionally narrow:

- branch on `decision`
- optionally match on `reasonCodes`
- optionally pin on `decisionHash`, `policy.digest`, `profile.digest`, or `executionContractHash`
- do not parse stdout/stderr for pass/fail

## API

Authenticated compatibility endpoint:

- `POST /api/projects/:projectId/governance/decision`

Body:

```json
{
  "runId": "uuid"
}
```

Compatibility note:

- `strictV1Ready` may still be accepted as an optional request field for drift detection, but it must match the persisted run governance mode and must not change the decision outcome.

## CLI

```bash
deeprun gate --project <projectId> --run <runId> [--strict-v1-ready] [--output <path>]
```

Behavior:

- when `--strict-v1-ready` is used, the CLI first persists strict validation/governance state on the run if needed
- emits the JSON payload to stdout
- writes the same payload to `--output` when provided
- always persists the authoritative content-addressed file under:
  - `.deeprun/decisions/<decisionHash>.json`
  - `.deeprun/decisions/latest.json` as a convenience pointer
- exits `0` on `PASS`
- exits `1` on `FAIL`

CI logic should ignore logs and parse only the decision payload.
