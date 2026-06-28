# Bitcoin Credit Ledger — Phase 4: OpenAPI, API Client, and Final Tests

This is Phase 4 of 4. The canonical backend is now complete across all modules. Polish the API surface, generate the OpenAPI document, publish the typed API client package, add frontend integration docs, and fill in any remaining tests.

## Prerequisite Structure

All modules from previous phases are present:
- auth, users, config, ledger, spends (Phase 1)
- bitcoin-rpc, deposit-addresses, blockchain-sync, deposits (Phase 2)
- sweeps, admin, audit-log (Phase 3)

Do not introduce new modules or change existing business logic in this phase.

## OpenAPI

- Generate and serve an OpenAPI 3.1 document at `GET /openapi.json`.
- The document must describe all frontend-facing endpoints:
  - `POST /api/auth/register`
  - `POST /api/auth/login`
  - `POST /api/auth/logout`
  - `GET /api/auth/me`
  - `GET /api/account/balance`
  - `POST /api/deposit-addresses`
  - `GET /api/deposit-addresses`
  - `GET /api/deposits`
  - `GET /api/ledger-entries`
  - `POST /api/spends`
  - `GET /api/spends`
  - Optional: `GET /api/deposits/stream`
- Admin endpoints must appear in the document but be tagged `admin` and marked as requiring admin-role authorization.
- The document must not include Bitcoin RPC credentials, sweep signing secrets, or any internal infrastructure detail.
- Use Fastify's built-in schema integration or `@fastify/swagger` to keep the document in sync with route schemas automatically.

## Typed API Client Package

Create `packages/api-client/` as a standalone TypeScript package that a React + TypeScript Vite frontend can import.

Requirements:
- Export typed async functions for every frontend-facing endpoint.
- Accept `baseUrl` and `token` as constructor or factory parameters.
- Never include Bitcoin RPC credentials, admin-only fields, or sweep controls in client code.
- Include TypeScript types for all request bodies and response shapes.
- The package must have its own `package.json` with `name`, `version`, `main`, and `types` fields.
- It must be buildable with `tsc`.
- Example export shape:
  ```ts
  export interface ApiClient {
    auth: {
      register(body: RegisterBody): Promise<UserProfile>;
      login(body: LoginBody): Promise<{ token: string }>;
      logout(): Promise<void>;
      me(): Promise<UserProfile>;
    };
    account: {
      balance(): Promise<{ balanceSats: number }>;
    };
    depositAddresses: {
      create(): Promise<DepositAddress>;
      list(): Promise<DepositAddress[]>;
    };
    deposits: {
      list(): Promise<Deposit[]>;
    };
    ledger: {
      entries(): Promise<LedgerEntry[]>;
    };
    spends: {
      create(body: SpendBody): Promise<Spend>;
      list(): Promise<Spend[]>;
    };
  }
  ```

## Environment File

Create `.env.example` at the project root with:

```
PORT=4000
PUBLIC_API_URL=http://localhost:4000
FRONTEND_URL=http://localhost:5173
CORS_ALLOWED_ORIGINS=http://localhost:5173
DATABASE_URL=
JWT_SECRET=
BITCOIN_NETWORK=regtest
BITCOIN_RPC_URL=
BITCOIN_RPC_USERNAME=
BITCOIN_RPC_PASSWORD=
BITCOIN_RPC_WALLET=
DEPOSIT_CONFIRMATIONS=3
SWEEP_MIN_SATS=
WITHDRAWAL_BTC_ADDRESS=
MAINNET_ENABLED=false
```

## Frontend Integration Docs

Create `docs/frontend-integration.md` showing:

- `VITE_API_BASE_URL=http://localhost:4000`
- Vite dev proxy configuration:
  ```ts
  export default {
    server: {
      port: 5173,
      proxy: { "/api": "http://localhost:4000" }
    }
  };
  ```
- Example TypeScript calls (using the api-client package) for:
  - register and login
  - fetching balance
  - creating a deposit address
  - listing deposits
  - listing ledger entries
  - posting a spend

## Final Tests

Add or complete Vitest tests for any gaps not covered in Phases 1–3:

- `GET /openapi.json` returns a valid JSON object with `openapi` and `paths` keys.
- API client package: import resolves without errors; typed functions exist for all expected endpoints.
- No Bitcoin RPC credential value (`BITCOIN_RPC_PASSWORD`, `BITCOIN_RPC_USERNAME`) appears in any HTTP response body or log output across the full test suite.
- `GET /api/ledger-entries` returns entries for the authenticated user only.
- Normal users cannot reach `/api/admin/*`.
- `GET /health` returns `{ status: "ok" }` with HTTP 200.

## Acceptance Criteria

- `npm install` succeeds.
- `npm run build` succeeds (both root and `packages/api-client`).
- `npm test` passes all tests across all phases.
- `GET /health` returns 200.
- `GET /openapi.json` returns a valid JSON object.
- `packages/api-client` exports typed functions for all frontend-facing endpoints.
- No Bitcoin RPC credential appears in any HTTP response, the API client, logs, or doc examples.
- The backend can be connected to a Vite frontend using `VITE_API_BASE_URL=http://localhost:4000`.
