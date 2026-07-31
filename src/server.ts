/**
 * McpServer construction and tool registration.
 *
 * A fresh McpServer is built per request: the transport is stateless (SPEC.md §2),
 * so nothing here may hold cross-request state. All state lives in SQLite.
 *
 * Populated in Phase 2.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Queries } from "./db/queries.js";
import type { InstrumentOptions } from "./instrument.js";

export interface ServerDeps {
  queries: Queries;
  instrument: InstrumentOptions;
}

/** Build a server instance with all seven tools registered. */
export function createMcpServer(_deps: ServerDeps): McpServer {
  throw new Error("createMcpServer is not implemented yet — see PLAN.md Phase 2");
}
