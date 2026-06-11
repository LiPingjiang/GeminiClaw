// scripts/migrate-memory-layout.ts
import { mkdirSync, existsSync, readdirSync, copyFileSync } from "fs"
import { join } from "path"
import os from "os"

export function migrateMemoryLayout(root: string = join(os.homedir(), ".gemeniclaw")): void {
  const oldWs = join(root, ".workspace")
  const newGlobalDir = join(root, "memory", "global")
  const newDailyDir = join(newGlobalDir, "daily")
  mkdirSync(newDailyDir, { recursive: true })

  // 全局长期记忆
  const oldMem = join(oldWs, "MEMORY.md")
  const newMem = join(newGlobalDir, "MEMORY.md")
  if (existsSync(oldMem) && !existsSync(newMem)) copyFileSync(oldMem, newMem)

  // 全局日记
  const oldDailyDir = join(oldWs, "memory")
  if (existsSync(oldDailyDir)) {
    for (const f of readdirSync(oldDailyDir)) {
      if (!f.endsWith(".md")) continue
      const dst = join(newDailyDir, f)
      if (!existsSync(dst)) copyFileSync(join(oldDailyDir, f), dst)
    }
  }
}

// CLI entry
if (
  process.argv[1]?.endsWith("migrate-memory-layout.ts") ||
  process.argv[1]?.endsWith("migrate-memory-layout.js")
) {
  migrateMemoryLayout()
  console.log("memory layout migration done")
}
