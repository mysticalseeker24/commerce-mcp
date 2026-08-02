# Deploying to Railway

Phase 2 deploys early on purpose: the assignment is judged on a *hosted* server, and
a deploy problem found at hour four is fatal.

## 1. Create the service

Railway → New Project → Deploy from GitHub repo → `mysticalseeker24/commerce-mcp`.

`nixpacks.toml` pins the install/build/start phases and `railway.json` pins the
deploy settings, so **no dashboard build configuration is needed**. Both files carry
the reasoning inline; the short version is in [Troubleshooting](#troubleshooting)
below, because the first deploy failed on exactly this.

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

**claude.ai — use the tokenized URL.** Settings → Connectors → Add custom connector,
with the token as a path segment and **no** auth configured in the dialog:

```
https://<your-app>.up.railway.app/mcp/<token>
```

Requires `ALLOW_URL_TOKEN=true` on the service.

*Why not header auth here?* Tested, and it does not work on a standard account.
Claude's [connector auth reference](https://claude.com/docs/connectors/building/authentication)
lists `static_headers` — a fixed bearer token entered by an organization
administrator — as **Beta**. Without it, claude.ai has no way to attach the header,
hits our `401`, and falls back to OAuth discovery. The observed failure is:

> Couldn't register with Commerce MCP's sign-in service. You can try again, or add
> an OAuth Client ID in the connector settings.

That is Dynamic Client Registration failing against a server that has no OAuth
authorization server, which is expected — this server authenticates one shared
token. The tokenized URL sidesteps the whole flow: the request authenticates on its
first hop, so no `401` is ever returned and no auth negotiation begins.

If a failed connector is already saved, **delete it before retrying** — it will keep
attempting OAuth.

The header path remains the recommendation *where it is available* (Claude Code,
and orgs with `static_headers` enabled). The URL fallback is a documented tradeoff,
not an oversight: credentials in URLs reach proxy logs and browser history. See
CONVENTIONS.md A2.5.

## 6. Confirm end to end

Ask the connected client:

> What happened with ORD-1007?

Expect it to call `get_order_timeline`, report the $30.00 gap, and note that the
order is refund-eligible. Then:

> And ORD-1002 — the customer says they were charged twice.

Expect it to identify the duplicate capture and **not** propose a refund, because
payment-processor state is diagnostic-only.

## Troubleshooting

### `gyp ERR! find Python  Could not find any Python installation to use`

This killed the first deploy. Two independent problems, both fixed in
`nixpacks.toml` — if you see either again, that file is where to look.

**1. better-sqlite3 tried to compile from source.** Its tarball contains
`binding.gyp`, so npm's implicit rule runs `node-gyp rebuild` even though the
package publishes `gypfile: false`. The Nixpacks image has no Python or C++
toolchain, so it dies at the configure step.

The compile was never needed: better-sqlite3 v13 ships prebuilt Node-API binaries
for eight platforms, `linux-x64` among them, and that is what the runtime loads.
Verified locally — installing with `--ignore-scripts` produces no `build/` directory
and the module still opens a database. Adding Python and a compiler to the image
would also work, but it buys a multi-minute compile on every deploy in exchange for
nothing.

**2. `NPM_CONFIG_PRODUCTION=true`.** Railway sets it, which omits devDependencies —
a second failure queued behind the first, since `tsc` would then be missing and
`npm run build` would fail. `--include=dev` in the install phase handles it in the
repo rather than in dashboard state.

Note that `railway.json`'s `buildCommand` **cannot** fix this: the failure is in the
*install* phase, which only `nixpacks.toml` governs. That is why `buildCommand` was
removed — leaving it would have run a second, script-enabled `npm ci` and reproduced
the bug.

### Build succeeds but the server exits immediately

Check `MCP_BEARER_TOKEN` is set. The server refuses to boot without it, by design —
a misconfigured deploy should fail loudly rather than serve operational tools
unauthenticated.

### `ENOENT ... schema.sql`

`tsc` emits only `.js`; `npm run build` also runs `scripts/copy-assets.mjs` to place
`schema.sql` in `dist/db/`. If you overrode the build command in the dashboard, that
step was probably lost.

## Notes

- **Reseed on boot.** Every deploy and restart rebuilds the database from
  `seed.ts`. Evaluators can execute destructive actions freely; a redeploy
  self-heals. Nothing is persisted between restarts, and nothing needs to be.
- **Single instance.** The transport is stateless, but each instance would hold its
  own SQLite file. Real horizontal scaling comes after the SQLite → Postgres step in
  SPEC.md §2.2 — do not scale replicas above 1.
