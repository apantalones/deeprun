# Bitcoin Credit Ledger CLI Run

This guide runs Deeprun from the CLI to build a Bitcoin deposit and internal credit ledger backend. The build is split across four focused phases so each mutation stays within the JSON contract size limit.

| Phase | Prompt | Scope |
|-------|--------|-------|
| 1 | `bitcoin-credit-ledger-phase-1-ledger-core.md` | Prisma schema, Fastify server, auth, ledger, spends |
| 2 | `bitcoin-credit-ledger-phase-2-bitcoin-rpc-deposits.md` | Bitcoin RPC client, deposit addresses, blockchain sync, deposits |
| 3 | `bitcoin-credit-ledger-phase-3-sweep-admin.md` | Sweep job, admin endpoints, audit log |
| 4 | `bitcoin-credit-ledger-phase-4-openapi-client-tests.md` | OpenAPI doc, typed API client package, frontend docs, final tests |

The generated project is backend-only and API-first. It is designed to connect to a React + TypeScript Vite frontend later through `VITE_API_BASE_URL=http://localhost:4000`.

## 1. Start Deeprun

Install dependencies and configure Deeprun normally:

```bash
npm install
```

Set the minimum Deeprun runtime environment:

```bash
export DATABASE_URL='postgres://user:pass@127.0.0.1:5432/deeprun'
export DATABASE_SSL=disable
export DEEPRUN_WORKSPACE_ROOT="$PWD/.deeprun/workspace"
export PORT=3000
```

Set a real provider for actual generation:

```bash
export OPENAI_API_KEY='sk-your-key'
export DEEPRUN_DEFAULT_PROVIDER=openai
export DEEPRUN_LLM_TIMEOUT_MS=600000
```

`OPENAI_API_KEY` must use that exact name. Deeprun does not read `OPEN_API_KEY`.

Start the Deeprun API:

```bash
npm run dev
```

In another shell, start the worker:

```bash
export NODE_ID=compute-node-01
export NODE_ROLE=compute
npm run worker:agent-jobs
```

## 2. Initialize The CLI

```bash
npm run deeprun -- init \
  --api http://127.0.0.1:3000 \
  --email you@example.com \
  --password 'Password123!' \
  --name 'Your Name' \
  --org 'Your Org' \
  --workspace 'Your Workspace'
```

## 3. Run The Phases

Each phase builds on the previous one. Run them in order, completing validate and gate after each before starting the next.

### Phase 1 — Ledger Schema and Core API

```bash
npm run deeprun:bitcoin-phase-1 -- --provider openai
```

Or call the CLI directly:

```bash
npm run deeprun -- run \
  --engine kernel \
  --template canonical-backend \
  --profile ci \
  --planner-timeout-ms 120000 \
  --wait \
  --wait-mode remote \
  --wait-timeout-ms 600000 \
  --project-name "Bitcoin Credit Ledger — Phase 1" \
  --goal-file examples/prompts/bitcoin-credit-ledger-phase-1-ledger-core.md \
  --provider openai
```

### Phase 2 — Bitcoin RPC and Deposit Sync

```bash
npm run deeprun:bitcoin-phase-2 -- --provider openai
```

### Phase 3 — Sweep, Admin, and Audit Log

```bash
npm run deeprun:bitcoin-phase-3 -- --provider openai
```

### Phase 4 — OpenAPI, API Client, and Final Tests

```bash
npm run deeprun:bitcoin-phase-4 -- --provider openai
```

Each command prints `PROJECT_ID=` and `RUN_ID=`. Keep both values for validate and gate.

## 4. Validate And Gate After Each Phase

Run these after each phase completes before starting the next:

```bash
npm run deeprun -- validate \
  --project <PROJECT_ID> \
  --run <RUN_ID>
```

```bash
npm run deeprun -- gate \
  --project <PROJECT_ID> \
  --run <RUN_ID> \
  --output .deeprun/governance-decision.json
```

## 5. Frontend Connection

The generated backend exposes its API on `PORT` (defaulting to `4000`).

Your Vite frontend can use:

```bash
VITE_API_BASE_URL=http://localhost:4000
```

Or a Vite proxy in `vite.config.ts`:

```ts
export default {
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4000"
    }
  }
};
```

Phase 4 generates a typed `packages/api-client` package and `docs/frontend-integration.md` with full example calls.

## Running The Original Monolithic Prompt

The original single-phase prompt is still available for reference or experimentation:

```bash
npm run deeprun:bitcoin-ledger -- --provider openai
```

Use the phased approach for production runs — the monolithic prompt is too large for reliable JSON mutation output.
