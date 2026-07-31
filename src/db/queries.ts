/**
 * Every SQL statement in the project lives here, as a named prepared statement.
 *
 * CONVENTIONS.md B2 — hard rules:
 *   - Tools never contain SQL strings.
 *   - No string interpolation into SQL, ever. Prepared-statement parameter binding
 *     is what prevents injection here; Zod prevents malformed input, which is a
 *     different problem (CONVENTIONS.md A1).
 *
 * Populated in Phase 1 alongside schema.sql.
 */
import type BetterSqlite3 from "better-sqlite3";

export type Db = BetterSqlite3.Database;

/**
 * Statements are prepared once per connection and reused. Built in Phase 1; the
 * shape is a record of named `Statement`s so callers reference them by name rather
 * than by writing SQL at the call site.
 */
export interface Queries {
  readonly db: Db;
}

export function createQueries(db: Db): Queries {
  return { db };
}
