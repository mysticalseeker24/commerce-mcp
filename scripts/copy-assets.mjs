/**
 * Copy non-TypeScript assets into dist/.
 *
 * `tsc` emits only .js — schema.sql would be missing from a production build and
 * the server would crash on first boot with ENOENT. Caught by building and running
 * locally before deploying rather than by Railway at 3am.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assets = [["src/db/schema.sql", "dist/db/schema.sql"]];

for (const [from, to] of assets) {
  const target = join(root, to);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(root, from), target);
  console.log(`copied ${from} -> ${to}`);
}
