# Deploying to Railway

Phase 2 deploys early on purpose: the assignment is judged on a *hosted* server, and
a deploy problem found at hour four is fatal.

## 1. Create the service

Railway → New Project → Deploy from GitHub repo → `mysticalseeker24/commerce-mcp`.
`railway.json` already pins the build and start commands and points the healthcheck
at `/health`, so no dashboard build config is needed.

## 2. Generate a token

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## 3. Set variables

| Variable | Value | Notes |
|---|---|---|
| `MCP_BEARER_TOKEN` | the generated token | **Required.** The server crashes at boot without it — deliberately, so a misconfigured deploy fails loudly instead of serving unauthenticated. |
| `NIXPACKS_NODE_VERSION` | `24` | Matches `.nvmrc`. better-sqlite3 segfaults on Node 23; see WORKLOG entry 9. |
| `DB_PATH` | `/tmp/commerce.db` | Disposable by design — dropped and reseeded every boot. |
| `LOG_LEVEL` | `info` | |
| `ALLOW_URL_TOKEN` | leave unset for now | See step 5. |

`PORT` is injected by Railway; do not set it.

## 4. Verify the deploy

```bash
curl https://<your-app>.up.railway.app/health
# {"status":"ok","uptime":3,"seedVersion":"2.0.0","orderCount":250}

npm run smoke -- https://<your-app>.up.railway.app "<token>"
# runs the same 21 checks used locally, against the hosted server
```

The smoke script is the real gate. A green vitest run says nothing about whether the
transport, auth middleware, and tool registration compose correctly behind a load
balancer.

## 5. Connect a client

**Claude Code — the recommended path.** Header auth is fully supported here.

```bash
claude mcp add --transport http commerce-ops https://<your-app>.up.railway.app/mcp \
  --header "Authorization: Bearer <token>"
claude   # then /mcp to confirm it shows "connected"
```

**claude.ai — try header auth first.** Settings → Connectors → Add custom connector →
URL `https://<your-app>.up.railway.app/mcp`, and enter the bearer token as a request
header if your organization has that option.

Claude's [connector auth reference](https://claude.com/docs/connectors/building/authentication)
lists `static_headers` — a fixed API key or bearer token entered by an organization
administrator — as **Beta**. If it isn't available on the account:

1. Set `ALLOW_URL_TOKEN=true` on Railway and redeploy.
2. Use `https://<your-app>.up.railway.app/mcp/<token>` as the connector URL.

That fallback is off by default and is a documented tradeoff, not an oversight —
credentials in URLs reach proxy logs and browser history. See CONVENTIONS.md A2.5.
The header path stays the recommendation.

## 6. Confirm end to end

Ask the connected client:

> What happened with ORD-1007?

Expect it to call `get_order_timeline`, report the $30.00 gap, and note that the
order is refund-eligible. Then:

> And ORD-1002 — the customer says they were charged twice.

Expect it to identify the duplicate capture and **not** propose a refund, because
payment-processor state is diagnostic-only.

## Notes

- **Reseed on boot.** Every deploy and restart rebuilds the database from
  `seed.ts`. Evaluators can execute destructive actions freely; a redeploy
  self-heals. Nothing is persisted between restarts, and nothing needs to be.
- **Single instance.** The transport is stateless, but each instance would hold its
  own SQLite file. Real horizontal scaling comes after the SQLite → Postgres step in
  SPEC.md §2.2 — do not scale replicas above 1.
