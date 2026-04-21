#!/usr/bin/env node

import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const publicSrc = path.join(appRoot, "public");
const publicDst = path.join(appRoot, "dist", "public");

mkdirSync(publicDst, { recursive: true });
cpSync(publicSrc, publicDst, { recursive: true });
