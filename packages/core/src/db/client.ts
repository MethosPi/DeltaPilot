import Database from "better-sqlite3";
import type { Database as BetterSqliteDatabase } from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type DrizzleDb = BetterSQLite3Database<typeof schema>;

export interface OpenDatabaseResult {
  raw: BetterSqliteDatabase;
  db: DrizzleDb;
  close: () => void;
}

const MIGRATIONS: ReadonlyArray<{ version: number; file: string }> = [
  { version: 1, file: "migrations/0000_init.sql" },
  { version: 2, file: "migrations/0001_autonomous_pipeline.sql" },
  { version: 3, file: "migrations/0002_task_attachments.sql" },
  { version: 4, file: "migrations/0003_task_archiving.sql" },
];

export function openDatabase(dbPath: string): OpenDatabaseResult {
  const raw = new Database(dbPath);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  raw.pragma("synchronous = NORMAL");

  applyMigrations(raw);

  const db = drizzle(raw, { schema });
  return {
    raw,
    db,
    close: () => raw.close(),
  };
}

function applyMigrations(raw: BetterSqliteDatabase): void {
  raw.exec(`
    CREATE TABLE IF NOT EXISTS _deltapilot_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    (raw.prepare("SELECT version FROM _deltapilot_migrations").all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );

  const insertApplied = raw.prepare(
    "INSERT INTO _deltapilot_migrations (version, applied_at) VALUES (?, ?)",
  );

  for (const { version, file } of MIGRATIONS) {
    if (applied.has(version)) continue;
    const sql = readFileSync(path.join(__dirname, file), "utf8");
    const txn = raw.transaction(() => {
      raw.exec(sql);
      insertApplied.run(version, new Date().toISOString());
    });
    txn();
  }
}
