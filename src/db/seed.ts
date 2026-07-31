/**
 * Deterministic seed. Drops and rebuilds the database on every boot (SPEC.md §4).
 *
 * Zero randomness: healthy orders come from templates driven by a fixed-seed PRNG,
 * and the eight broken scenarios (ORD-1001…ORD-1008) are hand-written fixtures.
 * Those eight are load-bearing — tests and the demo script depend on their exact
 * IDs, states, amounts, and event histories. Never change them without approval.
 *
 * Production and tests share this one path (`createDb(':memory:')` in tests), so the
 * suite verifies the real fixtures rather than a parallel set of mocks.
 *
 * Populated in Phase 1.
 */
import type { Db } from "./queries.js";

/** Bumped whenever the fixtures change. Surfaced by /health. */
export const SEED_VERSION = "0.1.0";

/**
 * Open a connection, apply schema.sql, and seed it.
 *
 * @param path filesystem path, or ':memory:' for tests.
 */
export function createDb(path: string): Db {
  throw new Error(
    `createDb(${JSON.stringify(path)}) is not implemented yet — see PLAN.md Phase 1`,
  );
}
