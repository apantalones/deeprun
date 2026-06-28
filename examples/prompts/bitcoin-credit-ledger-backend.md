# Bitcoin Credit Ledger Backend Prompt

Build an API-first backend for a Bitcoin deposit and internal credit ledger system. It must be designed to connect to an existing or future React + TypeScript frontend that uses Vite, but do not build or serve the frontend in this backend project.

## Stack

- Node 20+
- TypeScript strict mode
- Fastify
- Prisma
- PostgreSQL
- Zod validation
- JWT authentication suitable for browser clients
- Vitest tests
- Pino structured logging
- Docker-ready runtime
- Bitcoin Core RPC only for Bitcoin integration

## Port And Frontend Integration

- Do not hard-code port 3000.
- Read `PORT` from the environment and default to `4000`.
- Read `PUBLIC_API_URL` from the environment and default to `http://localhost:4000`.
- Read `FRONTEND_URL` from the environment and default to `http://localhost:5173`.
- Configure CORS only from `CORS_ALLOWED_ORIGINS`; do not allow wildcard CORS.
- Include `.env.example` with:
  - `PORT=4000`
  - `PUBLIC_API_URL=http://localhost:4000`
  - `FRONTEND_URL=http://localhost:5173`
  - `CORS_ALLOWED_ORIGINS=http://localhost:5173`
  - `DATABASE_URL`
  - `JWT_SECRET`
  - `BITCOIN_NETWORK=regtest`
  - `BITCOIN_RPC_URL`
  - `BITCOIN_RPC_USERNAME`
  - `BITCOIN_RPC_PASSWORD`
  - `BITCOIN_RPC_WALLET`
  - `DEPOSIT_CONFIRMATIONS=3`
  - `SWEEP_MIN_SATS`
  - `WITHDRAWAL_BTC_ADDRESS`
  - `MAINNET_ENABLED=false`
- Include frontend integration docs showing:
  - `VITE_API_BASE_URL=http://localhost:4000`
  - a Vite dev proxy example for `/api` to `http://localhost:4000`
  - example TypeScript calls for auth, balance, deposit address creation, deposits, ledger entries, and spends

## API Contract

Expose stable JSON REST endpoints under `/api`.

Generate and serve an OpenAPI document at `/openapi.json`.

Include a small typed TypeScript API client under `packages/api-client` that a React + TypeScript Vite frontend can import. The client must keep Bitcoin RPC credentials and admin/sweep controls out of browser-facing code.

Frontend-facing endpoints must include:

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
- Optional: `GET /api/deposits/stream` using Server-Sent Events for deposit status updates

Admin endpoints must be protected separately from normal user endpoints and must include:

- list deposits
- list user balances
- list sweep attempts
- list audit events
- trigger a dry-run sweep check without exposing signing secrets to the frontend

## Bitcoin Rules

- Use no third-party payment processor.
- Do not use Coinbase, Stripe, BTCPay, Binance, Kraken, or any external payment service.
- Integrate with Bitcoin Core RPC only.
- Default to `regtest` or `testnet`.
- Mainnet must require both `BITCOIN_NETWORK=mainnet` and `MAINNET_ENABLED=true`; otherwise startup must fail.
- Never expose Bitcoin RPC credentials to the frontend.
- Never sign transactions in frontend code.
- Never store or return private keys.
- Generate deposit addresses through Bitcoin Core RPC.
- Monitor known deposit addresses through a sync worker.
- Record deposits by unique `txid:vout`.
- Credit a user only after the configured confirmation threshold.
- Handle duplicate observations idempotently.
- Track pending, confirmed, reversed, and ignored deposit states.
- Include reorg-safe behavior. If a previously confirmed deposit falls below the confirmation threshold or disappears, record a reversal or hold according to an explicit state transition.

## Internal Credit Ledger

User balances are internal credits only. They are not computed directly from Bitcoin wallet balance or individual UTXOs.

All Bitcoin amounts must be integer satoshis. Do not use JavaScript floating point for BTC amounts.

Implement append-only double-entry ledger accounting:

- accounts
- ledger transactions
- ledger entries
- user liability accounts
- platform deposit control account
- sweep/treasury account
- fee expense account

All user balances must be derived from ledger entries.

Do not mutate historical ledger entries. Use reversal entries for corrections.

Internal spend/debit behavior:

- `POST /api/spends` accepts `amountSats` and an idempotency key.
- It reduces available user credit until zero.
- It must reject spends that exceed available credit.
- It must be idempotent for repeated requests with the same key.
- It must not broadcast Bitcoin transactions.

## Sweep Behavior

Implement a daily sweep job:

- It checks spendable confirmed UTXOs in the configured deposit/sweep wallet.
- If the confirmed balance exceeds `SWEEP_MIN_SATS`, create, persist, sign, and broadcast a sweep transaction to `WITHDRAWAL_BTC_ADDRESS`.
- Account for miner fees in ledger entries.
- Persist sweep attempts, statuses, txids, fee sats, raw transaction metadata, and error messages.
- Prevent duplicate sweeps for the same selected UTXO set.
- Support dry-run mode for admin inspection.
- Never expose sweep signing controls to normal frontend users.

## Modules

Use canonical backend layering and include modules for:

- auth
- users
- config/env
- bitcoin-rpc
- deposit-addresses
- blockchain-sync
- deposits
- ledger
- spends
- sweeps
- admin
- audit-log

Keep module boundaries clean. Controllers should call services, services should call repositories/infrastructure, and repositories should own database access.

## Tests

Include focused tests for:

- environment validation, including port 4000 default and mainnet guard
- CORS config from allowed origins
- OpenAPI endpoint availability
- typed API client export shape
- deposit address creation
- unique `txid:vout` deposit idempotency
- confirmation threshold crediting
- pending to confirmed deposit transition
- reorg reversal or hold behavior
- ledger balance derivation from entries
- no floating point Bitcoin amount handling
- spend-to-zero behavior
- spend idempotency key behavior
- rejecting spends above available balance
- sweep threshold behavior
- sweep idempotency for the same UTXO set
- sweep fee ledger accounting
- normal users cannot access admin or sweep controls

## Acceptance Criteria

- `npm install` succeeds.
- `npm run build` succeeds.
- `npm test` succeeds.
- `npm run dev` starts the API on `PORT` or `4000`.
- `GET /health` returns 200.
- `GET /openapi.json` returns a valid JSON object.
- The backend can be connected to a Vite frontend using `VITE_API_BASE_URL=http://localhost:4000`.
- No Bitcoin RPC credential appears in frontend-facing responses, the API client package, logs, or docs examples.
