import { execa } from "execa";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * SDK integration tests spawn @deltapilot/mcp-server's bundled dist/cli.js.
 * Build it before the suite runs so a fresh clone / CI run doesn't see a
 * stale or missing binary. pnpm --filter resolves against the repo root.
 */
export async function setup(): Promise<void> {
  const repoRoot = path.resolve(__dirname, "../../..");
  await execa("pnpm", ["--filter", "@deltapilot/mcp-server", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}
