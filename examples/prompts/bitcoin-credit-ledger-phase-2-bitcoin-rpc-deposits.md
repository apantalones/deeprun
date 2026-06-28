# Bitcoin Credit Ledger — Phase 2: Bitcoin RPC and Deposit Sync

This is Phase 2 of 4. Phase 1 established the canonical backend structure with auth, ledger, and spends. Extend that project by adding Bitcoin Core RPC integration, deposit address management, blockchain sync, and deposit recording.

## Prerequisite Structure

The canonical backend already contains these modules from Phase 1:
- `src/modules/config` — env config
- `src/modules/auth` — JWT authentication
- `src/modules/users` — user repository
- `src/modules/ledger` — double-entry ledger with `Account`, `LedgerTransaction`, `LedgerEntry`
- `src/modules/spends` — internal credit debits

Do not modify Phase 1 module logic unless fixing an import or schema dependency introduced in this phase.

## Bitcoin Environment Variables

The config module must additionally validate and expose:

- `BITCOIN_NETWORK` — defaults to `regtest`. Allowed values: `regtest`, `testnet`, `mainnet`.
- `BITCOIN_RPC_URL` — required.
- `BITCOIN_RPC_USERNAME` — required.
- `BITCOIN_RPC_PASSWORD` — required.
- `BITCOIN_RPC_WALLET` — optional wallet name for scoped RPC calls.
- `DEPOSIT_CONFIRMATIONS` — integer, defaults to 3.
- Mainnet guard: if `BITCOIN_NETWORK=mainnet`, then `MAINNET_ENABLED` must also be `true`; otherwise startup fails.

Never expose Bitcoin RPC credentials in HTTP responses, logs, or client-facing code.

## Modules To Add In This Phase

Use canonical backend layering for each module: `controller/`, `service/`, `repository/`, `schema/`, `dto/`, `tests/`.

### bitcoin-rpc

- Thin RPC client wrapping Bitcoin Core JSON-RPC calls over HTTP.
- Expose typed methods for:
  - `getNewAddress(label?: string): Promise<string>` — generate a deposit address.
  - `listUnspent(minConf?, maxConf?, addresses?): Promise<Utxo[]>` — fetch UTXOs.
  - `getTransaction(txid: string): Promise<RawTx>` — fetch a transaction.
  - `getRawTransaction(txid: string, verbose: true): Promise<VerboseRawTx>` — fetch verbose tx.
  - `sendRawTransaction(hex: string): Promise<string>` — broadcast a signed transaction.
  - `getBlockCount(): Promise<number>` — current chain height.
- Credentials come only from the config module. No hardcoded values.
- This module has no HTTP controller. It is infrastructure only.

### deposit-addresses

- `POST /api/deposit-addresses` — generate a new Bitcoin deposit address for the authenticated user via bitcoin-rpc, persist it, and return it.
- `GET /api/deposit-addresses` — return all deposit addresses belonging to the authenticated user.
- Prisma model: `DepositAddress { id, userId, address, label, createdAt }`.
- Each address is linked to exactly one user.

### blockchain-sync

- Background sync worker that monitors known deposit addresses.
- On each sync cycle:
  1. Fetch all known deposit addresses.
  2. For each address, call `getTransaction` or scan with `listUnspent` to find new incoming UTXOs.
  3. Record new deposits or update confirmation counts on existing ones.
  4. For each deposit reaching `DEPOSIT_CONFIRMATIONS` that has not yet credited the user, post a ledger credit to the user's liability account and mark the deposit as `confirmed`.
  5. Reorg safety: if a previously `confirmed` deposit falls below `DEPOSIT_CONFIRMATIONS` in a later sync, record a reversal ledger entry and set deposit state to `reversed`.
- The sync worker is a module-internal loop. It must not be exposed over HTTP.
- Wire the sync worker startup into the Fastify server lifecycle (e.g., `onReady` hook), but keep it isolated from HTTP request handling.

### deposits

- Prisma model:
  ```
  Deposit {
    id, userId, depositAddressId,
    txid, vout,               // unique together — idempotency key
    amountSats (BigInt),
    confirmations,
    status,                   // pending | confirmed | reversed | ignored
    creditedAt,
    reversedAt,
    createdAt, updatedAt
  }
  ```
- Unique constraint on `(txid, vout)` — duplicate observations are idempotent.
- Ledger credit posted only when status transitions `pending → confirmed`.
- Reversal entry posted when status transitions `confirmed → reversed`.
- `GET /api/deposits` — return the authenticated user's deposit history.
- Optional: `GET /api/deposits/stream` — Server-Sent Events endpoint for real-time deposit status updates.

## Prisma Schema Changes

Extend the existing Prisma schema with:
- `DepositAddress`
- `Deposit`

Leave placeholder comments for `SweepAttempt` and `AuditEvent` which Phase 3 will add.

## Tests

Include focused Vitest tests for:

- bitcoin-rpc: RPC client calls correct endpoint with correct credentials; credential values do not appear in thrown errors or logs.
- Mainnet guard: startup fails when `BITCOIN_NETWORK=mainnet` and `MAINNET_ENABLED` is not `true`.
- deposit-addresses: creating an address calls `getNewAddress`; address is persisted and linked to the user.
- deposits: `(txid, vout)` uniqueness prevents double-recording; pending deposit does not credit; `confirmed` deposit posts a ledger credit; reorg triggers a reversal entry.
- Confirmation threshold: deposit below threshold stays `pending`; deposit at or above threshold transitions to `confirmed`.

## Acceptance Criteria

- `npm run build` succeeds.
- `npm test` passes all Phase 1 and Phase 2 tests.
- `POST /api/deposit-addresses` and `GET /api/deposits` are reachable and auth-guarded.
- No Bitcoin RPC credential appears in any HTTP response or log output.
- Sync worker starts without errors when Bitcoin RPC env vars are present.
