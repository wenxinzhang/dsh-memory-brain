#!/usr/bin/env node
/**
 * 一次性本地迁移：把旧插件目录里的 loop.db 安全复制到新位置。
 *
 * 用法（先完全退出 DeepSeek Harness，避免在写事务中途取快照）：
 *   node tools/migrate-loop-db.mjs <源 loop.db> <目标 loop.db>
 *
 * 用 SQLite 的 VACUUM INTO 生成一致性快照：它把 WAL 中的内容一并折叠进单文件，
 * 比直接复制 .db/-wal/-shm 三件套更安全。目标已存在时拒绝覆盖。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const [from, to] = process.argv.slice(2).map((p) => p && resolve(p))
if (!from || !to) {
  console.error('用法: node tools/migrate-loop-db.mjs <源 loop.db> <目标 loop.db>')
  process.exit(2)
}
if (!existsSync(from)) {
  console.error(`源数据库不存在: ${from}`)
  process.exit(1)
}
if (existsSync(to)) {
  console.error(`目标已存在，拒绝覆盖: ${to}`)
  process.exit(1)
}

const db = new DatabaseSync(from, { readOnly: true })
try {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name)
  db.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`)
  console.log(`已复制: ${from} -> ${to}`)
  console.log(`表: ${tables.join(', ') || '(空)'}`)
} finally {
  db.close()
}
