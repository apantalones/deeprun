# Bitcoin Credit Ledger — Phase 3: Sweep, Admin, and Audit Log

This is Phase 3 of 4. Phases 1 and 2 delivered the ledger core and Bitcoin deposit pipeline. Extend the project by adding the daily sweep job, admin management endpoints, and an audit log.

## Prerequisite Structure

The canonical backend already contains from previous phases:
- `src/modules/config` — env config including Bitcoin variables and mainnet guard
- `src/modules/auth` — JWT authentication
- `src/modules/users` — user repository
- `src/modules/ledger` — double-entry ledger
- `src/modules/spends` — internal credit debits
- `src/modules/bitcoin-rpc` — Bitcoin Core RPC client
- `src/modules/deposit-addresses` — deposit address generation and listing
- `src/modules/blockchain-sync` — deposit monitoring sync worker
- `src/modules/deposits` — deposit recording with `(txid, vout)` idempotency

Do not modify Phase 1 or 2 module logic unless fixing a dependency required by this phase.

## Additional Environment Variables

The config module must additionally validate and expose:

- `SWEEP_MIN_SATS` — integer minimum satoshi balance before a sweep triggers; required.
- `WITHDRAWAL_BTC_ADDRESS` — the destination address for sweep transactions; required.

## Modules To Add In This Phase

Use canonical backend layering: `controller/`, `service/`, `repository/`, `schema/`, `dto/`, `tests/`.

### sweeps

Implement a daily sweep job:

1. Call `listUnspent` on the configured wallet to find spendable confirmed UTXOs.
2. If total confirmed UTXO value exceeds `SWEEP_MIN_SATS`:
   a. Estimate miner fee.
   b. Create, sign, and broadcast a sweep transaction to `WITHDRAWAL_BTC_ADDRESS` using Bitcoin Core RPC (`createrawtransaction`, `signrawtransactionwithwallet`, `sendrawtransaction`).
   c. Persist a `SweepAttempt` record with status, txid, feeSats, raw transaction metadata.
   d. Post a ledger entry: debit the `platform_deposit` account, credit the `sweep_treasury` account, and record fee sats against the `fee_expense` account.
3. Prevent duplicate sweeps for the same UTXO set: hash the selected UTXO set and reject if an attempt with that hash is already in a `broadcast` or `pending` state.
4. Support dry-run mode: when `dryRun=true`, evaluate and return the sweep plan without signing or broadcasting.
5. Never expose sweep signing controls to normal frontend users.

Prisma model:
```
SweepAttempt {
  id, utxoSetHash,
  status,           // pending | broadcast | confirmed | failed | dry_run
  txid,
  feeSats (BigInt),
  amountSats (BigInt),
  rawTx,
  errorMessage,
  createdAt, updatedAt
}
```

Wire the sweep job into the Fastify server lifecycle as a scheduled background task (daily interval or via `setInterval`). Keep it isolated from HTTP request handling.

### admin

Admin endpoints are protected by a separate admin-role JWT claim. Normal authenticated users must not access these endpoints. Return HTTP 403 for unauthorized access.

Expose:

- `GET /api/admin/deposits` — list all deposits across all users with pagination.
- `GET /api/admin/users/balances` — list all user balances derived from ledger entries.
- `GET /api/admin/sweep-attempts` — list all sweep attempts.
- `GET /api/admin/audit-events` — list audit events with optional filters.
- `POST /api/admin/sweep/dry-run` — trigger a sweep dry-run and return the plan without signing or broadcasting. Returns the selected UTXOs, estimated fee, and net amount.

### audit-log

- Record audit events for security-relevant actions: login, logout, register, spend, deposit credited, sweep triggered, admin access.
- Prisma model:
  ```
  AuditEvent {
    id, userId (nullable), action, metadata (JSON), createdAt
  }
  ```
- The audit-log module is write-only from other modules. No module reads from another module's audit-log service directly.
- Expose events only through the admin endpoint.

## Prisma Schema Changes

Add `SweepAttempt` and `AuditEvent` to the existing schema. Remove the placeholder comments added in Phase 2.

## Tests

Include focused Vitest tests for:

- Sweeps: sweep is triggered when confirmed UTXO balance exceeds `SWEEP_MIN_SATS`; sweep is skipped when balance is below threshold; duplicate UTXO set hash prevents a second broadcast; fee satoshis are posted as a ledger entry.
- Sweep dry-run: returns plan without calling `sendRawTransaction`.
- Admin access control: normal users cannot reach `/api/admin/*`; admin-role users can.
- Audit log: login events are recorded; spend events are recorded.

## Acceptance Criteria

- `npm run build` succeeds.
- `npm test` passes all Phase 1, 2, and 3 tests.
- `/api/admin/*` endpoints return 403 for non-admin users.
- `POST /api/admin/sweep/dry-run` returns a sweep plan without broadcasting.
- Sweep job starts without errors in the Fastify server lifecycle.
- No Bitcoin RPC credential or sweep signing secret appears in any HTTP response or log.
