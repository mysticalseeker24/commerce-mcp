/**
 * Transport-level tests — PLAN.md Tier 2.
 *
 * These run against a REAL HTTP server with a REAL MCP SDK client, deliberately.
 * Every other suite calls handlers directly, which is faster but blind to an entire
 * layer: schema validation, transport negotiation, auth middleware, and error
 * serialization all live above the handler.
 *
 * That blindness was not hypothetical. A `.refine()` on the advertised schema was
 * validated by the SDK *before* the handler ran and surfaced as a thrown JSON-RPC
 * -32602, bypassing the {error_code, message, hint} contract entirely — and every
 * handler-level test passed throughout. This file is where that class of bug is
 * supposed to die.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { pino } from "pino";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp, redactPath } from "../src/index.js";
import { createDb } from "../src/db/seed.js";
import { createQueries, type Db } from "../src/db/queries.js";

const TOKEN = "test-token-0123456789abcdefghij";

/** Captures every log line so we can assert the token never appears in one. */
const logLines: string[] = [];

let db: Db;
let server: Server;
let baseUrl: string;

function startServer(allowUrlToken: boolean): Promise<{ server: Server; url: string }> {
  db = createDb(":memory:");
  const logger = pino(
    { level: "info", redact: { paths: ["req.headers.authorization"], censor: "[REDACTED]" } },
    { write: (line: string) => logLines.push(line) },
  );
  const app = createApp({
    env: {
      MCP_BEARER_TOKEN: TOKEN,
      PORT: 0,
      DB_PATH: ":memory:",
      LOG_LEVEL: "info",
      ALLOW_URL_TOKEN: allowUrlToken,
    },
    queries: createQueries(db),
    logger,
  });

  return new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      resolve({ server: s, url: `http://127.0.0.1:${port}` });
    });
  });
}

beforeAll(async () => {
  const started = await startServer(false);
  server = started.server;
  baseUrl = started.url;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

/** Connected SDK client. This is the path a real agent takes. */
async function connectClient(url = `${baseUrl}/mcp`): Promise<Client> {
  const client = new Client({ name: "http-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    }),
  );
  return client;
}

function textOf(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  return r.content?.find((c) => c.type === "text")?.text ?? "";
}

/* ========================================================================== */

describe("/health is the only open route", () => {
  it("returns status without a token", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["status"]).toBe("ok");
    expect(body["orderCount"]).toBe(250);
    expect(body["seedVersion"]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("leaks nothing beyond the four documented fields", () => {
    // A health endpoint is unauthenticated; its response is a disclosure surface.
    return fetch(`${baseUrl}/health`)
      .then((r) => r.json())
      .then((body) => {
        expect(Object.keys(body as object).sort()).toEqual([
          "orderCount", "seedVersion", "status", "uptime",
        ]);
      });
  });
});

describe("auth", () => {
  it("no token → 401", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("wrong token → 401", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, authorization: "Bearer not-the-right-token-at-all" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("401 carries a WWW-Authenticate challenge", async () => {
    // Without it a client has to guess, and claude.ai guesses OAuth — it attempted
    // Dynamic Client Registration against a server that has no authorization
    // server. RFC 6750 §3.
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="commerce-ops-mcp"');
  });

  it("the challenge does NOT advertise an OAuth authorization server", async () => {
    // A resource_metadata parameter is what sends a client into OAuth discovery.
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.headers.get("www-authenticate")).not.toContain("resource_metadata");
  });

  it("the 401 body uses the standard error shape", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["error_code"]).toBe("unauthorized");
    expect(body["hint"]).toContain("Authorization: Bearer");
  });
});

describe("method handling on a stateless transport", () => {
  it.each(["GET", "DELETE"])("%s /mcp → 405 with Allow: POST", async (method) => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("405 explains why, rather than just refusing", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "GET",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body["hint"])).toContain("no SSE stream");
  });
});

describe("the tokenized URL route is absent unless enabled", () => {
  it("POST /mcp/<token> → 404 when ALLOW_URL_TOKEN is unset", async () => {
    // 404, not 401: an unmounted route must not advertise that the shape exists.
    const res = await fetch(`${baseUrl}/mcp/${TOKEN}`, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(404);
  });

  it("works, and still rejects a wrong token, when enabled", async () => {
    const { server: s2, url } = await startServer(true);
    try {
      const good = await fetch(`${url}/mcp/${TOKEN}`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(good.status).toBe(200);

      const bad = await fetch(`${url}/mcp/wrong-token-entirely`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(bad.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => s2.close(() => resolve()));
    }
  });
});

describe("the token never reaches the logs", () => {
  it("appears in no captured log line, from either auth path", async () => {
    await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.join("\n")).not.toContain(TOKEN);
  });

  it("redactPath scrubs a tokenized URL before serialization", () => {
    // pino's redact cannot reach a secret embedded in a URL string, so the path is
    // scrubbed structurally instead.
    expect(redactPath(`/mcp/${TOKEN}`)).toBe("/mcp/[REDACTED]");
    expect(redactPath("/mcp")).toBe("/mcp");
    expect(redactPath("/health")).toBe("/health");
  });
});

describe("tools/list over the SDK client", () => {
  it("advertises all seven tools with schemas", async () => {
    const client = await connectClient();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "check_inventory", "execute_resolution", "get_audit_log", "get_order_timeline",
        "get_payment_details", "propose_resolution", "search_orders",
      ]);
      for (const tool of tools) {
        expect(tool.description?.length ?? 0).toBeGreaterThan(50);
        expect(tool.inputSchema).toBeDefined();
      }
    } finally {
      await client.close();
    }
  });

  it("pins ID patterns in the advertised schema, not just in the handler", async () => {
    const client = await connectClient();
    try {
      const { tools } = await client.listTools();
      const timeline = tools.find((t) => t.name === "get_order_timeline");
      expect(JSON.stringify(timeline?.inputSchema)).toContain("ORD-");
    } finally {
      await client.close();
    }
  });

  it("states the refund policy limits in propose_resolution's description", async () => {
    // The description is the agent's contract. If the limits are not in it, the
    // agent learns them only by being refused.
    const client = await connectClient();
    try {
      const { tools } = await client.listTools();
      const propose = tools.find((t) => t.name === "propose_resolution")?.description ?? "";
      expect(propose).toContain("$150.00");
      expect(propose).toContain("30 days");
      expect(propose).toContain("risk below 70");
      expect(propose).toContain("verified carrier exception");
    } finally {
      await client.close();
    }
  });
});

describe("errors cross the transport as isError, never as thrown JSON-RPC", () => {
  it("a filterless search_orders returns the error contract", async () => {
    // THE REGRESSION TEST. As a schema .refine() this threw -32602 above the
    // handler, so the hint listing the valid filters never reached the agent —
    // and every handler-level test still passed.
    const client = await connectClient();
    try {
      const result = await client.callTool({ name: "search_orders", arguments: {} });
      expect((result as { isError?: boolean }).isError).toBe(true);

      const body = JSON.parse(textOf(result)) as Record<string, string>;
      expect(body["error_code"]).toBe("invalid_input");
      expect(body["hint"]).toContain("customer_email");
    } finally {
      await client.close();
    }
  });

  it("get_payment_details with both ids returns the error contract", async () => {
    const client = await connectClient();
    try {
      const result = await client.callTool({
        name: "get_payment_details",
        arguments: { order_id: "ORD-1007", payment_id: "PAY-2008" },
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(JSON.parse(textOf(result))["error_code"]).toBe("invalid_input");
    } finally {
      await client.close();
    }
  });

  it("an unknown order returns not_found with an actionable hint", async () => {
    const client = await connectClient();
    try {
      const result = await client.callTool({
        name: "get_order_timeline",
        arguments: { order_id: "ORD-9999" },
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
      const body = JSON.parse(textOf(result)) as Record<string, string>;
      expect(body["error_code"]).toBe("not_found");
      expect(body["hint"]).toContain("search_orders");
    } finally {
      await client.close();
    }
  });

  it("a malformed id is rejected by the schema — but WITHOUT our hint", async () => {
    /*
     * Documents the exact boundary, measured rather than assumed.
     *
     * The SDK does not throw on schema failure: it returns isError with a raw
     * "-32602 Input validation error ... must match pattern /^ORD-\d+$/" string.
     * That is fine for a SHAPE error — the pattern tells the agent what to fix.
     *
     * It is NOT fine for a business rule, which is why the cross-field checks moved
     * into the handlers. "At least one filter besides limit and cursor" as a
     * .refine() produced this same unstructured response, so the hint naming the
     * seven valid filters never reached the agent. Same mechanism, very different
     * consequence.
     */
    const client = await connectClient();
    try {
      const result = await client.callTool({
        name: "get_order_timeline",
        arguments: { order_id: "nonsense" },
      });
      expect((result as { isError?: boolean }).isError).toBe(true);

      const text = textOf(result);
      expect(text).toContain("-32602");
      expect(text).toContain("ORD-");

      // The tell: no structured contract, because this never reached our handler.
      expect(() => JSON.parse(text) as unknown).toThrow();
    } finally {
      await client.close();
    }
  });

  it("no error body ever leaks a stack trace, file path, or SQL", async () => {
    const client = await connectClient();
    try {
      for (const args of [{ order_id: "ORD-9999" }, { order_id: "ORD-1007" }]) {
        const text = textOf(await client.callTool({ name: "get_order_timeline", arguments: args }));
        expect(text).not.toMatch(/\bat .*\(.*:\d+:\d+\)/); // stack frame
        expect(text).not.toContain("SELECT ");
        expect(text).not.toContain("src/");
      }
    } finally {
      await client.close();
    }
  });
});

describe("full round trip over HTTP: timeline → propose → execute", () => {
  it("executes the one eligible refund and refuses the second attempt", async () => {
    const client = await connectClient();
    try {
      const timeline = JSON.parse(
        textOf(await client.callTool({ name: "get_order_timeline", arguments: { order_id: "ORD-1007" } })),
      ) as { diagnostics: { discrepancy_cents: number } };
      expect(timeline.diagnostics.discrepancy_cents).toBe(3_000);

      const proposal = JSON.parse(
        textOf(
          await client.callTool({
            name: "propose_resolution",
            arguments: {
              order_id: "ORD-1007",
              action: "refund",
              target_id: "PAY-2008",
              amount_cents: 3_000,
              reasoning: "Verified carrier exception CE-004 leaves a $30.00 gap after the earlier adjustment.",
            },
          }),
        ),
      ) as { proposal_id: string; action: string };
      expect(proposal.action).toBe("refund");

      const executed = JSON.parse(
        textOf(
          await client.callTool({
            name: "execute_resolution",
            arguments: { proposal_id: proposal.proposal_id, confirmed_by: "analyst@example.com" },
          }),
        ),
      ) as { executed: boolean; action_key: string };
      expect(executed.executed).toBe(true);
      expect(executed.action_key).toBe("refund:ORD-1007:CE-004");

      const repeat = await client.callTool({
        name: "execute_resolution",
        arguments: { proposal_id: proposal.proposal_id },
      });
      expect((repeat as { isError?: boolean }).isError).toBe(true);
      expect(JSON.parse(textOf(repeat))["error_code"]).toBe("already_executed");

      // And the audit trail shows both, over the wire.
      const audit = JSON.parse(
        textOf(await client.callTool({ name: "get_audit_log", arguments: { order_id: "ORD-1007", limit: 10 } })),
      ) as { entries: Array<{ outcome: string; actor: string }> };
      expect(audit.entries.filter((e) => e.outcome === "success")).toHaveLength(1);
      expect(audit.entries.some((e) => e.outcome.startsWith("rejected:"))).toBe(true);
      expect(audit.entries.some((e) => e.actor === "analyst@example.com")).toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe("escalation kind agrees across propose and execute, over the wire", () => {
  it("ORD-1002 is human_review in the plan and in the recorded escalation", async () => {
    // The reproduction from live review: confirmed as manager-approval, filed as
    // human_review. Asserted here at the layer the analyst actually sees.
    const client = await connectClient();
    try {
      const proposal = JSON.parse(
        textOf(
          await client.callTool({
            name: "propose_resolution",
            arguments: {
              order_id: "ORD-1002",
              action: "refund",
              target_id: "PAY-2003",
              amount_cents: 14_000,
              reasoning: "Customer reports a duplicate charge; attempting a refund of the second capture.",
            },
          }),
        ),
      ) as { proposal_id: string; action: string; escalation_kind: string; plan: string };

      expect(proposal.action).toBe("escalate");
      expect(proposal.escalation_kind).toBe("human_review");
      expect(proposal.plan).toContain("human-review");

      const executed = JSON.parse(
        textOf(
          await client.callTool({
            name: "execute_resolution",
            arguments: { proposal_id: proposal.proposal_id, confirmed_by: "analyst@example.com" },
          }),
        ),
      ) as { escalation_kind: string };

      expect(executed.escalation_kind).toBe(proposal.escalation_kind);
    } finally {
      await client.close();
    }
  });
});

describe("check_inventory is bounded like every other list-returning tool", () => {
  it("hides consumed holds by default and says how many it hid", async () => {
    const client = await connectClient();
    try {
      const body = JSON.parse(
        textOf(await client.callTool({ name: "check_inventory", arguments: { sku: "SKU-0007" } })),
      ) as {
        holds: Array<{ status: string }>;
        holds_total: number;
        holds_omitted: number;
        include_consumed: boolean;
        note?: string;
      };

      expect(body.include_consumed).toBe(false);
      expect(body.holds.every((h) => h.status === "active")).toBe(true);
      expect(body.holds_omitted).toBeGreaterThan(0);
      expect(body.note).toContain("include_consumed");
      expect(body.holds.length).toBeLessThan(body.holds_total);
    } finally {
      await client.close();
    }
  });

  it("returns the full history when asked", async () => {
    const client = await connectClient();
    try {
      const body = JSON.parse(
        textOf(
          await client.callTool({
            name: "check_inventory",
            arguments: { sku: "SKU-0007", include_consumed: true },
          }),
        ),
      ) as { holds: Array<{ status: string }>; holds_total: number; holds_omitted: number };

      expect(body.holds.length).toBe(body.holds_total);
      expect(body.holds_omitted).toBe(0);
      // Active first, because those are the ones that explain a discrepancy.
      expect(body.holds[0]?.status).toBe("active");
    } finally {
      await client.close();
    }
  });

  it("still surfaces ORD-1004's orphaned hold, which is the point of the tool", async () => {
    const client = await connectClient();
    try {
      const body = JSON.parse(
        textOf(await client.callTool({ name: "check_inventory", arguments: { sku: "SKU-0007" } })),
      ) as { holds: Array<{ hold_id: string; anomaly: string | null }> };
      const orphan = body.holds.find((h) => h.hold_id === "HOLD-3004");
      expect(orphan?.anomaly).toContain("never ship");
    } finally {
      await client.close();
    }
  });

  it("states the default in the advertised description", async () => {
    const client = await connectClient();
    try {
      const { tools } = await client.listTools();
      const desc = tools.find((t) => t.name === "check_inventory")?.description ?? "";
      expect(desc).toContain("active holds by default");
      expect(desc).toContain("include_consumed");
    } finally {
      await client.close();
    }
  });
});

describe("the untrusted-note wrapper survives serialization over the wire", () => {
  it("ORD-1008's note reaches the client only inside the wrapper", async () => {
    const client = await connectClient();
    try {
      const raw = textOf(
        await client.callTool({ name: "get_order_timeline", arguments: { order_id: "ORD-1008" } }),
      );
      const body = JSON.parse(raw) as { customer_note: { warning: string; content: string } };
      expect(body.customer_note.warning).toContain("UNTRUSTED");
      expect(body.customer_note.content).toContain("SYSTEM OVERRIDE");

      const withoutWrapper = JSON.stringify({ ...body, customer_note: undefined });
      expect(withoutWrapper).not.toContain("SYSTEM OVERRIDE");
    } finally {
      await client.close();
    }
  });
});
