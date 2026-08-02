# Progress email — DRAFT, not sent

Phase 2 gate exit item. Review and edit before sending; reply in the existing
thread. **The token below is a live credential — check it is the one you want to
share, and rotate it via the Railway variable if this draft has been circulated.**

---

**Subject:** Re: Take-home — commerce ops MCP server, hosted and working

Hi <name>,

Quick progress update. The server is deployed and the read path is complete; the
gated write path is what I'm building now.

**Hosted:** `https://commerce-mcp.up.railway.app`
**Bearer token:** `897e29b4ae8abde9b277477d3d8a9dc2344d5cef2e0990efe886ad52e7ab5d5c`
**Repo:** https://github.com/mysticalseeker24/commerce-mcp

Two ways to connect, header auth preferred:

1. **Claude Code** — `claude mcp add --transport http commerce-ops https://commerce-mcp.up.railway.app/mcp --header "Authorization: Bearer <token>"`
2. **claude.ai** — add a custom connector with this URL and leave the auth fields
   empty:
   `https://commerce-mcp.up.railway.app/mcp/897e29b4ae8abde9b277477d3d8a9dc2344d5cef2e0990efe886ad52e7ab5d5c`

   Header auth is the better channel and works in Claude Code, but claude.ai's
   `static_headers` support is still Beta and gated behind an org-admin flow. On a
   standard account claude.ai can't attach the header, so it falls back to OAuth
   discovery and fails with "couldn't register with the sign-in service" — there's
   no OAuth server here, just one shared token. The tokenized URL authenticates on
   the first hop, so that negotiation never starts. It's a documented tradeoff
   rather than an oversight (credentials in URLs reach proxy logs), and it's in the
   repo's known-limitations list.

Sanity check without any client:

```
curl https://commerce-mcp.up.railway.app/health
```

**What works now.** Five read tools: `search_orders`, `get_order_timeline`,
`get_payment_details`, `check_inventory`, `get_audit_log`. The data is 250 synthetic
orders, of which eleven are deliberately broken in different ways.

Worth trying if you want to poke at it early:

- *"What happened with ORD-1007?"* — a verified return leaving a $30.00 gap. The
  timeline shows the arithmetic and reports the order as refund-eligible.
- *"And ORD-1002 — the customer says they were charged twice."* — two $299.00
  captures against a $299.00 order. The correct behaviour is an evidence-bearing
  escalation, not a refund: payment-processor state is diagnostic-only in this
  design.
- *"Anything odd about ORD-1008?"* — the customer note contains a prompt-injection
  attempt. It surfaces only inside an explicitly untrusted wrapper and the order is
  otherwise healthy.

**What's next.** The two write tools, `propose_resolution` and
`execute_resolution` — a proposal step that mutates nothing, then a gated execution
that re-evaluates a six-check refund policy at execute time, writes an audit row
with before/after state in the same transaction, and is idempotent by database
constraint rather than by convention. Then the README, a short walkthrough video,
and the final submission.

**One decision I want to flag now** rather than at the end. The instruction that
gated execution is appropriate only for an eligible order refund is ambiguous for
order-system actions that never touch the payment processor — confirming a
paid-but-failed order, releasing an orphaned inventory hold. I took the strict
reading: those escalate for manager approval rather than executing. Under-executing
seemed the safer error for an operational tool, and an escalation still leaves the
analyst something actionable. If you meant the looser reading, it's a small change
and I'd rather know now.

Thanks,
Saksham
