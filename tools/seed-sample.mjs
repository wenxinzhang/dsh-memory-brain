#!/usr/bin/env node
/**
 * 生成完全合成的开放样例数据（不调用模型、不读取任何用户数据）。
 *
 *   node tools/seed-sample.mjs                 # 默认 web/data/loop.db
 *   node tools/seed-sample.mjs --db path --force
 *
 * 生成后打开页面即可看到：示例设备、原子记忆、候选/生效规则、本体实例。
 */
import { existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { createLoopRuntime } from '../lib/loop.js'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const dbPath = resolve(arg('db', 'web/data/loop.db'))
const force = argv.includes('--force')
if (existsSync(dbPath) && !force) {
  console.error(`数据库已存在：${dbPath}\n如确认要重置为合成样例，请加 --force`)
  process.exit(1)
}
if (existsSync(dbPath)) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(dbPath + suffix, { force: true }) } catch {}
  }
}
const rt = createLoopRuntime({ root: process.cwd(), config: { loopDb: dbPath, loopWorker: false, loopEmbedEnabled: false } })
const db = rt.db
const now = new Date().toISOString()
const owner = 'demo-user'
const project = 'demo-project'
const tx = (fn) => { db.exec('BEGIN'); try { fn(); db.exec('COMMIT') } catch (e) { db.exec('ROLLBACK'); throw e } }

tx(() => {
  db.prepare(`INSERT INTO loop_sources(id,source_kind,platform,external_conversation_id,title,owner,project,task,file_name,content_hash,raw_text,imported_at,extraction_status,warnings_json,attachments_json,role_overrides_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'src_sample', 'fixture', 'sample', 'sample-conversation-1', '示例：WELL_SAMPLE 检修约束', owner, project, null, 'sample-conversation.md',
    'sample-hash', '用户：WELL_SAMPLE 现在检修，先不要做参数优化，恢复生产后再进行。\n助手：收到，我不会自动启动优化任务。',
    now, 'extracted', '[]', '[]', '{}')
  const msgs = [
    ['msg_sample_1', 'user', 0, 'WELL_SAMPLE 现在检修，先不要做参数优化，恢复生产后再进行。'],
    ['msg_sample_2', 'assistant', 1, '收到，我不会自动启动优化任务。'],
  ]
  const insMsg = db.prepare(`INSERT INTO loop_messages(id,source_id,external_message_id,parent_id,role,ordinal,content,original_time,timezone,content_hash,attachment_json,warnings_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  for (const m of msgs) insMsg.run(m[0], 'src_sample', m[0], null, m[1], m[2], m[3], now, 'UTC', m[0], '[]', '[]', now)
  const mem = db.prepare(`INSERT INTO loop_memories(id,source_id,type,text,subject,predicate,object_value,normalized_key,scope_type,scope_id,owner,project,task,source_category,confirmation,certainty,status,event_time,recorded_at,version,confidence,sensitive,metadata_json,created_at,updated_at,protected)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  mem.run('mem_sample_1', 'src_sample', 'fact', 'WELL_SAMPLE 当前处于检修状态。', 'WELL_SAMPLE', 'status', 'maintenance', 'sample-key-1', 'artifact', 'WELL_SAMPLE', owner, project, null, 'user_statement', 'stated', 0.95, 'confirmed', null, now, 1, 0.95, 0, '{}', now, now, 1)
  mem.run('mem_sample_2', 'src_sample', 'constraint', 'WELL_SAMPLE 检修期间暂停参数优化。', 'WELL_SAMPLE', 'optimization', 'paused', 'sample-key-2', 'artifact', 'WELL_SAMPLE', owner, project, null, 'user_statement', 'stated', 0.95, 'confirmed', null, now, 1, 0.95, 0, '{}', now, now, 1)
  mem.run('mem_sample_3', 'src_sample', 'preference', '用户偏好先给结论，再给依据。', null, null, null, 'sample-key-3', 'personal', null, owner, project, null, 'user_statement', 'stated', 0.9, 'confirmed', null, now, 1, 0.9, 0, '{}', now, now, 0)
  mem.run('mem_sample_4', 'src_sample', 'method', '先读取历史记录，再执行巡检。', null, null, null, 'sample-key-4', 'project', project, owner, project, null, 'user_statement', 'stated', 0.9, 'confirmed', null, now, 1, 0.9, 0, '{}', now, now, 0)
  const ev = db.prepare('INSERT OR IGNORE INTO loop_memory_evidence(memory_id,message_id,quote) VALUES(?,?,?)')
  ev.run('mem_sample_1', 'msg_sample_1', 'WELL_SAMPLE 现在检修')
  ev.run('mem_sample_2', 'msg_sample_1', '先不要做参数优化')
  ev.run('mem_sample_3', 'msg_sample_2', '收到')
  ev.run('mem_sample_4', 'msg_sample_2', '收到')
  db.prepare('INSERT INTO loop_ontology_instances(id,type_id,name,aliases_json,owner,project,status,candidate,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('inst_sample', 'well', 'WELL_SAMPLE', '[]', owner, project, 'active', 0, now, now)
  db.prepare('INSERT INTO loop_state_history(id,instance_id,state,from_state,reason,created_at) VALUES(?,?,?,?,?,?)').run('st_sample', 'inst_sample', 'maintenance', null, '示例数据', now)
  db.prepare('UPDATE loop_memories SET ontology_instance_id=? WHERE id IN (?,?)').run('inst_sample', 'mem_sample_1', 'mem_sample_2')
  const rule = db.prepare(`INSERT INTO loop_rules(id,name,description,category,scope_type,scope_id,owner,project,object_type,object_id,conditions_json,actions_json,strength,exceptions_json,acceptance,source_category,evidence_json,confidence,confirmation,governance_status,version,structure_status,created_at,updated_at,structure_errors_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  rule.run('rule_sample_1', '示例：检修期间暂停参数优化', '示例规则，可在规则中心模拟评估', 'business_constraint', 'artifact', 'WELL_SAMPLE', owner, project, 'well', 'inst_sample',
    JSON.stringify({ op: 'eq', path: 'well.status', value: 'maintenance' }), JSON.stringify([{ type: 'block', target: 'parameter_optimization' }]), 'must_not', '[]', '状态恢复生产后解除', 'user_statement',
    JSON.stringify([{ message_id: 'msg_sample_1', quote: 'WELL_SAMPLE 现在检修' }]), 0.9, 'confirmed', 'active', 1, 'structured', now, now, '[]')
  rule.run('rule_sample_2', '示例：先结论后依据', '示例候选规则（未生效）', 'personal_preference', 'personal', null, owner, project, 'output', null,
    JSON.stringify({ op: 'eq', path: 'output.type', value: 'solution' }), JSON.stringify([{ type: 'prefer', target: 'conclusion_first' }]), 'prefer', '[]', '先结论再依据', 'user_statement',
    JSON.stringify([{ message_id: 'msg_sample_2', quote: '收到' }]), 0.7, 'candidate', 'candidate', 1, 'invalid_condition', now, now, JSON.stringify(['属性未在本体定义中：output.type']))
})
const counts = {
  sources: db.prepare('SELECT COUNT(*) n FROM loop_sources').get().n,
  memories: db.prepare('SELECT COUNT(*) n FROM loop_memories').get().n,
  rules: db.prepare('SELECT COUNT(*) n FROM loop_rules').get().n,
  instances: db.prepare('SELECT COUNT(*) n FROM loop_ontology_instances').get().n,
}
console.log(JSON.stringify({ ok: true, db: dbPath, counts, note: '合成的开放样例数据；不含任何真实用户数据' }))
rt.close()
