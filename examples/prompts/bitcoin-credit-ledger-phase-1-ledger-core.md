# Bitcoin Credit Ledger — Phase 1: Ledger Schema and Core API

Scaffold the canonical backend for a Bitcoin credit ledger. This is Phase 1 of 4. Build everything except Bitcoin RPC, deposit sync, sweep, and the admin/audit modules. Those come in later phases.

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

## Port And Environment

- Do not hard-code port 3000.
- Read `PORT` from the environment and default to `4000`.
- Read `PUBLIC_API_URL` from the environment and default to `http://localhost:4000`.
- Read `FRONTEND_URL` from the environment and default to `http://localhost:5173`.
- Configure CORS only from `CORS_ALLOWED_ORIGINS`; do not allow wildcard CORS.
- Startup must fail if `DATABASE_URL` or `JWT_SECRET` are missing.

## Modules To Build In This Phase

Use canonical backend layering for each module: `controller/`, `service/`, `repository/`, `schema/`, `dto/`, `tests/`.

### config

- Load and validate all environment variables at startup.
- Export typed config accessors used by other modules.
- Fail fast with a descriptive error if a required variable is missing.

### auth

- `POST /api/auth/register` — create a new user account.
- `POST /api/auth/login` — issue a JWT on valid credentials.
- `POST /api/auth/logout` — invalidate or clear the session token.
- `GET /api/auth/me` — return the authenticated user's profile.
- Store passwords hashed (bcrypt or argon2). Never return password hashes.
- JWT must carry `userId` and be verifiable by downstream middleware.

### users

- Internal user repository used by auth and other modules.
- User record includes: `id`, `email`, `passwordHash`, `createdAt`, `updatedAt`.

### ledger

- Implement append-only double-entry ledger accounting.
- All Bitcoin amounts are integer satoshis. No floating point.
- Prisma models for:
  - `Account` — named ledger accounts (type: `user_liability`, `platform_deposit`, `sweep_treasury`, `fee_expense`).
  - `LedgerTransaction` — groups one or more balanced entries; includes `description` and `referenceId`.
  - `LedgerEntry` — debit or credit line on an account; immutable once created.
- Each `LedgerTransaction` must balance: sum of debits equals sum of credits.
- User balances are derived from `LedgerEntry` rows filtered by the user's liability account; never stored directly.
- `GET /api/account/balance` — return available credit balance in satoshis for the authenticated user.
- Do not mutate historical entries. Use reversal entries for corrections.

### spends

- `POST /api/spends` — debit a user's internal credit account.
  - Body: `{ amountSats: number, idempotencyKey: string }`.
  - Reject spends that exceed available credit.
  - Idempotent: repeated requests with the same `idempotencyKey` return the original result without double-debiting.
  - Does not broadcast any Bitcoin transaction.
- `GET /api/spends` — return the authenticated user's spend history.

## Prisma Schema Scope

Include only the tables required for Phase 1 modules. Leave placeholder comments for tables that Phase 2 and Phase 3 will add (`DepositAddress`, `Deposit`, `SweepAttempt`, `AuditEvent`).

## Health Check

- `GET /health` returns `{ status: "ok" }` with HTTP 200. No auth required.

## Architecture Constraints

These rules are enforced at commit time and will hard-block the build if violated:

- **No cross-module service imports — ever.** A service in module A must never import a service from module B. This includes constructor injection typed to another module's service class. Violation: `spends/service/spends-service.ts` importing `LedgerService`. Fix: the SpendsService should accept a `LedgerRepository` (not `LedgerService`) injected at construction, or record ledger entries directly via Prisma through its own repository.
- **Tests mock foreign modules.** Each module's `tests/` directory must only import that module's own service. For dependencies on other modules use `vi.mock(...)` — do not import the foreign service directly.
- **No db-layer imports into service.** Service files must not import Prisma client or repository files from other modules.
- **No controller importing db directly.** Controllers import services only, not repositories or Prisma.
- **Concrete pattern for spends → ledger:** `SpendsService` receives a `prisma: PrismaClient` in its constructor and writes `LedgerEntry`/`LedgerTransaction` rows directly using that client — it does not call `LedgerService` methods.
- **Every import target must exist.** If a file imports `../errors/UnauthorizedError.js`, that file must be created in the same commit. Do not import from paths that are not being created. Use Fastify's built-in `fastify.httpErrors` helpers or throw plain `Error` objects with an HTTP status code property instead of custom error classes unless you explicitly create those classes in the same pass.
- **Config module file layout.** The config module lives at `src/modules/config/`. It must include `src/modules/config/env.ts` (env validation and typed accessors). Tests in `src/modules/config/tests/` must only import from files you are creating inside `src/modules/config/` — do not reference the template's pre-existing `src/config/env.ts`. If `cors.test.ts` contains `import '../env.js'`, then `src/modules/config/env.ts` MUST be one of the files you generate.
- **CORS tests use Fastify inject.** Tests for CORS behavior must call `fastify.inject()` to make HTTP requests and check response headers. They must not attempt to `import` environment config files directly. Build a minimal Fastify instance inside the test with the app's CORS plugin applied, or use `vi.mock` to stub config values.
- **Auth middleware placement.** If you create a shared auth middleware/hook, it MUST live at `src/shared/auth-middleware.ts`. The import path from `src/modules/<module>/controller/<file>.ts` is `../../../shared/auth-middleware.js`. Do NOT put it at `../../middleware/auth-middleware.js` (which resolves to the non-existent `src/modules/middleware/`) or any other path. If you reference a shared auth helper, you must create `src/shared/auth-middleware.ts` in the same pass.
- **Prefer inline preHandlers.** The safest approach is to define auth checking as an inline Fastify `preHandler` hook within each module's route plugin file, rather than importing a shared middleware file at all. This avoids any import-target errors entirely.
- **Audit every import before finalizing.** After generating all files, mentally scan every `import` statement in every file. For each import path, confirm it resolves to either (a) a file in the existing template scaffold OR (b) a file you are generating in this same pass. If any import is unresolved, either generate the missing file or rewrite the import to remove the dependency. Do not leave any import pointing to a non-existent path.

## Tests

Include focused Vitest tests for:

- Config: missing required env vars cause startup failure; PORT defaults to 4000.
- CORS: only origins in `CORS_ALLOWED_ORIGINS` are allowed.
- Auth: register, login, logout, and `/api/auth/me` round-trip.
- Ledger: balance is derived from entries; no floating point amounts; double-entry balance invariant.
- Spends: spend reduces balance; spend-to-zero succeeds; spend above balance is rejected; idempotency key prevents double-debit.

## Acceptance Criteria

- `npm install` succeeds.
- `npm run build` succeeds with `tsc --noEmit`.
- `npm test` passes all Phase 1 tests.
- `GET /health` returns 200.
- `/api/auth/*` and `/api/account/balance` and `/api/spends` are reachable.
- No Bitcoin RPC dependency in Phase 1 code.
