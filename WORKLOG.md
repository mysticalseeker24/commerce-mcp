# WORKLOG.md — AI-assisted build log

Filled in **during** the build, not reconstructed afterwards. Covers: which model
and tool did what, the context strategy, AI suggestions I rejected and why, and the
evidence behind each verification claim.

---

## Entry 1 — Context strategy: the spec is the prompt

**Phase:** 0 (before any code existed)

The single highest-leverage thing I did was write the spec before writing the
prompt. `.agent/` is not documentation produced after the fact — it *is* the context
supplied to Claude Code, authored first and treated as authoritative:

| Doc | Role |
|---|---|
| [`.agent/SPEC.md`](.agent/SPEC.md) | Product scope, architecture, data model, the seeded failure scenarios |
| [`.agent/TOOLS.md`](.agent/TOOLS.md) | Exact MCP tool surface — names, schemas, and the agent-facing description copy |
| [`.agent/CONVENTIONS.md`](.agent/CONVENTIONS.md) | Threat model and coding rules, stated as hard requirements |
| [`.agent/PLAN.md`](.agent/PLAN.md) | Build order, phase gates, the verification checklist |
| [`CLAUDE.md`](CLAUDE.md) | Loader — tells Claude Code to read the four in order, and restates the never-violate constraints |

Two properties of this set matter more than its length:

1. **Tool descriptions are marked as product copy, not paraphrasable.** The
   `description` strings are the primary UX of an MCP server — they are what the
   model reads to decide whether and how to call a tool. Letting a coding agent
   "improve" them would silently change the product.
2. **Each rule states its rationale.** `CONVENTIONS.md` explains *why* prepared
   statements (not Zod) are what prevents SQL injection, so the constraint survives
   contact with a situation the doc didn't anticipate.

Working style: Claude Code (Opus 5) in plan mode for design and phase planning,
then execution against approved plans with a hard stop at every phase gate. Plan
mode did real work here — three of the decisions below were caught before a line of
code was written.

---

## Entry 2 — Spec deviation: Zod 4 instead of the v3 idioms in TOOLS.md

**Phase:** 0 · **Status:** approved deviation from a locked doc

`TOOLS.md` is marked *locked — implement verbatim*, and its schemas are written in
Zod 3 idioms. The current MCP SDK (1.30.0) accepts `zod: ^3.25 || ^4.0`, so both
were viable. Pinning Zod 4 means three of the locked schema expressions cannot be
copied literally, because they are deprecated in v4:

| `TOOLS.md` (v3 idiom) | Implemented as (v4) |
|---|---|
| `z.object({...}).strict()` | `z.strictObject({...})` |
| `z.string().email()` | `z.email()` |
| `z.string().datetime()` | `z.iso.datetime()` |

Everything else — regexes, enums, `.min`/`.max`/`.int`/`.nonnegative`/`.positive`,
`.default(20)`, `.optional()`, `.refine()`, and **every `.describe()` string** — is
unchanged. The deviation is syntactic; the validation semantics and the agent-facing
copy are identical.

Decision: Zod 4 only, v4-native APIs, never importing `zod/v3`. Recorded here rather
than silently absorbed, because "locked doc" should mean an explicit amendment trail
rather than quiet drift.

---

## Entry 3 — The auth finding: a deployment failure that didn't happen

**Phase:** 0, before the first Railway deploy · **This is the entry I'd point at.**

`SPEC.md` §2 specifies a bearer token on every request. The obvious move is to
implement that and deploy. Instead I checked how Claude *actually* authenticates to
a remote MCP server, because the Phase 2 gate depends on connecting from claude.ai
specifically, and a spec I wrote myself is not evidence about someone else's client.

**What the docs say.** The [connector authentication
reference](https://claude.com/docs/connectors/building/authentication) lists the
supported auth types with an availability column:

> `static_headers` — Fixed credential (API key or bearer token) entered by an
> organization administrator as a request header when adding the connector —
> **Availability: Beta**

Meanwhile [Claude Code's MCP docs](https://code.claude.com/docs/en/mcp) document
header auth as fully supported:
`claude mcp add --transport http secure-api https://… --header "Authorization: Bearer …"`.

**Why that matters.** The risk was never "headers aren't supported" — my first read
of a different support article suggested that, and it was wrong. The real risk is
narrower and worse: header auth on claude.ai is **beta and gated behind an
organization-administrator entry path**. A header-only server would work perfectly
from Claude Code and might be unconnectable from claude.ai depending on the org's
rollout — including the evaluator's org, which I cannot observe.

**What I changed.** Auth became dual-path before any deployment existed: the
`Authorization: Bearer` header always, plus an optional tokenized URL path
(`/mcp/<token>`) as a header-independent fallback. Both verify the same shared token
via constant-time comparison of SHA-256 digests.

**The counter-evidence, recorded because it cuts the other way.** The same page
argues against the fallback:

> Tokens or API keys passed in the connector URL … are **not recommended**. A
> credential in a URL is a security vulnerability: URLs are routinely recorded in
> server logs, proxies, and browsing history … The MCP authorization specification
> explicitly prohibits access tokens in the URI query string.

Our fallback uses a **path segment**, not a query parameter, so it falls outside
that clause's literal text — but squarely inside its reasoning. On a project graded
on its safety model, shipping that unconditionally would be a self-inflicted finding.

**Resolution — the flag splits by environment, deliberately.** The URL-path route is
gated behind `ALLOW_URL_TOKEN` and is **not mounted** when unset (a 404, not a 401 —
the shape isn't even advertised). Phase 2 tries claude.ai's header auth *first* and
records which path was actually needed. The **submission** deployment then sets
`ALLOW_URL_TOKEN=true` regardless of that result, because the evaluator's rollout is
unobservable and a demo that cannot connect is a worse failure than a documented,
deliberately-enabled fallback. The submission email offers both methods with the
header path recommended; `CONVENTIONS.md` §A2.5 states the tradeoff in the
limitations list rather than burying it.

**Why this is the entry worth reading:** it cost one round of documentation research
in Phase 0 and prevented a class of failure — "the hosted server won't connect from
the evaluator's client" — that would have surfaced at hour four with no time to fix
it. It also produced two honest artifacts: a named limitation and a test asserting
the route is absent by default.

*Correction recorded in-flight:* my first pass at this entry claimed claude.ai
documents no custom-header support at all, based on a support article that only
mentions OAuth. That was wrong — the developer docs do document `static_headers`.
The finding survived; the claim strength changed from "absent" to "beta and
org-gated." Logged because getting the evidence right mattered more than the entry
sounding decisive.

---

## Entry 4 — Client redirect absorbed mid-build

**Phase:** between 0 and 1 · **Rework: ≈40 min**

The client narrowed execution scope after the build had started: payment-processor
actions become diagnostic-only, and execution is permitted **solely** for a
policy-eligible order refund under six named constraints. Everything else becomes an
evidence-bearing escalation.

**What survived unchanged: the propose→execute skeleton.** That is the whole story
of why this was cheap. The write path was already a two-stage gate with a stored
proposal, a staleness snapshot, a conditional-update idempotency guard, and audit
rows on both branches. Narrowing *what may be executed* did not touch any of that.

**What actually changed:**

| Before | After |
|---|---|
| Six executable actions | Two: `refund \| escalate` |
| `retry_refund` | Removed entirely — it is a processor mutation |
| Action/state compatibility matrix | Six-check policy engine (`src/policy.ts`) |
| Escalation = a recorded recommendation | Escalation = a row with an auto-assembled evidence packet |
| 8 fixtures | 11 — three new ones so each policy check has its own failure case |

The rework was confined to Phase 1 fixtures and Phase 4 semantics. Had the write
path been a direct-mutation tool with per-action branches, this same redirect would
have meant rewriting the mutation surface itself. The gate is what made the change
cheap — an argument for the architecture that I did not have to make hypothetically.

**Judgment call worth naming:** an ineligible refund request returns an *executable
escalation proposal*, not an error. Refusing outright would leave the analyst with
nothing to do and push them back toward the engineering ticket this product exists
to eliminate. `no_action_needed` stays an error, because a healthy order genuinely
needs no action.

---

## Entry 5 — Unconfirmed interpretation, chosen conservatively

The instruction — "gated execution is appropriate only for an eligible order
refund … otherwise create a manager-approval escalation" — is genuinely ambiguous
for order-system actions that never touch the payment processor: confirming a
paid-but-failed order (ORD-1001), cancelling an unpaid one (ORD-1005), releasing an
orphaned hold (ORD-1004). None of these move money. A reasonable reading permits
them; a strict reading does not.

**Chose the strict reading: those escalate too.** Rationale: in an operational tool
wired to a language model, under-executing is the safer error. An escalation still
produces a recorded, actionable artifact for the analyst, so the cost of being wrong
in this direction is a slower resolution — versus an unauthorized state change if
wrong in the other.

The client did not confirm this. It is documented as an assumption in the README and
CONVENTIONS.md A2.6 rather than silently resolved, because the distinction between
"the client said this" and "we inferred this" is exactly what a reviewer needs to
audit. The loose reading is a two-line change to the action enum plus its
state-machine branches.

---

## Entry 6 — Currency migration, not currency conversion

Switched INR/paise to USD/cents to match the units the client's policy is written
in. The alternative — keeping paise and converting the $150.00 cap to an approximate
rupee constant — was rejected outright: it would make a **policy bound** an
approximation, and every eligibility decision at the boundary would inherit that
rounding error.

Done at the Phase 0/1 seam, before fixtures were final, which is the cheapest moment
it could have happened. Touched every `*_cents` field name across schema, tool
outputs, cursors and tests; replaced `formatPaise`/`en-IN`/`₹` with
`formatCents`/`en-US`/`$`; regenerated healthy-order amounts into a plausible
$9.99–$499.00 range.

Deliberately *not* changed: customer names and emails stay Indian. They carry no
semantics for the model, and churning them would have produced a large diff with no
information in it.

---

## Entry 7 — `action_key`: a refinement the spec didn't ask for

Check 6 is stated as "no refund already exists for the same eligible action." That
sentence contains an undefined term — *same action* — and the definition is not
cosmetic. ORD-1007 carries a prior, unrelated $50.00 partial refund. Under the naive
reading ("this order already has a refund"), the legitimate $30.00
carrier-exception refund would be falsely blocked, and the one executable fixture in
the entire product would not execute.

Defined `action_key = refund:<order_id>:<carrier_exception_id>`, stored on
`proposals` and `audit_log` and enforced by:

```sql
CREATE UNIQUE INDEX audit_log_action_key_executed
  ON audit_log(action_key) WHERE action_key IS NOT NULL AND outcome = 'success';
```

Two consequences worth stating. The duplicate check becomes **precise** — it asks
"has *this specific remedy* already been paid?" rather than "has anything been
refunded here?" And idempotency becomes **mechanical**: a partial unique index means
a duplicate refund is refused by the database even if every application-level guard
were bypassed. That is a stronger guarantee than a check, because it does not depend
on the check running.

The partial predicate (`outcome = 'success'`) matters too — without it, a rejected
attempt would occupy the key and permanently block the legitimate retry.

---

## Entry 8 — Diagnostics ambiguity surfaced, not silently resolved

**Phase:** 1 gate · **Second instance of the pattern in [Entry 5](#entry-5).**

Reading the Phase 1 fixture dump turned up a case the spec doesn't decide:
**ORD-1001 has an `active` inventory hold on a `failed` order.** ORD-1004 —
the designated orphaned-hold fixture — has an `active` hold on a `cancelled`
order. So does `ORPHANED_HOLD` fire on ORD-1001 too?

It matters because Tier-1b asserts one flag per fixture. The tempting resolution is
the test-convenient one: scope `ORPHANED_HOLD` to `cancelled` so ORD-1001 stays
cleanly `CAPTURED_BUT_FAILED` and the checklist passes. That would be fitting the
definition to the test — the diagnostic would mean "whatever keeps the suite green."

Surfaced it at the gate instead of picking. Adjudicated on the semantics:

> **`ORPHANED_HOLD` means a hold that can never be consumed** — inventory held
> against an order that has reached a terminal state and will never ship.

Under that definition `cancelled` qualifies and `failed` does not, because a failed
order can be confirmed and go on to consume its hold — which is exactly ORD-1001's
correct remedy. ORD-1001's active hold is *pending*, not orphaned. The scoping falls
out of the definition rather than the definition being reverse-engineered from the
scoping, and it survives contact with a case neither of us has thought of yet.

The distinction worth recording is not the answer but the sequence: the ambiguity
was raised before any code committed to a reading, and it was settled on a principle
that generalizes. Same shape as Entry 5 — AI escalates, human adjudicates, the
reasoning goes in writing.

---

## Entry 9 — A latent correctness bug found by implementing, not by testing

**Phase:** 2, first hour · **Third escalate-then-adjudicate instance**

Writing `refundable_cents` for `get_order_timeline` surfaced something the spec, the
fixtures, and 39 passing tests had all missed: **the schema could not represent a
partial refund.**

`payments` modelled refunds as a status flip, `captured → refunded`. One row, one
status, one amount. So:

- ORD-1007's prior $50.00 goodwill adjustment existed only as an `order_events` row.
  `refunded_total_cents` computed to $0, and the $30.00 discrepancy the entire
  scenario turns on did not arise from the data at all.
- Worse, and generally: executing ORD-1007's $30.00 refund would set
  `PAY-2008.status = 'refunded'` on a **$200.00** capture — asserting the whole
  $200.00 came back. The product's one executable action is a partial refund, and
  the data model could not express one.

The second point is what made this worth stopping for. The first is a fixture
inconvenience; the second is a money bug that would have shipped, passed every test
written so far, and been visible only to someone reading the payment row afterwards.

**Adjudicated:** add `payments.refunded_cents INTEGER NOT NULL DEFAULT 0` with
`CHECK (refunded_cents >= 0 AND refunded_cents <= amount_cents)`.
`refundable_cents = amount_cents − refunded_cents`. Execution *increments* it rather
than overwriting status. Semantics fixed deliberately: it counts refunds settled
**or in flight**, matching SPEC's "captured minus already refunded/initiated" — which
is why ORD-1003's never-settled $89.50 leaves $0 refundable rather than looking
available to refund twice.

Two smaller notes worth keeping:

- I proposed this as a fixture change and **asked before touching approved
  fixtures**, per the hard constraint. The alternatives considered — a second
  `payments` row denoting the refund, or a fully normalised `refunds` table — are
  recorded in the decision; the column won because it is the smallest change that
  makes the failure impossible rather than merely detected.
- The change immediately caused a real failure: I dropped `payment.method` from the
  8-column INSERT, and `beforeAll` threw. `better-sqlite3`'s `.run()` is variadic, so
  **typecheck could not catch it** — the test suite did, by failing to build a
  database at all. A reminder about where each guard's coverage actually ends.

---

## Entry 10 — The deploy that failed, and why deploying early was the point

**Phase 2 gate.** PLAN.md §Phase 2 says *"Deploy to Railway now, not at the end —
deploy problems found at hour four are fatal."* This is that clause earning its
keep.

First Railway build failed:

```
npm error path /app/node_modules/better-sqlite3
npm error command sh -c node-gyp rebuild
npm error gyp ERR! find Python  Could not find any Python installation to use
```

**Diagnosis, rather than guessing.** The tempting reading is "Railway lacks Python,
add Python." I checked why the two environments diverged instead, and the answer
changed the fix:

| Question | Finding |
|---|---|
| Does the package need compiling? | No. `better-sqlite3@13` ships prebuilt Node-API binaries for eight platforms including `linux-x64`. |
| Did my machine compile it? | No `build/` directory exists locally — the runtime loads the shipped prebuild. |
| Then why did npm invoke node-gyp? | `binding.gyp` is present in the tarball, and npm's implicit rule runs `node-gyp rebuild` for any package containing one with no explicit install script — despite the package publishing `gypfile: false`. |

So installing Python and a C++ toolchain would have "worked" while trading a
multi-minute compile on every deploy for a binary that was already in the package.
The right fix was `npm ci --ignore-scripts`, verified locally: 237 packages, no
`build/` directory, module opens a database, 89 tests still green.

**A second failure was queued behind the first.** The log carried
`npm warn config production`, meaning Railway sets `NPM_CONFIG_PRODUCTION=true` and
omits devDependencies. Fixing only the gyp error would have produced a fresh failure
one step later, when `npm run build` could not find `tsc`. Reading the whole log
rather than the error line caught it before a second failed deploy.

**A third thing the fix had to account for:** `railway.json`'s `buildCommand` cannot
resolve any of this, because the failure is in Nixpacks' *install* phase, which only
`nixpacks.toml` governs. The original `buildCommand` was removed too — left in place
it would have run a second, script-enabled `npm ci` and reproduced the bug after
`nixpacks.toml` had fixed it.

**What this cost:** one failed build, roughly fifteen minutes, at a point where
there is time to absorb it. Had the first deploy been attempted after Phase 5, the
same three-layer problem would have surfaced with the submission deadline in view.
The configuration now lives in the repo with its reasoning inline, so it is
reproducible rather than dashboard folklore.

---

## Entry 11 — Verification evidence

### Phase 0 — the toolchain gate, and why it was worth running

The Phase 0 gate is "typecheck passes on the skeleton", which sounds like a
formality. Running it properly surfaced a hard blocker that would otherwise have
detonated in Phase 1, when the seed first opens a database.

**The gate is not vacuous.** Before trusting a green typecheck, I checked it could
go red: dropping `const x: string = 42` into `src/` produced
`error TS2322: Type 'number' is not assignable to type 'string'`, and `tsc
--listFilesOnly` confirmed 416 files in the program. A gate that cannot fail is not
evidence.

**Three independent signals, one cause — Node 23.5.0.**

| Signal | Detail |
|---|---|
| `npm install` crashed | `TypeError: Cannot read properties of null (reading 'edgesOut')` in arborist's `#loadPeerSet` while resolving vitest's peer graph — an npm 11.3.0 bug. Re-running under npm 12.0.2 installed all 188 packages cleanly. |
| `vitest@4.1.10` engines | `^20.0.0 \|\| ^22.0.0 \|\| >=24.0.0` — Node 23 is *explicitly excluded*, not merely untested. |
| `better-sqlite3@13.0.2` **segfaults** | Module loads, then `new Database(':memory:')` exits `0xC0000005` (access violation) with no JS-level error. |

The segfault is the real blocker. The package ships eight prebuilt Node-API binaries
(`prebuilds/win32-x64.node` among them) and has `gypfile: false` with no install
script, so nothing is compiled locally — which is why I expected the ABI-stable
prebuild to work on any modern Node and why the crash is worth recording rather than
shrugging at. Node 23 is an odd-numbered, now-EOL line; the pin to Node 24 LTS was
already the plan, and this is the empirical justification for it.

**What still works on Node 23**, and therefore what Phase 0 could legitimately
close: `tsc` is pure JavaScript, so `npm run typecheck` passes; vitest loads and
reports "No test files found" as expected. Only the native module is affected.

**Corrected assumption, recorded.** I predicted from `gypfile: false` +
`node-addon-api` that the Node major wouldn't matter for the native build. That
prediction was wrong, and the probe is what caught it — a reminder that "N-API is
ABI-stable" is a claim about the interface, not a guarantee that any given binary
runs on any given runtime.

### Phase 2/3 — verified against the hosted server, not just locally

`https://commerce-mcp.up.railway.app` · seedVersion 2.0.0 · 250 orders

A green local suite says nothing about whether transport, auth middleware, and tool
registration compose behind a load balancer. Every check below ran against the
deployed instance over HTTPS:

| Check | Result |
|---|---|
| `GET /health` unauthenticated | `{"status":"ok","seedVersion":"2.0.0","orderCount":250}` |
| `POST /mcp` no token / wrong token | 401, 401 |
| `GET /mcp` | 405 with `Allow: POST` |
| `tools/list` | 5 tools, descriptions intact |
| ORD-1007 | `discrepancy_cents: 3000`, `PARTIAL_REFUND_GAP`, eligible, **6/6 checks pass**, `$150.00` refundable |
| ORD-1009 | ineligible, `first_failure: amount_within_cap`, evidence *"$180.00 exceeds the $150.00 per-resolution cap"* |
| ORD-1008 | note verbatim inside the wrapper, zero flags, and **the string appears nowhere else in the payload** |
| `search_orders` | 3 of 127 delivered, `next_cursor` present |
| Unknown order | `isError: true`, `not_found`, hint naming `search_orders` |

**An environment obstacle worth recording, because working around it produced
better evidence.** My sandbox's DNS resolver refuses `railway.app`
(`getaddrinfo ENOTFOUND` from two independent code paths), while Google DNS
resolved the host fine — so the block was local, not a broken deploy. Rather than
declaring it unverifiable, I pinned the resolved address with `curl --resolve` and
drove the MCP endpoint with raw JSON-RPC. That turned out to be *stronger*
verification than the SDK client would have given: it proves the server speaks the
wire protocol correctly, including the SSE framing and the
`Accept: application/json, text/event-stream` negotiation, rather than proving only
that our own client library agrees with our own server.

**Configuration note.** `ALLOW_URL_TOKEN` is enabled on the deployment. Verified
directly: `POST /mcp/<token>` returns a real `tools/list`, and `/mcp/<wrong-token>`
returns 401 rather than 404. That is the intended *submission* configuration
(entry 3), reached earlier than planned — so the Phase 2 experiment of testing
claude.ai's header auth against an unmounted fallback no longer runs cleanly. The
header path remains the recommended one in the submission email.

### The auth hedge paid off — empirical result

[Entry 3](#entry-3--the-auth-finding-a-deployment-failure-that-didnt-happen) built a
second auth path in Phase 0 on the strength of a documentation table saying
`static_headers` was Beta. Connecting claude.ai settled the question:

> **Couldn't register with Commerce MCP's sign-in service.** You can try again, or
> add an OAuth Client ID in the connector settings.

Header auth was **not available** on a standard account. With no way to attach the
header, claude.ai hit our `401`, fell back to OAuth discovery, found no
authorization server, and failed at Dynamic Client Registration.

Two things worth separating here, because they are different failures:

1. **The predicted one.** Header-only auth would have left the server
   unconnectable from claude.ai — exactly the failure Phase 0 hedged against, and
   the reason the tokenized URL path exists. Switching the connector to
   `/mcp/<token>` connects immediately; the request authenticates on its first hop,
   so no `401` is returned and no auth negotiation ever begins. Verified against
   the deployed server: a bare `initialize` on that path returns a full handshake.

2. **One I had not predicted, and it was mine.** Our `401` carried no
   `WWW-Authenticate` header. RFC 6750 §3 says a bearer-protected resource *should*
   send one, and the omission is not cosmetic: a client with no challenge to read
   has to guess, and claude.ai guesses OAuth. Fixed — the `401` now returns
   `WWW-Authenticate: Bearer realm="commerce-ops-mcp"`, deliberately **without** a
   `resource_metadata` parameter, since that parameter is what advertises an OAuth
   authorization server and this server has none.

The honest scorecard: the hedge was correct and saved the demo, but the underlying
protocol defect was in our server, not only in the client's rollout state. Both are
recorded because the second one is the part I would have missed if the first had
simply worked.

## Entry 12 — Rejected AI suggestions

### Prose-parsing the refund amount out of event text

**Phase 2. My own first draft, caught by the Tier-1b tests.**

`discrepancy_cents` needs to know the value of goods that came back. I wrote
`returnedValueCents()` to regex `$([\d,]+\.\d{2})` out of `order_events.detail`,
scanning `return_received`, `damage_verified`, and `lost_in_transit` events. It
typechecked, it read plausibly, and I shipped it into `get_order_timeline`.

Four Tier-1b tests failed immediately, and the failures exposed two independent
defects:

1. **The amount is on a different event type per scenario.** ORD-1007 and ORD-1010
   record the value on `return_initiated` ("valued at $80.00"); their
   `return_received` events carry no figure at all. So the parse returned 0, the
   discrepancy went *negative*, and ORD-1007 — the single executable case in the
   product — evaluated eligibility against the full $150.00 refundable instead of
   the $30.00 gap.
2. **ORD-1009 records the value twice**, on `damage_reported` and `damage_verified`.
   A parse that had matched both event types would have silently double-counted to
   $360.00.

The tempting fix was to widen the event-type set and dedupe. Rejected: that keeps a
**money figure dependent on how a sentence was worded**, and this figure directly
determines what the product refunds. Any future copy edit to a seed string would
change a payout.

**Replaced with structured data:** `carrier_exceptions.claim_value_cents`. The
carrier exception is what justifies a refund, so the amount it accounts for belongs
on that row. Verified exceptions contribute; unverified ones contribute nothing,
because an unconfirmed claim is not a debt. All four tests passed without touching
the assertions.

Worth noting *why the tests caught it*: they assert `discrepancy_cents === 3000` and
`first_failure === "customer_risk_below_threshold"` — properties of the **domain**,
not of the implementation. A test written as "returnedValueCents parses the detail
string" would have passed against the broken design.

## Entry 13 — Remaining risks and next steps

*(feeds the README section of the same name)*
