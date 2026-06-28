# DeepRun Governance Glossary

This glossary defines the public governance vocabulary. Internal implementation terms may change, but these concepts should remain stable for external integrations.

## Public Concepts

### Subject

The immutable software object being assessed. A subject may be an uploaded archive, an OCI artifact pinned by digest, or a Git repository at an immutable commit SHA.

### Assessment

A request to evaluate one subject under one validation profile and one policy bundle. Internally this may create runs, jobs, steps, workers, logs, and retries, but external consumers should not need those terms to submit or inspect an assessment.

### Profile

A versioned validator profile that defines the technical assessment shape, such as `node-fastify-prisma@1`. Profiles describe what kind of artifact DeepRun knows how to evaluate.

### Policy Bundle

A versioned, normalized set of acceptance rules applied to an assessment. Policy controls which checks are required, what evidence trust level is acceptable, and which failures block promotion.

### Evidence

Persisted, normalized facts produced or imported during evaluation. Evidence can come from DeepRun-executed validators, verified imported reports, or unverified imported reports. Policy decides which evidence sources are authoritative enough.

### Decision

The deterministic PASS or FAIL result produced from persisted, normalized state. A decision is identified by `decisionHash` and must not depend on transient logs, worker memory, model output, or request-time flags.

### Attestation

A signed portable statement binding a decision to its subject digest. Future DeepRun attestations should use existing supply-chain standards such as in-toto statements, DSSE envelopes, and Sigstore/Cosign verification.

## Internal Concepts Hidden Behind Public Terms

| Public concept | Internal concepts it may hide |
| --- | --- |
| Subject | project, source tree, commit, artifact |
| Assessment | run, agent run, validation run |
| Profile | contract, validator configuration |
| Policy bundle | execution configuration, governance settings |
| Evidence | steps, logs, test results, validator output |
| Decision | governance decision |
| Attestation | signed decision envelope |
| Executor | worker, compute node, eval node |

## Maturity Vocabulary

### Decision Deterministic

Given identical persisted and normalized state, DeepRun produces the same decision, reason codes, payload, and decision hash.

### Execution Reproducible

Running validators again against the same subject produces equivalent evidence because validator versions, runner images, toolchains, dependencies, environment, clocks, randomness, network access, and external services are controlled or recorded.

### Evidence Verified

DeepRun can establish which subject was tested, which validator produced the result, where it ran, whether the environment was trusted, and whether imported evidence was independently verified.

### Decision Attested

The decision is signed in a portable envelope so consumers can verify the subject binding and decision identity outside the DeepRun API.
