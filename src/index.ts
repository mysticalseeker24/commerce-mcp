/**
 * Express app, auth middleware, MCP transport wiring, /health.
 *
 * Routes:
 *   GET  /health          — the only unauthenticated route. Leaks nothing beyond
 *                           { status, uptime, seedVersion, orderCount }.
 *   POST /mcp             — Authorization: Bearer <token>. Always mounted.
 *   POST /mcp/<token>     — mounted only when ALLOW_URL_TOKEN=true. See
 *                           CONVENTIONS.md A2.5.
 *   GET|DELETE on either  — 405 with `Allow: POST`. The stateless transport
 *                           supports neither the SSE stream nor session teardown,
 *                           so a probing client gets a definite answer.
 *
 * A new StreamableHTTPServerTransport is created per request — no session state.
 *
 * Populated in Phase 2.
 */
import type { Express } from "express";
import type { Env } from "./env.js";

export function createApp(_env: Env): Express {
  throw new Error("createApp is not implemented yet — see PLAN.md Phase 2");
}
