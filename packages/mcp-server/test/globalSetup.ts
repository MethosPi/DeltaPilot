import { execa } from "execa";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Build the package before any e2e tests run. The CLI under test is the
 * compiled dist/cli.js — tests spawn it as a subprocess — so stale or missing
 * output would silently invalidate the run. Running tsc takes ~1s and is the
 * price of exercising the real stdio transport end-to-end.
 */
export async function setup(): Promise<void> {
  const pkgRoot = path.resolve(__dirname, "..");
  await execa("pnpm", ["build"], { cwd: pkgRoot, stdio: "inherit" });
}
