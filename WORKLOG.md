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
| [`.agent/SPEC.md`](.agent/SPEC.md) | Product scope, architecture, data model, the 8 seeded failure scenarios |
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

## Entry 4 — Verification evidence

*(filled per phase — seed hand-review notes, test-first commit hash, Tier-3
transcript summary, tool-description iterations)*

## Entry 5 — Rejected AI suggestions

*(the first substantive one gets recorded here; candidates expected in Phase 1 seed
generation and Phase 4 money math)*

## Entry 6 — Remaining risks and next steps

*(feeds the README section of the same name)*
