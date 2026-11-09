// 浏览器验收夹具：规则冲突、权限规则、结构变更候选。仅用于验收库，不写入演示库。
import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'

const dbPath = resolve(process.argv[2] || 'web/data/loop-verify.db')
const db = new DatabaseSync(dbPath)
const now = new Date().toISOString()
const owner = 'local-user'
const rule = db.prepare(`INSERT OR IGNORE INTO loop_rules(id,name,description,category,scope_type,scope_id,owner,project,object_type,object_id,conditions_json,actions_json,strength,exceptions_json,acceptance,source_category,evidence_json,confidence,confirmation,valid_from,valid_to,governance_status,version,structure_status,created_at,updated_at,structure_errors_json)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
rule.run('v4-conflict-a', 'V4 允许调参', '验收冲突 A', 'business_constraint', 'artifact', 'WELL_001', owner, 'demo-project', 'well', null,
  JSON.stringify({ op: 'eq', path: 'well.status', value: 'maintenance' }), JSON.stringify([{ type: 'execute', target: 'parameter_tuning' }]), 'must', '[]', '可执行', 'user_statement', '[]', 0.8, 'confirmed', null, null, 'active', 1, 'structured', now, now, '[]')
rule.run('v4-conflict-b', 'V4 禁止调参', '验收冲突 B', 'business_constraint', 'artifact', 'WELL_001', owner, 'demo-project', 'well', null,
  JSON.stringify({ op: 'eq', path: 'well.status', value: 'maintenance' }), JSON.stringify([{ type: 'block', target: 'parameter_tuning' }]), 'must_not', '[]', '禁止执行', 'user_statement', '[]', 0.8, 'confirmed', null, null, 'active', 1, 'structured', now, now, '[]')
rule.run('v4-permission', 'V4 调参权限', '验收权限规则', 'permission', 'artifact', 'WELL_001', owner, 'demo-project', 'well', null,
  JSON.stringify({ op: 'eq', path: 'well.status', value: 'maintenance' }), JSON.stringify([{ type: 'allow', target: 'parameter_tuning' }]), 'must', '[]', '允许人工授权', 'user_statement', '[]', 0.8, 'confirmed', null, null, 'active', 1, 'structured', now, now, '[]')
db.prepare(`INSERT OR IGNORE INTO loop_ontology_proposals(id,kind,payload_json,status,evidence,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
  .run('v4-proposal-type', 'type', JSON.stringify({ name: 'V4 验收设备', description: '浏览器验收结构候选' }), 'candidate', 'v4-fixture', now, now)
console.log(JSON.stringify({ ok: true, db: dbPath, rules: 3, proposals: 1 }))
db.close()
