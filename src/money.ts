/**
 * Money formatting. CONVENTIONS.md B1: amounts are integer cents everywhere, and
 * this is the ONLY place a display string is produced. No floating-point money.
 *
 * USD/cents matches the units the client's refund policy is written in ($150.00
 * cap), so no figure in the product is an approximation of a policy bound.
 */

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

/**
 * Render integer cents as a display string, e.g. `299900` → `"$2,999.00"`.
 *
 * Division is safe here despite the no-floating-point-money rule: cents are
 * integers well within 2^53, and the result is immediately formatted to exactly
 * two decimals rather than fed back into arithmetic.
 */
export function formatCents(cents: number): string {
  if (!Number.isInteger(cents)) {
    throw new TypeError(`formatCents expects integer cents, received ${cents}`);
  }
  return USD.format(cents / 100);
}
