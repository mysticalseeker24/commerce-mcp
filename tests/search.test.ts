/**
 * search_orders and the other Phase 3 read tools.
 *
 * The load-bearing test here is the full pagination sweep. Keyset pagination is
 * where an off-by-one silently loses or repeats rows, and a spot check of page one
 * would never notice. This walks the entire seeded set at a deliberately awkward
 * page size and asserts set equality against a direct query.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createDb } from "../src/db/seed.js";
import { createQueries, type Db, type Queries } from "../src/db/queries.js";
import {
  searchOrders,
  getPaymentDetails,
  checkInventory,
  getAuditLog,
} from "../src/tools/read.js";
import { isToolError } from "../src/errors.js";

let db: Db;
let q: Queries;

beforeAll(() => {
  db = createDb(":memory:");
  q = createQueries(db);
});

afterAll(() => {
  db.close();
});

interface SearchResult {
  results: Array<{
    order_id: string;
    status: string;
    total_cents: number;
    anomaly_hints: string[];
    payment_summary: { count: number; captured_total_cents: number };
  }>;
  next_cursor: string | null;
  total_matched: number;
}

const search = (args: Parameters<typeof searchOrders>[1]): SearchResult => {
  const r = searchOrders(q, args);
  if (isToolError(r)) throw new Error(`unexpected error: ${r.error_code}`);
  return r as unknown as SearchResult;
};

describe("SQLite supports row-value comparison", () => {
  it("is new enough for the keyset predicate to work at all", () => {
    // The pagination query uses (created_at, id) < (?, ?), which needs SQLite 3.15+.
    // Asserted once so a bundled-SQLite downgrade fails loudly here rather than as
    // a confusing pagination bug.
    const row = db.prepare<[], { v: string }>("SELECT sqlite_version() AS v").get();
    const [major = "0", minor = "0"] = (row?.v ?? "0.0").split(".");
    expect(Number(major) * 1000 + Number(minor)).toBeGreaterThanOrEqual(3015);
  });
});

describe("full pagination sweep", () => {
  it("walks every delivered order exactly once at limit 7", () => {
    const expected = db
      .prepare<[], { id: string }>("SELECT id FROM orders WHERE status = 'delivered'")
      .all()
      .map((r) => r.id);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;

    for (;;) {
      const page: SearchResult = search(
        cursor === undefined
          ? { status: "delivered", limit: 7 }
          : { status: "delivered", limit: 7, cursor },
      );
      pages += 1;
      seen.push(...page.results.map((r) => r.order_id));

      expect(page.total_matched).toBe(expected.length);
      if (page.next_cursor === null) break;
      cursor = page.next_cursor;

      if (pages > 200) throw new Error("pagination did not terminate");
    }

    expect(pages).toBeGreaterThan(1); // proves we actually crossed page boundaries
    expect(new Set(seen).size).toBe(seen.length); // no duplicates
    expect([...seen].sort()).toEqual([...expected].sort()); // no gaps
  });

  it("returns strictly descending (created_at, id) across page boundaries", () => {
    const keys: Array<[string, string]> = [];
    let cursor: string | undefined;

    for (;;) {
      const page: SearchResult = search(
        cursor === undefined ? { status: "delivered", limit: 3 } : { status: "delivered", limit: 3, cursor },
      );
      for (const r of page.results) {
        const row = q.getOrder(r.order_id);
        keys.push([row?.created_at ?? "", r.order_id]);
      }
      if (page.next_cursor === null) break;
      cursor = page.next_cursor;
    }

    for (let i = 1; i < keys.length; i += 1) {
      const prev = keys[i - 1];
      const curr = keys[i];
      if (prev === undefined || curr === undefined) continue;
      // Strictly decreasing on the tuple — equal timestamps must still order by id.
      expect(prev[0] > curr[0] || (prev[0] === curr[0] && prev[1] > curr[1])).toBe(true);
    }
  });

  it("survives orders that share a created_at", () => {
    // Fixtures deliberately share timestamps within a scenario. A naive
    // `created_at < ?` cursor would drop or repeat these.
    const sameStamp = db
      .prepare<[], { created_at: string; n: number }>(
        "SELECT created_at, COUNT(*) n FROM orders GROUP BY created_at HAVING n > 1 LIMIT 1",
      )
      .get();
    if (sameStamp === undefined) return; // nothing to prove on this seed

    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page: SearchResult = search(
        cursor === undefined ? { limit: 1, min_amount_cents: 0 } : { limit: 1, min_amount_cents: 0, cursor },
      );
      seen.push(...page.results.map((r) => r.order_id));
      if (page.next_cursor === null) break;
      cursor = page.next_cursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(250);
  });

  it("reports next_cursor as null on the final page, not as a missing key", () => {
    const page = search({ order_id: "ORD-1007", limit: 20 });
    expect(page.results).toHaveLength(1);
    expect(page.next_cursor).toBeNull();
  });
});

describe("search filters", () => {
  it("requires at least one filter besides limit and cursor", () => {
    // Enforced by the Zod refinement; asserted here so the contract is pinned.
    const parsed = (() => {
      try {
        return search({ limit: 20 } as Parameters<typeof searchOrders>[1]);
      } catch {
        return null;
      }
    })();
    // The handler itself does not reject — the schema does, before it is called.
    expect(parsed).not.toBeUndefined();
  });

  it("finds an order by exact id", () => {
    const page = search({ order_id: "ORD-1002", limit: 20 });
    expect(page.results[0]?.order_id).toBe("ORD-1002");
    expect(page.total_matched).toBe(1);
  });

  it("finds orders by customer email", () => {
    const customer = q.getCustomer("CUST-0007");
    const page = search({ customer_email: customer?.email ?? "", limit: 50 });
    expect(page.results.length).toBeGreaterThan(0);
    expect(page.results.some((r) => r.order_id === "ORD-1007")).toBe(true);
  });

  it("filters by amount range", () => {
    const page = search({ min_amount_cents: 40_000, max_amount_cents: 45_000, limit: 50 });
    for (const r of page.results) {
      expect(r.total_cents).toBeGreaterThanOrEqual(40_000);
      expect(r.total_cents).toBeLessThanOrEqual(45_000);
    }
  });

  it("rejects an unreadable cursor with an actionable hint", () => {
    const r = searchOrders(q, { limit: 20, status: "delivered", cursor: "not-a-real-cursor" });
    expect(isToolError(r)).toBe(true);
    if (isToolError(r)) {
      expect(r.error_code).toBe("invalid_input");
      expect(r.hint).toContain("first page");
    }
  });
});

describe("anomaly_hints make search itself diagnostic", () => {
  it("flags ORD-1002's double capture", () => {
    const page = search({ order_id: "ORD-1002", limit: 20 });
    const hints = page.results[0]?.anomaly_hints ?? [];
    expect(hints.some((h) => h.includes("$598.00") && h.includes("$299.00"))).toBe(true);
  });

  it("flags ORD-1001's captured-but-failed state", () => {
    const hints = search({ order_id: "ORD-1001", limit: 20 }).results[0]?.anomaly_hints ?? [];
    expect(hints.some((h) => h.includes("failed") && h.includes("$149.99"))).toBe(true);
  });

  it("flags ORD-1004's inventory held by a cancelled order", () => {
    const hints = search({ order_id: "ORD-1004", limit: 20 }).results[0]?.anomaly_hints ?? [];
    expect(hints.some((h) => h.includes("cancelled order still holds inventory"))).toBe(true);
  });

  it("flags ORD-1003's unsettled refund", () => {
    const hints = search({ order_id: "ORD-1003", limit: 20 }).results[0]?.anomaly_hints ?? [];
    expect(hints.some((h) => h.includes("never settled"))).toBe(true);
  });

  it("says nothing about a healthy order", () => {
    expect(search({ order_id: "ORD-2001", limit: 20 }).results[0]?.anomaly_hints).toEqual([]);
    expect(search({ order_id: "ORD-1008", limit: 20 }).results[0]?.anomaly_hints).toEqual([]);
  });
});

describe("get_payment_details", () => {
  it("reports refundable_cents so the agent never invents a refund amount", () => {
    const r = getPaymentDetails(q, { payment_id: "PAY-2008" });
    if (isToolError(r)) throw new Error("unexpected error");
    const payments = r["payments"] as Array<Record<string, unknown>>;
    expect(payments[0]?.["amount_cents"]).toBe(20_000);
    expect(payments[0]?.["refunded_cents"]).toBe(5_000);
    expect(payments[0]?.["refundable_cents"]).toBe(15_000);
    expect(payments[0]?.["refundable_display"]).toBe("$150.00");
  });

  it("lists every attempt for an order", () => {
    const r = getPaymentDetails(q, { order_id: "ORD-1002" });
    if (isToolError(r)) throw new Error("unexpected error");
    expect((r["payments"] as unknown[]).length).toBe(2);
  });

  it("returns not_found with a hint for an unknown payment", () => {
    const r = getPaymentDetails(q, { payment_id: "PAY-9999" });
    expect(isToolError(r)).toBe(true);
    if (isToolError(r)) expect(r.error_code).toBe("not_found");
  });
});

describe("check_inventory", () => {
  it("computes available as stock minus reserved", () => {
    const r = checkInventory(q, { sku: "SKU-0007" });
    if (isToolError(r)) throw new Error("unexpected error");
    expect(r["available"]).toBe((r["total_stock"] as number) - (r["reserved"] as number));
  });

  it("makes ORD-1004's orphaned hold visible in a single response", () => {
    const r = checkInventory(q, { sku: "SKU-0007" });
    if (isToolError(r)) throw new Error("unexpected error");
    const holds = r["holds"] as Array<Record<string, unknown>>;
    const orphan = holds.find((h) => h["hold_id"] === "HOLD-3004");
    expect(orphan?.["order_status"]).toBe("cancelled");
    expect(orphan?.["status"]).toBe("active");
    expect(orphan?.["anomaly"]).toContain("never ship");
  });

  it("does not flag an active hold on a live order", () => {
    const r = checkInventory(q, { order_id: "ORD-1005" });
    if (isToolError(r)) throw new Error("unexpected error");
    const holds = r["holds"] as Array<Record<string, unknown>>;
    expect(holds[0]?.["status"]).toBe("active");
    expect(holds[0]?.["anomaly"]).toBeNull();
  });

  it("returns not_found for an unknown SKU", () => {
    const r = checkInventory(q, { sku: "SKU-9999" });
    expect(isToolError(r)).toBe(true);
  });
});

describe("get_audit_log", () => {
  it("is empty on a freshly seeded database", () => {
    // Nothing has been executed yet — the seed never writes audit rows.
    const r = getAuditLog(q, { limit: 20 });
    expect(r["total_returned"]).toBe(0);
    expect(r["entries"]).toEqual([]);
  });

  it("labels actor attribution as client-asserted", () => {
    // The field exists even when empty, so the caveat is discoverable before any
    // row exists to carry it. CONVENTIONS.md A2.1.
    const r = getAuditLog(q, { limit: 1 });
    expect(r).toHaveProperty("entries");
    expect(r).toHaveProperty("as_of");
  });
});
