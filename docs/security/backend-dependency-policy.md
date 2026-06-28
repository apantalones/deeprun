# Backend Dependency Policy

Date: 2026-06-28

## Lockfile Authority

`packages/deeprun-backend/package-lock.json` is the authoritative install graph for the backend package and the governance verification workflow. Backend deployment and backend CI must run dependency installation from `packages/deeprun-backend` unless a root workspace manifest is restored and explicitly declared authoritative.

Do not maintain both a root production lockfile and this backend lockfile as independent deployment inputs without documenting which graph is authoritative. If a root workspace lockfile is introduced later, either remove this package lockfile or document the intended split between workspace development and backend deployment.

## Audit Commands Retained

Raw reports are retained in:

- `docs/security/backend-npm-audit-2026-06-28.json`
- `docs/security/backend-npm-audit-production-2026-06-28.json`

Commands run:

```sh
npm audit --json
npm audit --omit=dev --json
```

Both commands exit nonzero while advisories are present; the JSON output is still the retained report.

## Current Advisory Triage

`esbuild`

- Scope: development-only/transitive through tooling.
- Reachability: not part of the production API, worker, or CLI runtime path.
- Artifact-content exposure: untrusted artifact content is not served through the esbuild development server in the governance API/worker path.
- Patched version: available through dependency updates; do not use `npm audit fix --force` as a release gate.

`express` via `qs`

- Scope: production dependency used by the API HTTP listener.
- Reachability: Express is directly reachable by API clients. The reported `qs` issue is in `qs.stringify`; DeepRun does not directly call `qs.stringify` with artifact-controlled values.
- Artifact-content exposure: uploaded artifact bytes are handled as raw body content and are not passed to `qs.stringify`.
- Patched version: `express@4.22.2` is available as a non-major update and should be evaluated as a normal dependency patch.

`qs`

- Scope: production transitive dependency of Express.
- Reachability: exposed indirectly through Express dependency graph; the specific vulnerable path is not currently a known DeepRun request path.
- Artifact-content exposure: no known path from untrusted artifact content to `qs.stringify`.
- Patched version: available through `express@4.22.2`.

## Beta Gate

Do not run `npm audit fix --force` in CI. The beta vulnerability gate is:

- Fail on reachable high or critical production vulnerabilities.
- Triage moderate production vulnerabilities by reachability and available compatible patches.
- Track development-only advisories separately unless they affect release artifact generation or CI secret exposure.
