#!/usr/bin/env node
import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(appRoot, "../..");

await build({
  entryPoints: [path.join(appRoot, "src/cli.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: path.join(appRoot, "dist/cli.js"),
  external: ["better-sqlite3"],
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __nodeCreateRequire } from "node:module";',
      "const require = __nodeCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
});

const migrationsSrc = path.join(repoRoot, "packages/core/src/db/migrations");
const migrationsDst = path.join(appRoot, "dist/migrations");
mkdirSync(migrationsDst, { recursive: true });
cpSync(migrationsSrc, migrationsDst, { recursive: true });
