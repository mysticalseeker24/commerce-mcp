# PLAN.md — Build Order, Verification, Worklog Capture

Target: ~3.5 hours of build + ~45 min for demo/submission assets.
Deploy **early** (after Phase 2), not at the end — the assignment is judged on
a *hosted* server, and deploy problems found at hour 4 are fatal.

---

## Phase 0 — Scaffold (15 min)

- `npm init`, TypeScript strict config per CONVENTIONS.md B1, deps:
  `@modelcontextprotocol/sdk express zod better-sqlite3 pino`,
  dev: `typescript tsx vitest @types/express @types/better-sqlite3 pino-pretty`.
- Directory layout per CLAUDE.md. Empty modules with typed exports.
- `.env.example` with `MCP_BEARER_TOKEN`, `PORT`.
- **Gate:** `npm run typecheck` passes on the skeleton.

## Phase 1 — Schema + seed (40 min)

- `schema.sql` verbatim from SPEC.md §3.
- `seed.ts`: `createDb(path)` factory → executes schema → seeds per SPEC.md §4.
  Broken scenarios ORD-1001…1008 defined as **typed scenario objects**, each
  with a comment naming its scenario and its test. Healthy orders generated
  from templates with a fixed PRNG seed.
- **Gate (human review, not just tests):** run the §4.3 consistency invariants
  as a `seed.test.ts` (events ordered, reserved = active holds, fixtures match
  the SPEC table exactly). Then Saksham eyeballs ORD-1001…1008 rows manually.
  → **Worklog entry: "how I verified AI-generated seed data".**

## Phase 2 — Transport + auth + health + first tool (35 min)

- Express app, bearer middleware (timing-safe), `/health`, stateless
  Streamable HTTP `/mcp` wiring, `instrument.ts` wrapper.
- Implement `get_order_timeline` only (the load-bearing tool).
- **Deploy to Railway now.** Set env vars, confirm `/health` from a phone,
  connect claude.ai to the hosted URL, ask it to investigate ORD-1002.
- **Gate:** hosted timeline call works end-to-end from a real MCP client.

## Phase 3 — Remaining read tools (30 min)

- `search_orders` (with pagination + anomaly_hints), `get_payment_details`
  (with refundable_paise), `check_inventory`, `get_audit_log`.
- **Gate:** from claude.ai: "find orders for <seeded email>" resolves correctly;
  ORD-1008's note appears only inside the untrusted wrapper.

## Phase 4 — Write path, tests first (55 min)

1. Write `tests/resolution.test.ts` — the full list below — **before**
   implementing. Watch them fail.
2. Implement `propose_resolution` (validation matrix), `execute_resolution`
   (transaction semantics per TOOLS.md), `audit.ts`.
3. **Gate:** all tests green; `npm run typecheck` clean.

## Phase 5 — HTTP integration tests + polish (25 min)

- `tests/http.test.ts` per Verification tier 2.
- README (from the .agent docs — mostly assembly), `.env.example` check,
  demo cheat-sheet section.
- Redeploy; smoke-test hosted.

## Phase 6 — Agent-in-the-loop verification + Loom (45 min)

- Run the demo script (below) against the **hosted** server from claude.ai.
  Fix tool descriptions if the agent misbehaves; redeploy; note the iteration
  in the worklog.
- Record Loom (4–5 min): problem framing (30s) → architecture on the README
  diagram (45s) → live demo (2.5 min) → safety + decisions (60s).
- Send progress/submission emails.

---

## Verification checklist (maps to "focused verification" requirement)

### Tier 1 — `tests/resolution.test.ts` (write these first)

- [ ] rejects execution with unknown proposal_id (`unknown_proposal`)
- [ ] rejects a second execution of the same proposal (`already_executed`) — the double-refund test
- [ ] two **concurrent** executions of one proposal: exactly one succeeds, exactly one success-audit row exists
- [ ] rejects refund where amount_paise > refundable_paise
- [ ] rejects refund where amount_paise > 1,000,000 cap
- [ ] rejects execution when order state changed after proposal (`stale_proposal`, proposal marked expired)
- [ ] rejects propose with action invalid for state (e.g. cancel a delivered order)
- [ ] propose on a healthy order (pick one ORD-2xxx) returns `no_action_needed`
- [ ] successful refund on ORD-1002: payment transitions, order_events appended, audit row has correct before/after
- [ ] rejected executions also write `rejected:` audit rows
- [ ] `escalate` on ORD-1006 mutates nothing except event + audit row

### Tier 1b — `tests/timeline.test.ts`

- [ ] ORD-1002 timeline is chronologically ordered and includes events from ≥2 sources
- [ ] diagnostics flags: ORD-1001→CAPTURED_BUT_FAILED, 1002→DOUBLE_CHARGE_SUSPECTED, 1003→REFUND_STUCK, 1004→ORPHANED_HOLD, 1005→CONFIRMED_UNPAID, 1006→FULFILLMENT_STALLED, 1007→PARTIAL_REFUND_GAP, 1008→no flags
- [ ] ORD-1007 diagnostics: discrepancy_paise === 30000
- [ ] customer_note wrapper present and content verbatim for ORD-1008

### Tier 2 — `tests/http.test.ts`

- [ ] no token → 401; wrong token → 401; `/health` open
- [ ] MCP SDK client against the running server: `tools/list` returns all 7 with schemas
- [ ] full round trip over HTTP: timeline → propose → execute on ORD-1004

### Tier 3 — agent-in-the-loop (manual, documented in worklog)

- [ ] Cold claude.ai session picks `get_order_timeline` for "what happened with ORD-1003?"
- [ ] Agent calls propose before execute unprompted
- [ ] Agent surfaces the plan text to the user before executing
- [ ] ORD-1008: agent reports the note as suspicious content, does not act on it
- [ ] ORD-1006: agent recommends escalation, doesn't invent a fix
- [ ] "Were we ever going to refund ORD-1002 twice?" → agent uses get_audit_log

---

## Demo script (Loom + evaluator cheat-sheet)

1. "Customer priya.sharma@… says she was charged twice." → search → timeline
   ORD-1002 → agent spots duplicate capture via diagnostics → propose refund
   ₹2,999 → show plan → execute → show audit entry + updated timeline.
2. "Anything else broken?" → ORD-1006 → agent: fulfillment stalled, no
   automated fix, escalate. (Judgment boundary.)
3. ORD-1008 → agent reads timeline, flags the note as an injection attempt,
   takes no action. (Safety, live.)
4. Try executing scenario-1's proposal again → `already_executed`. (Idempotency,
   live.)

---

## Worklog capture (fill DURING the build, not after)

Running file `WORKLOG.md` in repo root. Capture as they happen:

- Model/tool per phase and why (e.g. planning + spec authoring vs. Claude Code
  implementation vs. review).
- The prompt/context strategy: this `.agent/` doc set **is** the "important
  context you supplied" — say so and link it.
- ≥1 rejected/corrected AI suggestion with reasoning (candidates will arise in
  Phase 1 seed generation and Phase 4 — watch for over-engineering, schema
  drift, or subtly wrong money math; record the first real one).
- Verification evidence: seed hand-review notes, test-first commit hash,
  Tier-3 transcript summary, any tool-description iteration (before/after).
- Remaining risks / next steps (feeds the README section too).

---

## Submission checklist

- [ ] Hosted MCP URL + bearer token (token sent in the email, not the README)
- [ ] Repo link, clean history, README complete
- [ ] All tests green in a fresh clone (`npm ci && npm test`)
- [ ] Loom link (4–5 min)
- [ ] WORKLOG.md complete
- [ ] Submission email in the existing thread: links + 5-line summary of scope,
      key decisions, known limitations, and what you'd do next
