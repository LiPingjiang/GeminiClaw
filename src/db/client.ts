import Database from "better-sqlite3"
import { mkdirSync } from "fs"
import { dirname } from "path"

export type Db = Database.Database

export function openDb(dbPath: string): Db {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  return db
}
