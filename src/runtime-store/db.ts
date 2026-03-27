import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { RUNTIME_STORE_SCHEMA } from "./schema.js";

export function openRuntimeDatabase(dbPath: string): Database {
  const resolved = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new Database(resolved, { create: true, strict: true });
  db.exec("pragma foreign_keys = on;");
  db.exec("pragma journal_mode = wal;");
  db.exec(RUNTIME_STORE_SCHEMA);
  return db;
}
