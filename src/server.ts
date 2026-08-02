/**
 * McpServer construction and tool registration.
 *
 * A fresh McpServer is built per request: the transport is stateless (SPEC.md §2),
 * so nothing here may hold cross-request state. All state lives in SQLite.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Queries } from "./db/queries.js";
import type { InstrumentOptions } from "./instrument.js";
import { registerReadTools } from "./tools/read.js";

export interface ServerDeps {
  queries: Queries;
  instrument: InstrumentOptions;
}

/** Build a server instance with the tool surface registered. */
export function createMcpServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    { name: "commerce-ops-mcp", version: "0.1.0" },
    {
      instructions:
        "Investigate and resolve payment-order mismatches. Always call " +
        "get_order_timeline before proposing a resolution. Refunds execute only for " +
        "policy-eligible cases; every other outcome is an escalation recorded for a " +
        "human. Payment-processor state is never modified.",
    },
  );

  registerReadTools(server, deps.queries, deps.instrument);
  // Write tools land in Phase 4, after their tests.

  return server;
}
