# CONVENTIONS.md — Security Model & Coding Conventions

Every rule here is a hard requirement. If following a rule seems impossible,
stop and ask — do not silently deviate.

---

## Part A — Security model

### A1. Threat model (what we defend against, honestly stated)

| Threat | Defense | Layer |
|---|---|---|
| Anyone with the URL calling operational tools | Bearer token on every request | Transport |
| Malformed / out-of-domain inputs | Zod `.strict()` schemas, regex-pinned IDs, enums, integer paise, caps | Input |
| SQL injection | Prepared statements exclusively (better-sqlite3 parameter binding) — **note: this is what prevents injection, not Zod; Zod prevents malformed inputs. Attribute correctly in docs** | Data |
| Prompt injection via stored data (customer notes) | (a) untrusted-content wrapping in tool outputs, (b) no direct-mutation tool exists, (c) propose→execute human gate | Tool-surface design |
| Duplicate / replayed mutations | Conditional-update idempotency on proposals; at-most-once execution | Write path |
| Concurrent execution race | Same conditional update inside a transaction — two callers, one winner | Write path |
| Stale action on changed state | Proposal state snapshot vs. current state check at execute time | Write path |
| Excessive blast radius | Refund hard cap (₹10,000/resolution), refundable-amount ceiling, action/state compatibility matrix, no bulk operations | Write path |
| Unaccountable actions | Append-only audit log w/ before+after snapshots, written in the same transaction | Audit |

### A2. Known limitations (state these in the README — naming them is the point)

1. **Actor identity is client-asserted.** `confirmed_by` / `_meta` actor is
   attribution for audit purposes, not authentication. Production would derive
   identity from an OAuth 2.1 flow (MCP auth spec), not trust the caller.
2. **Single shared bearer token.** No per-user tokens, rotation, or rate
   limiting. Acceptable for evaluation; listed in scaling path.
3. **The human confirmation step is protocol-level, not enforced UI.** We rely
   on the MCP client surfacing the plan to the analyst. A malicious *client*
   could auto-confirm; defending against a hostile client is out of scope.
4. **No TLS termination in-app** — Railway provides HTTPS at the edge.
5. **Tokenized URL path is an opt-in compatibility fallback, disabled by default.**
   Anthropic's connector auth reference discourages credentials in connector URLs,
   and the MCP authorization spec prohibits access tokens in the URI query string.
   Our fallback uses a path segment rather than a query parameter, so it sits
   outside that clause's literal text but inside its reasoning: URLs reach
   proxy/CDN access logs, browser history, and `Referer`. It exists because
   Claude's `static_headers` auth is Beta and org-admin gated, so header-only auth
   could leave the server unconnectable from claude.ai. It ships **off**
   (`ALLOW_URL_TOKEN` unset), is enabled deliberately for the hosted demo, and is
   mitigated by HTTPS-at-edge, a single-purpose synthetic-data token, and
   one-command rotation via a Railway env var. The header path is the recommended
   channel.

### A3. Security implementation rules

- Auth middleware runs **before** any MCP handling and accepts the shared token by
  either transport: an `Authorization: Bearer` header, or a tokenized URL path
  (`/mcp/<token>`) for clients that cannot set custom headers. Both paths verify via
  constant-time comparison of SHA-256 digests against `process.env.MCP_BEARER_TOKEN`.
  Missing env var at boot = crash loudly, don't default. The token must never appear
  in logs from **either** path — redact the `authorization` header and rewrite the
  request path before serialization. The URL-path route is gated behind
  `ALLOW_URL_TOKEN` and is not mounted unless it is set (see A2.5).
- `/health` is the only unauthenticated route. It leaks no data beyond
  `{status, uptime, seedVersion, orderCount}`.
- Never log the bearer token. Redact `authorization` headers in pino
  (`redact: ['req.headers.authorization']`).
- Customer-authored text (`orders.notes`) must never appear in any tool output
  except inside the `customer_note.{warning, content}` wrapper defined in
  TOOLS.md. Never concatenate it into `detail` strings, plans, or summaries.
- Every execution-path rejection returns a structured error AND writes an audit row
  with `outcome: "rejected:<reason>"`. Proposal-stage rejections
  (`no_action_needed`, `invalid_action_for_state`, `amount_exceeds_cap`, etc.) are
  validation outcomes, not blocked mutations — they are logged at `warn` via the
  instrumentation wrapper and do NOT write audit rows. Rationale: the audit log is a
  complete record of state changes and blocked attempts to change state; a rejected
  proposal never becomes executable, so excluding it leaves no gap in that record.
  Silent failures are bugs.
- Error messages to the client never include stack traces, file paths, or SQL.

---

## Part B — Coding conventions

### B1. TypeScript

- `"strict": true`, plus `noUncheckedIndexedAccess: true`,
  `exactOptionalPropertyTypes: true`. No `any`, no `as unknown as`, no
  `@ts-ignore`. If a type fight occurs, fix the type, not the check.
- All Zod schemas defined once in the tool modules; derive TS types via
  `z.infer<>`. Never hand-write a type that a schema already defines.
- Money is `number` (integer paise) at boundaries — validated integer via Zod.
  A `formatPaise(paise: number): string` helper produces `₹X,XXX.XX` display
  strings; it is the only place formatting happens.
- Timestamps: ISO-8601 UTC strings everywhere. One helper module (`time.ts`)
  owns `now()` and boot-relative offsets so tests can control the clock.

### B2. Database

- All SQL lives in `src/db/queries.ts` as named prepared statements. Tools
  never contain SQL strings. No string interpolation into SQL under any
  circumstances.
- Every multi-statement mutation is wrapped in `db.transaction(...)`. The audit
  insert is inside the same transaction as the mutation it records.
- Schema changes go in `schema.sql` only. `seed.ts` executes `schema.sql` then
  inserts — it never contains DDL.
- `PRAGMA foreign_keys = ON` at connection open. `PRAGMA journal_mode = WAL`.

### B3. Tool implementation pattern

Every tool handler is registered through the `instrumented()` wrapper
(`src/instrument.ts`), which owns:
- `requestId` (uuid) generation
- pino log line: `{requestId, toolName, actor, input, durationMs, outcome}`
- catch-all: unexpected errors → generic client message + full server-side log

Handlers themselves are pure-ish: parse (Zod does it via SDK) → query/mutate
via `queries.ts` → shape output → return. No handler exceeds ~60 lines; extract
helpers.

### B4. Errors

One error shape everywhere:
```typescript
{ error_code: string; message: string; hint: string }
```
`error_code` is machine-stable snake_case (`unknown_proposal`,
`already_executed`, `stale_proposal`, `amount_exceeds_refundable`,
`amount_exceeds_cap`, `invalid_action_for_state`, `no_action_needed`,
`not_found`, `invalid_input`). `hint` always tells the agent the correct next
tool call. Returned with `isError: true` per MCP spec — never thrown across
the transport.

### B5. Logging (pino)

- JSON to stdout only (Railway captures it). Pretty-printing is a local dev
  script concern (`pino-pretty` in `npm run dev`), never in production code.
- One `info` line per tool call (from the wrapper), one `error` line per
  unexpected failure. Do not log inside handlers except `warn` for rejected
  writes.
- Levels: `info` = tool calls + boot events; `warn` = rejected writes;
  `error` = unexpected only.

### B6. Testing (Vitest)

- Test DB = in-memory SQLite, seeded by the same `seed.ts` (export a
  `createDb(path | ':memory:')` factory — production and tests share one seed
  path, so tests verify the real fixtures).
- The safety tests specified in PLAN.md §Verification are written **before**
  `execute_resolution` is implemented.
- No mocking of the DB layer. Mock nothing that can run for real in-memory.
- Every test name states behavior, not implementation:
  `"rejects execution of an already-executed proposal"`.

### B7. Repo hygiene

- Conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`), small and
  phase-aligned — the commit history is evidence of working method.
- `.env.example` with every env var documented. `.env` gitignored.
- `npm run` scripts: `dev`, `build`, `start`, `test`, `typecheck`, `seed`.
- README structure (write last, from these docs): What/Why · Architecture ·
  Tool reference · Safety model · Known limitations · Scaling path ·
  Setup/Connect instructions · Test instructions · Demo scenarios cheat-sheet.
