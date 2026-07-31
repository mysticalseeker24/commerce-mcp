/**
 * Shared-token verification (CONVENTIONS.md A3).
 *
 * Two transports for the same token:
 *   - `Authorization: Bearer <token>` — the recommended path.
 *   - `POST /mcp/<token>` — mounted only when ALLOW_URL_TOKEN is set. See
 *     CONVENTIONS.md A2.5 for why it exists and why it is off by default.
 *
 * Both compare SHA-256 digests rather than raw strings. Hashing first makes both
 * buffers exactly 32 bytes, so `timingSafeEqual` never throws on a length mismatch
 * and the comparison leaks neither content nor length.
 */
import { createHash, timingSafeEqual } from "node:crypto";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Constant-time token comparison.
 *
 * Note the honest limit: this authenticates the *caller's possession of a shared
 * secret*, nothing more. Actor identity in the audit log is client-asserted — see
 * CONVENTIONS.md A2.1.
 */
export function verifyToken(candidate: string | undefined, expected: string): boolean {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  return timingSafeEqual(digest(candidate), digest(expected));
}

/** Pull the token out of `Authorization: Bearer <token>`, if well-formed. */
export function tokenFromAuthHeader(header: string | undefined): string | undefined {
  if (typeof header !== "string") return undefined;
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return match?.[1];
}
