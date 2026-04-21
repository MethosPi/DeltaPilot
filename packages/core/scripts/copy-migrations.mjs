#!/usr/bin/env node

import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..");
const srcDir = path.join(pkgRoot, "src", "db", "migrations");
const destDir = path.join(pkgRoot, "dist", "db", "migrations");

await mkdir(destDir, { recursive: true });

for (const entry of await readdir(srcDir)) {
  await copyFile(path.join(srcDir, entry), path.join(destDir, entry));
}
