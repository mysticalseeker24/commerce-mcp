# CLAUDE.md — Commerce Ops MCP Server

## What this project is

A remotely hosted MCP server (TypeScript) that lets a commerce operations analyst
investigate and resolve **payment–order mismatches** through an AI assistant
(Claude/ChatGPT), without depending on engineers. Built as a take-home assignment;
treated as a production system in miniature.

**Core workflow:** ops analyst asks the AI "customer says they were charged but the
order shows failed" → AI investigates via read tools → proposes a resolution →
executes it through a gated, audited write path.

## Read these before writing any code

All authoritative design docs live in `.agent/`. Read them **in this order**:

1. `.agent/SPEC.md` — product scope, architecture, data model, seed scenarios.
   This is the source of truth. Do not deviate from it without asking.
2. `.agent/TOOLS.md` — the exact MCP tool surface: names, Zod input schemas,
   output shapes, and the agent-facing descriptions. Implement these **verbatim**.
   Tool descriptions are product copy — do not paraphrase or "improve" them.
3. `.agent/CONVENTIONS.md` — security model and coding conventions. Every rule
   in it is a hard requirement, not a suggestion.
4. `.agent/PLAN.md` — build order, verification checklist, and what to log for
   the AI worklog.

## Hard constraints (never violate)

- **TypeScript strict mode.** No `any`. No `@ts-ignore`.
- **Only synthetic data.** Everything comes from `src/db/seed.ts`. Never invent
  records outside the seed spec.
- **The 8 broken-scenario orders (ORD-1001 … ORD-1008) are fixtures.** Their IDs,
  states, amounts, and event histories are load-bearing — tests and the demo
  script depend on them. Never change them without explicit approval.
- **Writes only via propose → execute.** There is no tool that directly mutates
  order/payment state. Do not add one.
- **Every mutation writes an audit row** with before/after state snapshots,
  inside the same SQLite transaction as the mutation.
- **All SQL through prepared statements.** No string interpolation into queries,
  ever.
- **Stateless Streamable HTTP transport.** New transport per request; no
  session state in the server. State lives in SQLite only.
- **Reseed on boot.** `seed.ts` drops and rebuilds the database deterministically
  at startup. Timestamps are computed relative to boot time, never hardcoded.
- **Zod 4 only.** Use v4-native APIs (`z.email()`, `z.iso.datetime()`,
  `z.strictObject()`). Never import from `zod/v3`. This supersedes the v3 idioms
  written in `.agent/TOOLS.md`; semantics and `.describe()` copy are unchanged.
  See WORKLOG entry 2.

## Stack (locked — do not substitute)

Node 20+ · TypeScript strict · `@modelcontextprotocol/sdk` (Streamable HTTP) ·
Express · Zod · better-sqlite3 · pino · Vitest · deployed on Railway.

No ORM. No Postgres. No Redis. No frontend. No auth beyond bearer token.
If a library outside this list seems needed, stop and ask first.

## Project layout

```
src/
  index.ts          # Express app, bearer auth middleware, MCP transport wiring, /health
  server.ts         # McpServer instance + tool registration
  tools/read.ts     # search_orders, get_order_timeline, get_payment_details,
                    # check_inventory, get_audit_log
  tools/write.ts    # propose_resolution, execute_resolution
  db/schema.sql     # DDL for all 8 tables
  db/seed.ts        # deterministic seed: ~240 healthy orders + 8 fixed broken scenarios
  db/queries.ts     # all prepared statements live here — nowhere else
  audit.ts          # audit-row writer (called inside write transactions)
  instrument.ts     # tool-call wrapper: requestId, timing, structured pino logs
tests/
  resolution.test.ts  # gating, idempotency, caps, concurrency, staleness
  timeline.test.ts    # event ordering and cross-system completeness
  http.test.ts        # transport: tools/list, auth rejection, full round trip
```

## Working style expected from Claude Code

- Work in the order defined in `.agent/PLAN.md`. Do not skip ahead to tools
  before schema + seed exist.
- Write the Vitest tests for the safety core **before** implementing
  `execute_resolution` (the tests are specified in PLAN.md).
- After each phase, run `npm run typecheck && npm test` and show the output.
- When you make a judgment call not covered by the docs, state it explicitly in
  your response so it can be recorded in the AI worklog.
- Small, reviewable diffs. Do not regenerate whole files to change three lines.
