/**
 * The five read tools (TOOLS.md 1–5): search_orders, get_order_timeline,
 * get_payment_details, check_inventory, get_audit_log.
 *
 * Read tools are safe and unrestricted — they mutate nothing.
 *
 * Two rules that outlive this file:
 *   - The `description` and every `.describe()` string is product copy, taken
 *     verbatim from TOOLS.md. They are what the model reads to decide how to call
 *     these tools. Do not paraphrase or "improve" them.
 *   - Customer-authored `orders.notes` appears ONLY inside the
 *     `customer_note.{warning, content}` wrapper — never concatenated into a
 *     `detail`, `plan`, or summary string (CONVENTIONS.md A3).
 *
 * get_order_timeline lands in Phase 2; the rest in Phase 3.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Queries } from "../db/queries.js";
import type { InstrumentOptions } from "../instrument.js";

export function registerReadTools(
  _server: McpServer,
  _queries: Queries,
  _options: InstrumentOptions,
): void {
  throw new Error("registerReadTools is not implemented yet — see PLAN.md Phase 2");
}
