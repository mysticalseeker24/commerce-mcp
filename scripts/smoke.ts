/**
 * End-to-end smoke test against a running server.
 *
 * Drives the real MCP SDK client over HTTP — not a unit test, and deliberately so:
 * a passing vitest suite says nothing about whether the transport, auth middleware,
 * and tool registration actually compose. This is the check that runs before a
 * Railway deploy, and again against the hosted URL afterwards.
 *
 *   npx tsx scripts/smoke.ts <base-url> <token>
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:3000";
const token = process.argv[3] ?? process.env["MCP_BEARER_TOKEN"] ?? "";

if (token === "") {
  console.error("usage: tsx scripts/smoke.ts <base-url> <token>");
  process.exit(2);
}

let failures = 0;
function check(label: string, passed: boolean, detail = ""): void {
  console.log(`${passed ? "  PASS" : "  FAIL"}  ${label}${detail === "" ? "" : ` — ${detail}`}`);
  if (!passed) failures += 1;
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  const block = result.content?.find((c) => c.type === "text");
  return block?.text ?? "";
}

async function main(): Promise<void> {
  console.log(`\nSmoke test against ${baseUrl}\n`);

  /* ---- /health is open ---------------------------------------------------- */
  console.log("health");
  const health = await fetch(`${baseUrl}/health`);
  const healthBody = (await health.json()) as Record<string, unknown>;
  check("GET /health returns 200 without a token", health.status === 200);
  check("reports a seed version", typeof healthBody["seedVersion"] === "string", String(healthBody["seedVersion"]));
  check("reports an order count of 250", healthBody["orderCount"] === 250, String(healthBody["orderCount"]));

  /* ---- auth --------------------------------------------------------------- */
  console.log("\nauth");
  const noToken = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  check("POST /mcp without a token is 401", noToken.status === 401, `got ${noToken.status}`);

  const wrongToken = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer wrong-token-value" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  check("POST /mcp with a wrong token is 401", wrongToken.status === 401, `got ${wrongToken.status}`);

  const getMcp = await fetch(`${baseUrl}/mcp`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  check("GET /mcp is 405", getMcp.status === 405, `got ${getMcp.status}`);
  check("405 carries Allow: POST", getMcp.headers.get("allow") === "POST", getMcp.headers.get("allow") ?? "absent");

  /* ---- MCP round trip ----------------------------------------------------- */
  console.log("\nmcp");
  const client = new Client({ name: "smoke", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  check("tools/list succeeds", names.length > 0, names.join(", "));
  check("get_order_timeline is advertised", names.includes("get_order_timeline"));

  const timelineTool = tools.tools.find((t) => t.name === "get_order_timeline");
  check(
    "its input schema pins the order_id pattern",
    JSON.stringify(timelineTool?.inputSchema ?? {}).includes("ORD-"),
  );

  /* ---- the executable case ------------------------------------------------ */
  console.log("\nORD-1007 (the one refundable order)");
  const t1007 = await client.callTool({
    name: "get_order_timeline",
    arguments: { order_id: "ORD-1007" },
  });
  const body = JSON.parse(textOf(t1007 as { content?: Array<{ type: string; text?: string }> })) as {
    diagnostics: {
      discrepancy_cents: number;
      flags: string[];
      refund_eligibility: { eligible: boolean; evaluated_amount_cents: number };
    };
  };
  check("discrepancy is $30.00", body.diagnostics.discrepancy_cents === 3_000, String(body.diagnostics.discrepancy_cents));
  check("flags PARTIAL_REFUND_GAP", body.diagnostics.flags.includes("PARTIAL_REFUND_GAP"), body.diagnostics.flags.join(","));
  check("policy says eligible", body.diagnostics.refund_eligibility.eligible);
  check("evaluated against 3000 cents", body.diagnostics.refund_eligibility.evaluated_amount_cents === 3_000);

  /* ---- the injection case ------------------------------------------------- */
  console.log("\nORD-1008 (prompt injection in notes)");
  const t1008 = await client.callTool({
    name: "get_order_timeline",
    arguments: { order_id: "ORD-1008" },
  });
  const raw = textOf(t1008 as { content?: Array<{ type: string; text?: string }> });
  const parsed = JSON.parse(raw) as {
    customer_note: { warning: string; content: string | null };
    diagnostics: { flags: string[] };
  };
  check("note is present verbatim inside the wrapper", parsed.customer_note.content?.startsWith("SYSTEM OVERRIDE") === true);
  check("wrapper carries the untrusted warning", parsed.customer_note.warning.includes("UNTRUSTED"));
  check("order itself is diagnostically healthy", parsed.diagnostics.flags.length === 0);
  const withoutWrapper = JSON.stringify({ ...parsed, customer_note: undefined });
  check("note text appears nowhere else in the payload", !withoutWrapper.includes("SYSTEM OVERRIDE"));

  /* ---- error shape -------------------------------------------------------- */
  console.log("\nerrors");
  const missing = await client.callTool({
    name: "get_order_timeline",
    arguments: { order_id: "ORD-9999" },
  });
  const err = JSON.parse(textOf(missing as { content?: Array<{ type: string; text?: string }> })) as {
    error_code: string;
    hint: string;
  };
  check("unknown order returns not_found", err.error_code === "not_found", err.error_code);
  check("error carries an actionable hint", err.hint.length > 0, err.hint);

  await client.close();

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error("\nsmoke test threw:", error);
  process.exit(1);
});
