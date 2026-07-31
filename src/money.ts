/**
 * Money formatting. CONVENTIONS.md B1: amounts are integer paise everywhere, and
 * this is the ONLY place a display string is produced. No floating-point money.
 */

const INR = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Render integer paise as a display string, e.g. `299900` → `"₹2,999.00"`.
 *
 * Uses Indian digit grouping, so large amounts read the way the analyst expects:
 * `10000000` → `"₹1,00,000.00"`, not `"₹100,000.00"`.
 *
 * Division is safe here despite the no-floating-point-money rule: paise are
 * integers up to 2^53, and the result is immediately formatted to exactly two
 * decimals rather than fed back into arithmetic.
 */
export function formatPaise(paise: number): string {
  if (!Number.isInteger(paise)) {
    throw new TypeError(`formatPaise expects integer paise, received ${paise}`);
  }
  const sign = paise < 0 ? "-" : "";
  return `${sign}₹${INR.format(Math.abs(paise) / 100)}`;
}
