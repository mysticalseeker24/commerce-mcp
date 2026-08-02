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
 */
import { pathToFileURL } from "node:url";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import type { Logger } from "pino";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadEnv, type Env } from "./env.js";
import { tokenFromAuthHeader, verifyToken } from "./auth.js";
import { createLogger } from "./instrument.js";
import { createMcpServer } from "./server.js";
import { createDb, SEED_VERSION } from "./db/seed.js";
import { createQueries, type Queries } from "./db/queries.js";
import { uptimeSeconds } from "./time.js";

export interface AppDeps {
  env: Env;
  queries: Queries;
  logger: Logger;
}

/**
 * Rewrite a tokenized path before anything logs it.
 *
 * pino's `redact` cannot reach a secret embedded in a URL string, so the path is
 * scrubbed structurally. Both auth transports are covered: the header by redaction,
 * the path by this.
 */
export function redactPath(url: string): string {
  return url.replace(/^\/mcp\/[^/?#]+/, "/mcp/[REDACTED]");
}

function unauthorized(res: Response): void {
  res.status(401).json({
    error_code: "unauthorized",
    message: "Missing or invalid bearer token.",
    hint: "Set an Authorization: Bearer <token> header on the request.",
  });
}

export function createApp(deps: AppDeps): Express {
  const { env, queries, logger } = deps;
  const app = express();
  app.disable("x-powered-by");

  app.use(express.json({ limit: "1mb" }));

  /* ---- /health — open, and deliberately boring -------------------------- */
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      uptime: uptimeSeconds(),
      seedVersion: SEED_VERSION,
      orderCount: queries.countOrders(),
    });
  });

  /* ---- auth ------------------------------------------------------------- */
  // Header takes precedence; the path token is only consulted when the route
  // that carries one is mounted.
  const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
    const headerToken = tokenFromAuthHeader(req.header("authorization"));
    const pathToken = typeof req.params["token"] === "string" ? req.params["token"] : undefined;
    const candidate = headerToken ?? pathToken;

    if (!verifyToken(candidate, env.MCP_BEARER_TOKEN)) {
      logger.warn({ path: redactPath(req.originalUrl), outcome: "unauthorized" });
      unauthorized(res);
      return;
    }
    next();
  };

  /* ---- MCP -------------------------------------------------------------- */
  const handleMcp = async (req: Request, res: Response): Promise<void> => {
    // Stateless: a fresh server AND transport per request, torn down on close.
    const server = createMcpServer({ queries, instrument: { logger } });
    // Stateless mode = no sessionIdGenerator. The SDK docs write this as an explicit
    // `sessionIdGenerator: undefined`, which `exactOptionalPropertyTypes` forbids;
    // omitting the key is runtime-identical, since the constructor reads
    // `options?.sessionIdGenerator` either way.
    const transport = new StreamableHTTPServerTransport({});

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };

  // GET (SSE stream) and DELETE (session teardown) are meaningless without session
  // state. Answer definitively rather than 404ing or hanging a stream open.
  const methodNotAllowed = (_req: Request, res: Response): void => {
    res.set("Allow", "POST").status(405).json({
      error_code: "method_not_allowed",
      message: "This endpoint accepts POST only; the transport is stateless.",
      hint: "Send MCP JSON-RPC requests as POST. There is no SSE stream or session to delete.",
    });
  };

  app.post("/mcp", requireAuth, handleMcp);
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  if (env.ALLOW_URL_TOKEN) {
    // Compatibility fallback only — see CONVENTIONS.md A2.5. When the flag is
    // unset these routes do not exist at all, so an unauthenticated probe gets a
    // 404 rather than a 401 advertising that the shape is supported.
    app.post("/mcp/:token", requireAuth, handleMcp);
    app.get("/mcp/:token", methodNotAllowed);
    app.delete("/mcp/:token", methodNotAllowed);
    logger.warn(
      { allowUrlToken: true },
      "tokenized URL path is ENABLED — credentials in URLs reach proxy logs and browser history",
    );
  }

  return app;
}

/* -------------------------------------------------------------------------- *
 * Boot. Skipped when imported by tests.
 *
 * Compares this module's URL against the script node was actually invoked with, so
 * it works identically for `node dist/index.js` and `tsx src/index.ts`. An earlier
 * version tested for a literal "index.js" suffix, which silently disabled `npm run
 * dev` — the file is index.ts there.
 * -------------------------------------------------------------------------- */
const entry = process.argv[1];
const isEntrypoint = entry !== undefined && import.meta.url === pathToFileURL(entry).href;

if (isEntrypoint) {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);
  const db = createDb(env.DB_PATH);
  const queries = createQueries(db);

  const app = createApp({ env, queries, logger });
  app.listen(env.PORT, () => {
    logger.info(
      {
        port: env.PORT,
        seedVersion: SEED_VERSION,
        orderCount: queries.countOrders(),
        allowUrlToken: env.ALLOW_URL_TOKEN,
      },
      "commerce-ops-mcp listening",
    );
  });
}
