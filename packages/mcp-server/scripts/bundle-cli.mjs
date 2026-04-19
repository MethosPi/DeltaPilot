#!/usr/bin/env node
import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(pkgRoot, "../..");

/**
 * Workspace packages (@deltapilot/*) expose their source .ts as `main`, which
 * Node can't resolve at runtime — internal `.js` specifiers have no matching
 * file on disk. Bundling the CLI with esbuild inlines all workspace code so
 * the resulting dist/cli.js runs under plain Node without relying on the
 * monorepo's dev-time resolver. Native modules stay external.
 */
await build({
  entryPoints: [path.join(pkgRoot, "src/cli.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: path.join(pkgRoot, "dist/cli.js"),
  // Native: cannot be bundled, must be resolved from node_modules at runtime.
  external: ["better-sqlite3"],
  banner: {
    // Some transitive CJS deps (cross-spawn via execa) call require() for
    // Node builtins. ESM output lacks require by default, so esbuild rewrites
    // those to a helper that throws. Installing a real createRequire in the
    // banner makes require resolve against the running Node instead.
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __nodeCreateRequire } from "node:module";',
      "const require = __nodeCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
});

/**
 * openDatabase reads SQL migrations at runtime via __dirname. After bundling,
 * that __dirname resolves to dist/, so copy the migrations alongside the
 * bundled CLI.
 */
const migrationsSrc = path.join(repoRoot, "packages/core/src/db/migrations");
const migrationsDst = path.join(pkgRoot, "dist/migrations");
mkdirSync(migrationsDst, { recursive: true });
cpSync(migrationsSrc, migrationsDst, { recursive: true });
