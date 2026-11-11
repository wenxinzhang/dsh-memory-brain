import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createLoopRuntime, parseConversation, parseJsonConversation, evaluateCondition } from '../lib/loop.js'

async function request(runtime, path, body = {}, method = 'POST') {
  const req = Readable.from(body === null ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  return new Promise((resolve, reject) => {
    const res = { writeHead(status) { this.status = status }, end(raw) { resolve({ status: this.status, body: JSON.parse(raw) }) } }
    runtime.handle(req, res, new URL(`http://test${path}`), path.split('?')[0]).catch(reject)
  })
}
const get = (rt, path) => request(rt, path, null, 'GET')

function fixture(config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'memory-loop-fixes-'))
  const runtime = createLoopRuntime({ root, config: { loopWorker: false, loopEmbedEnabled: false, ...config } })
  return { runtime, db: runtime.db, close() { runtime.close(); rmSync(root, { recursive: true, force: true }) } }
}
const stamp = () => new Date().toISOString()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function insertRule(f, over = {}) {
  const r = {
    id: `rule_${Math.random().toString(36).slice(2)}`, name: '测试规则', category: 'workflow', source_category: 'user_statement',
    scope_type: 'personal', owner: 'local-user', governance_status: 'active', strength: 'must_not',
    conditions_json: JSON.stringify({ op: 'eq', path: 'well.status', value: 'maintenance' }), actions_json: '[{"type":"block","target":"delete"}]',
    structure_status: 'structured', confirmation: 'confirmed', created_at: stamp(), updated_at: stamp(), ...over,
  }
  f.db.prepare(`INSERT INTO loop_rules(${Object.keys(r).join(',')}) VALUES(${Object.keys(r).map(() => '?').join(',')})`).run(...Object.values(r))
  return r.id
}
function insertMemory(f, over = {}) {
  const m = {
    id: `mem_${Math.random().toString(36).slice(2)}`, type: 'fact', text: '测试事实', subject: null, predicate: null, object_value: null,
    normalized_key: Math.random().toString(36), scope_type: 'personal', owner: 'local-user', source_category: 'user_statement',
    confirmation: 'stated', status: 'confirmed', recorded_at: stamp(), created_at: stamp(), updated_at: stamp(), ...over,
  }
  f.db.prepare(`INSERT INTO loop_memories(${Object.keys(m).join(',')}) VALUES(${Object.keys(m).map(() => '?').join(',')})`).run(...Object.values(m))
  return m.id
}

/** 用宿主聊天模型跑一次自动抽取，output 可以是字符串或函数。 */
async function chatExtract(f, output, messages, { turn = 1, project = null, expect = 'done', waitMs = 5000 } = {}) {
  f.runtime.setChatExtractionModel(async (...args) => typeof output === 'function' ? output(...args) : output)
  const captured = f.runtime.captureChatTurn({ conversation_id: 'fix', turn_id: turn, project, modelSelection: { provider: 'p', model: 'm' }, messages })
  for (let i = 0; i < waitMs / 10; i++) {
    const job = f.db.prepare('SELECT * FROM loop_jobs WHERE id=?').get(captured.job_id)
    if (['done', 'failed', 'partial'].includes(job.status)) { if (expect) assert.equal(job.status, expect, job.error); return { ...captured, job } }
    await sleep(10)
  }
  throw new Error('extraction timeout')
}
const workerFixture = (config = {}) => fixture({ loopWorker: true, loopWorkerIntervalMs: 30, ...config })
const ruleOutput = (rule) => JSON.stringify({ memories: [], rules: [rule], ontology_candidates: [] })
const prefRule = { name: '先给结论', category: 'personal_preference', scope_type: 'personal', strength: 'prefer', conditions: {}, actions: [{ type: 'prefer', target: 'answer_style' }], evidence_message_ids: ['m1'] }

/* ---------------- P1 ---------------- */

test('#1 助手证据的规则在全自动模式下也只留候选，候选也有 v1 快照（#44）', async (t) => {
  const f = workerFixture(); t.after(() => f.close())
  await request(f.runtime, '/rules/review-mode', { mode: 'auto' })
  await chatExtract(f, ruleOutput({ ...prefRule, evidence_message_ids: ['m2'] }), [{ role: 'user', content: '怎么回答比较好' }, { role: 'assistant', content: '建议以后先给结论' }])
  const rule = f.db.prepare('SELECT * FROM loop_rules').get()
  assert.equal(rule.governance_status, 'candidate')
  assert.equal(rule.source_category, 'model_suggestion')
  assert.ok(f.db.prepare("SELECT detail_json FROM loop_audit WHERE action='rule.candidate'").get().detail_json.includes('助手'))
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM loop_rule_versions WHERE rule_id=?').get(rule.id).n, 1)
})

test('#2a 空条件规则仍先检查例外', async (t) => {
  const f = fixture(); t.after(() => f.close())
  const id = insertRule(f, { conditions_json: '{}', exceptions_json: JSON.stringify([{ op: 'eq', path: 'well.status', value: 'maintenance' }]) })
  const hit = await request(f.runtime, `/rules/${id}/simulate`, { context: { well: { status: 'maintenance' } } })
  assert.equal(hit.body.result, 'not_applicable')
  const miss = await request(f.runtime, `/rules/${id}/simulate`, { context: { well: { status: 'production' } } })
  assert.equal(miss.body.result, 'applicable')
})

test('#2b 手动模式下无条件规则可以批准', async (t) => {
  const f = fixture(); t.after(() => f.close())
  const id = insertRule(f, { governance_status: 'candidate', confirmation: 'candidate', conditions_json: '{}', structure_status: 'unstructured' })
  const out = await request(f.runtime, `/rules/${id}/approve`, {})
  assert.equal(out.status, 200, out.body.error)
  assert.equal(out.body.rule.governance_status, 'active')
})

test('#2c 自动生效的无条件规则是 structured，暂停后可恢复', async (t) => {
  const f = workerFixture(); t.after(() => f.close())
  await chatExtract(f, ruleOutput(prefRule), [{ role: 'user', content: '以后回答先给结论' }])
  const rule = f.db.prepare('SELECT * FROM loop_rules').get()
  assert.equal(rule.governance_status, 'active')
  assert.equal(rule.structure_status, 'structured')
  assert.equal((await request(f.runtime, `/rules/${rule.id}/pause`, {})).status, 200)
  const resumed = await request(f.runtime, `/rules/${rule.id}/resume`, {})
  assert.equal(resumed.status, 200, resumed.body.error)
  assert.equal(resumed.body.rule.governance_status, 'active')
})

test('#3 #24 确认记忆后映射本体，生产→检修按类型全部转换判定为合法', async (t) => {
  const f = fixture(); t.after(() => f.close())
  const a = insertMemory(f, { text: 'WELL_7 处于生产', status: 'proposed', confirmation: 'suggested', source_category: 'model_suggestion' })
  assert.equal((await request(f.runtime, `/memories/${a}/correct`, { action: 'confirm' })).status, 200)
  await sleep(5)
  const b = insertMemory(f, { text: 'WELL_7 已进入检修', status: 'proposed', confirmation: 'suggested', source_category: 'model_suggestion' })
  const confirmed = await request(f.runtime, `/memories/${b}/correct`, { action: 'confirm' })
  assert.equal(confirmed.body.memory.version, 2)
  const inst = f.db.prepare("SELECT id FROM loop_ontology_instances WHERE name='WELL_7'").get()
  assert.deepEqual(f.db.prepare('SELECT state FROM loop_state_history WHERE instance_id=? ORDER BY created_at').all(inst.id).map((r) => r.state), ['production', 'maintenance'])
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM loop_ontology_proposals WHERE kind='state_transition'").get().n, 0)
})

test('#4 无主语谓语的记忆不互判冲突；模型建议不把已确认事实拖进冲突组', async (t) => {
  const f = workerFixture(); t.after(() => f.close())
  await chatExtract(f, JSON.stringify({ memories: [
    { type: 'preference', text: '喜欢简洁的回答', evidence_message_ids: ['m1'] },
    { type: 'fact', text: '项目使用 TypeScript', evidence_message_ids: ['m1'] },
    { type: 'fact', text: 'WELL_8 产量 5', subject: 'WELL_8', predicate: '产量', object: '5', evidence_message_ids: ['m1'] },
    { type: 'fact', text: 'WELL_8 产量可能是 9', subject: 'WELL_8', predicate: '产量', object: '9', evidence_message_ids: ['m2'] },
  ] }), [{ role: 'user', content: '我喜欢简洁，项目用 TypeScript，WELL_8 产量 5' }, { role: 'assistant', content: 'WELL_8 产量可能是 9' }])
  const rows = Object.fromEntries(f.db.prepare('SELECT text,status,conflict_group FROM loop_memories').all().map((r) => [r.text, r]))
  assert.equal(rows['喜欢简洁的回答'].status, 'confirmed')
  assert.equal(rows['项目使用 TypeScript'].status, 'confirmed')
  assert.equal(rows['WELL_8 产量 5'].conflict_group, null)
  assert.equal(rows['WELL_8 产量可能是 9'].status, 'proposed')
})

test('#5 增量追加消息只重抽变化的分块，同一规则不生效两份', async (t) => {
  const f = workerFixture(); t.after(() => f.close())
  const oldFetch = globalThis.fetch; t.after(() => { globalThis.fetch = oldFetch })
  let calls = 0
  globalThis.fetch = async (_url, opts) => {
    calls++
    const tag = JSON.parse(opts.body).messages.at(-1).content.match(/\[(m\d+)\]/)[1]
    return { ok: true, json: async () => ({ choices: [{ message: { content: ruleOutput({ ...prefRule, evidence_message_ids: [tag] }) } }] }) }
  }
  const base = Array.from({ length: 12 }, (_, i) => ({ role: 'user', content: `第 ${i + 1} 条：以后回答先给结论` }))
  const run = async (messages) => {
    const out = await request(f.runtime, '/import', { text: JSON.stringify({ messages }), format: 'json', externalConversationId: 'inc-1', autoExtract: true })
    for (let i = 0; i < 500; i++) { const job = f.db.prepare('SELECT status,error FROM loop_jobs WHERE id=?').get(out.body.job_id); if (['done', 'failed', 'partial'].includes(job.status)) { assert.equal(job.status, 'done', job.error); return } await sleep(10) }
    throw new Error('timeout')
  }
  await run(base)
  assert.equal(calls, 1)
  await run([...base, { role: 'user', content: '新增：以后回答先给结论' }])
  assert.equal(calls, 2)
  const rules = f.db.prepare('SELECT * FROM loop_rules').all()
  assert.equal(rules.length, 1)
  assert.equal(JSON.parse(rules[0].evidence_json).length, 2)
})

test('#6 #25 state 反馈纠正记忆不再报错，object_value 保留原值', async (t) => {
  const f = fixture(); t.after(() => f.close())
  const id = insertMemory(f, { text: 'WELL_1 压力 5', subject: 'WELL_1', predicate: '压力', object_value: '5' })
  const out = await request(f.runtime, '/feedback', { category: 'state', memory_id: id, correction: { text: 'WELL_1 压力应为 6 MPa' } })
  assert.equal(out.status, 200, out.body.error)
  assert.equal(out.body.applied.kind, 'memory_correction')
  const row = f.db.prepare('SELECT * FROM loop_memories WHERE id=?').get(out.body.applied.id)
  assert.equal(row.object_value, '5')
  assert.equal(f.db.prepare('SELECT status FROM loop_memories WHERE id=?').get(id).status, 'superseded')
})

test('#7 软规则与 allow 动作只作建议，不产生 denied/blocked', async (t) => {
  const f = fixture(); t.after(() => f.close())
  insertRule(f, { strength: 'prefer', conditions_json: '{}', actions_json: '[{"type":"prefer","target":"write_file"}]' })
  insertRule(f, { strength: 'must', conditions_json: '{}', actions_json: '[{"type":"allow","target":"write_file"}]' })
  const out = await f.runtime.checkAction({ action: { type: 'write_file', target: 'write_file' } })
  assert.ok(!['denied', 'blocked'].includes(out.result), out.result)
  assert.equal(out.result, 'advisory')
})

test('#8 没写 target 的禁止动作返回需要确认，而不是拦截所有工具', async (t) => {
  const f = fixture(); t.after(() => f.close())
  insertRule(f, { conditions_json: '{}', actions_json: '[{"type":"block"}]' })
  const out = await f.runtime.checkAction({ action: { type: 'read_file', target: 'read_file' } })
  assert.equal(out.result, 'pending_authorization')
})

test('#9a 候选规则不能暂停后恢复绕过审核；恢复重跑校验', async (t) => {
  const f = fixture(); t.after(() => f.close())
  const cand = insertRule(f, { governance_status: 'candidate', confirmation: 'candidate' })
  assert.equal((await request(f.runtime, `/rules/${cand}/pause`, {})).status, 409)
  f.db.prepare("UPDATE loop_rules SET governance_status='paused' WHERE id=?").run(cand)
  assert.equal((await request(f.runtime, `/rules/${cand}/resume`, {})).status, 409)
  const noAction = insertRule(f, { governance_status: 'paused', confirmation: 'auto_approved', actions_json: '[]' })
  assert.equal((await request(f.runtime, `/rules/${noAction}/resume`, {})).status, 400)
  assert.equal(f.db.prepare('SELECT governance_status FROM loop_rules WHERE id=?').get(noAction).governance_status, 'paused')
})

test('#9b 只能批准候选；同一旧规则只能有一个生效替代版本', async (t) => {
  const f = fixture(); t.after(() => f.close())
  const old = insertRule(f)
  assert.equal((await request(f.runtime, `/rules/${old}/approve`, {})).status, 409)
  const a = insertRule(f, { governance_status: 'candidate', confirmation: 'candidate', supersedes_id: old })
  const b = insertRule(f, { governance_status: 'candidate', confirmation: 'candidate', supersedes_id: old })
  assert.equal((await request(f.runtime, `/rules/${a}/approve`, {})).status, 200)
  assert.equal((await request(f.runtime, `/rules/${b}/approve`, {})).status, 409)
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM loop_rules WHERE supersedes_id=? AND governance_status='active'").get(old).n, 1)
})

test('#9c 已替代记忆不能复活或重复纠正', async (t) => {
  const f = fixture(); t.after(() => f.close())
  const id = insertMemory(f)
  assert.equal((await request(f.runtime, `/memories/${id}/correct`, { action: 'supersede', text: '纠正一' })).status, 200)
  assert.equal((await request(f.runtime, `/memories/${id}/correct`, { action: 'supersede', text: '纠正二' })).status, 409)
  assert.equal((await request(f.runtime, `/memories/${id}/correct`, { action: 'confirm' })).status, 409)
  assert.equal((await request(f.runtime, `/memories/${id}`, { text: '复活' }, 'PATCH')).status, 409)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM loop_memories WHERE supersedes_id=?').get(id).n, 1)
})

test('#10 #19 本体回滚只暂停生效规则、候选只记错误、已替代不动；类型开头的路径也纳入影响', async (t) => {
  const f = fixture(); t.after(() => f.close())
  const baseline = (await get(f.runtime, '/ontology/versions')).body.items.find((v) => v.action === 'baseline')
  f.db.prepare("INSERT INTO loop_ontology_proposals(id,kind,payload_json,status,created_at,updated_at) VALUES('p1','property',?, 'candidate',?,?)").run(JSON.stringify({ type: 'well', name: 'temp', datatype: 'number' }), stamp(), stamp())
  assert.equal((await request(f.runtime, '/ontology/proposals/p1/approve', {})).status, 200)
  const cond = JSON.stringify({ op: 'gt', path: 'well.temp', value: 80 })
  const active = insertRule(f, { conditions_json: cond, version: 3 })
  const cand = insertRule(f, { conditions_json: cond, governance_status: 'candidate', confirmation: 'candidate' })
  const old = insertRule(f, { conditions_json: cond, governance_status: 'superseded' })
  f.db.prepare("INSERT INTO loop_rule_versions(id,rule_id,version,payload_json,created_at) VALUES('rv-x',?,3,'{}',?)").run(active, stamp())
  const out = await request(f.runtime, `/ontology/versions/${baseline.id}/rollback`, { confirm_impact: true })
  assert.equal(out.status, 200, out.body.error)
  const st = (id) => f.db.prepare('SELECT governance_status,structure_errors_json,version FROM loop_rules WHERE id=?').get(id)
  assert.equal(st(active).governance_status, 'paused')
  assert.equal(st(active).version, 4)
  assert.equal(st(cand).governance_status, 'candidate')
  assert.ok(JSON.parse(st(cand).structure_errors_json).length > 0)
  assert.equal(st(old).governance_status, 'superseded')
  const versions = f.db.prepare('SELECT version FROM loop_rule_versions WHERE rule_id=?').all(active).map((r) => r.version)
  assert.equal(new Set(versions).size, versions.length)
})

/* ---------------- P2 ---------------- */

test('#11 宿主模型不理会 signal 时按超时结束，任务不会永久 running', { timeout: 60_000 }, async (t) => {
  const f = workerFixture({ loopTimeoutMs: 20_000, loopJobMaxAttempts: 1 }); t.after(() => f.close())
  const out = await chatExtract(f, () => new Promise(() => {}), [{ role: 'user', content: '以后先给结论' }], { expect: null, waitMs: 40_000 })
  assert.equal(out.job.status, 'failed')
  assert.match(out.job.error, /超时/)
})

test('#12 模型临时不可用时按 max_attempts 重新入队', async (t) => {
  const f = workerFixture({ loopJobMaxAttempts: 3 }); t.after(() => f.close())
  let attempts = 0
  const out = await chatExtract(f, async () => { attempts++; if (attempts < 3) throw new Error('暂时不可用'); return '{"memories":[]}' }, [{ role: 'user', content: '以后先给结论' }])
  assert.equal(out.job.attempts, 3)
})

test('#13 规则标量字段是对象时不让整块回滚', async (t) => {
  const f = workerFixture(); t.after(() => f.close())
  await chatExtract(f, JSON.stringify({
    memories: [{ type: 'preference', text: '回答先给结论', evidence_message_ids: ['m1'] }],
    rules: [{ ...prefRule, scope_id: { bad: 1 }, trigger_event: { x: 1 }, name: { y: 2 } }],
  }), [{ role: 'user', content: '以后回答先给结论' }])
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM loop_memories').get().n, 1)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM loop_rules').get().n, 1)
})

test('#14 用户随后陈述同一内容时，模型建议记忆升级为已确认', async (t) => {
  const f = workerFixture(); t.after(() => f.close())
  const mem = (ev) => JSON.stringify({ memories: [{ type: 'preference', text: '回答先给结论', evidence_message_ids: [ev] }] })
  await chatExtract(f, mem('m2'), [{ role: 'user', content: '怎么回答' }, { role: 'assistant', content: '建议回答先给结论' }], { turn: 1 })
  assert.equal(f.db.prepare('SELECT status FROM loop_memories').get().status, 'proposed')
  await chatExtract(f, mem('m1'), [{ role: 'user', content: '回答先给结论' }], { turn: 2 })
  const rows = f.db.prepare('SELECT * FROM loop_memories').all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'confirmed')
  assert.equal(rows[0].source_category, 'user_statement')
  assert.ok(f.db.prepare('SELECT COUNT(*) n FROM loop_memory_versions WHERE memory_id=?').get(rows[0].id).n >= 1)
})

test('#15 归档来源不再被追加；原样重复导入不改状态不建批次', async (t) => {
  const f = fixture(); t.after(() => f.close())
  const body = (messages) => ({ text: JSON.stringify({ messages }), format: 'json', externalConversationId: 'ext-15' })
  const one = [{ role: 'user', content: '第一条' }]
  const first = await request(f.runtime, '/import', body(one))
  const src = first.body.source.id
  f.db.prepare("UPDATE loop_sources SET extraction_status='extracted' WHERE id=?").run(src)
  const batches = () => f.db.prepare('SELECT COUNT(*) n FROM loop_batches WHERE source_id=?').get(src).n
  const before = batches()
  const again = await request(f.runtime, '/import', body(one))
  assert.equal(again.body.appended, 0)
  assert.equal(f.db.prepare('SELECT extraction_status FROM loop_sources WHERE id=?').get(src).extraction_status, 'extracted')
  assert.equal(batches(), before)
  assert.equal((await request(f.runtime, `/imports/${src}/archive`, {})).status, 200)
  const more = await request(f.runtime, '/import', body([...one, { role: 'user', content: '第二条' }]))
  assert.notEqual(more.body.source.id, src)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM loop_messages WHERE source_id=?').get(src).n, 1)
})

test('#16 ChatGPT 官方 conversations.json 取最近更新的会话', () => {
  const conv = (title, update, text) => ({ title, update_time: update, mapping: { a: { message: { author: { role: 'user' }, content: { parts: [text] }, create_time: 1 }, parent: null } } })
  const parsed = parseConversation(JSON.stringify([conv('旧', 10, '旧消息'), conv('新', 20, '新消息')]))
  assert.equal(parsed.messages[0].content, '新消息')
  assert.equal(parsed.conversations, 2)
  assert.ok(parsed.warnings.some((w) => w.includes('2 个会话')))
})

test('#17 以 [时间] 开头的文本在 auto 探测下按文本解析', () => {
  const parsed = parseConversation(['[2026-11-10 10:00] 用户：你好', '助手：你好，有什么可以帮你'].join('\n'))
  assert.equal(parsed.format, 'text')
  assert.deepEqual(parsed.messages.map((m) => m.role), ['user', 'assistant'])
})

test('#18 规则按名称绑定实例时本项目优先', async (t) => {
  const f = workerFixture(); t.after(() => f.close())
  for (const [id, project] of [['inst-other', 'other'], ['inst-mine', 'p1']]) f.db.prepare("INSERT INTO loop_ontology_instances(id,type_id,name,owner,project,status,candidate,created_at,updated_at) VALUES(?,'well','WELL_X','local-user',?,'active',0,?,?)").run(id, project, stamp(), stamp())
  await chatExtract(f, ruleOutput({ ...prefRule, scope_id: 'WELL_X' }), [{ role: 'user', content: 'WELL_X 以后先给结论' }], { project: 'p1' })
  assert.equal(f.db.prepare('SELECT object_id FROM loop_rules').get().object_id, 'inst-mine')
})

test('#20 and 中任一分支确定为假则整体确定为假', () => {
  const r = evaluateCondition({ op: 'and', args: [{ op: 'eq', path: 'a', value: 1 }, { op: 'eq', path: 'b', value: 2 }] }, { a: 2 })
  assert.equal(r.value, false)
  assert.equal(r.unknown, false)
})

test('#21 生效规则改成非法条件后退回候选', async (t) => {
  const f = fixture(); t.after(() => f.close())
  const id = insertRule(f)
  const out = await request(f.runtime, `/rules/${id}`, { conditions: { op: 'eq', path: 'well.nope', value: 1 } }, 'PATCH')
  assert.equal(out.body.rule.governance_status, 'candidate')
  assert.equal(out.body.requires_reapproval, true)
})

test('#22 字符串例外不能批准生效', async (t) => {
  const f = fixture(); t.after(() => f.close())
  const id = insertRule(f, { governance_status: 'candidate', confirmation: 'candidate', exceptions_json: '"周末除外"' })
  assert.equal((await request(f.runtime, `/rules/${id}/approve`, {})).status, 400)
  const id2 = insertRule(f, { governance_status: 'candidate', confirmation: 'candidate', exceptions_json: '["周末除外"]' })
  assert.equal((await request(f.runtime, `/rules/${id2}/approve`, {})).status, 400)
})

test('#23 supersede activate 的新规则权威不是模型建议', async (t) => {
  const f = fixture(); t.after(() => f.close())
  const id = insertRule(f)
  const out = await request(f.runtime, `/rules/${id}/supersede`, { activate: true, name: '新版' })
  assert.equal(out.status, 200, out.body.error)
  assert.equal(out.body.rule.confirmation, 'confirmed')
  assert.notEqual(out.body.rule.authority, 'model_suggestion')
})

test('#25 纠正的 normalized_key 与抽取时的 key 规则一致', async (t) => {
  const f = workerFixture(); t.after(() => f.close())
  const id = insertMemory(f, { text: '旧', subject: 'S', predicate: 'P', object_value: 'V' })
  const out = await request(f.runtime, `/memories/${id}/correct`, { action: 'supersede', text: '新说法' })
  assert.equal(out.body.memory.object_value, 'V')
  await chatExtract(f, JSON.stringify({ memories: [{ type: 'fact', text: '新说法', subject: 'S', predicate: 'P', object: 'V', scope_type: 'personal', evidence_message_ids: ['m1'] }] }), [{ role: 'user', content: '新说法' }])
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM loop_memories WHERE text='新说法'").get().n, 1)
})

test('#26 PATCH 记忆的对象型 object_value 存 JSON', async (t) => {
  const f = fixture(); t.after(() => f.close())
  const id = insertMemory(f)
  const out = await request(f.runtime, `/memories/${id}`, { object_value: { v: 5, unit: 'MPa' } }, 'PATCH')
  assert.equal(out.body.memory.object_value, '{"v":5,"unit":"MPa"}')
  const s = await request(f.runtime, `/memories/${id}`, { object_value: '  文本  ' }, 'PATCH')
  assert.equal(s.body.memory.object_value, '文本')
})

test('#27 撤回旧规则不动已替代版本；重新采纳取最新版本并恢复为候选', async (t) => {
  const f = fixture(); t.after(() => f.close())
  const first = f.runtime.importLegacyRule({ id: 'L1', type: 'workflow', condition: '部署前', action: '先跑测试' })
  f.db.prepare("UPDATE loop_rules SET governance_status='superseded' WHERE id=?").run(first)
  const evidence = f.db.prepare('SELECT evidence_json FROM loop_rules WHERE id=?').get(first).evidence_json
  await sleep(5)
  const second = insertRule(f, { evidence_json: evidence, supersedes_id: first })
  f.runtime.withdrawLegacyRule('L1')
  assert.equal(f.db.prepare('SELECT governance_status FROM loop_rules WHERE id=?').get(first).governance_status, 'superseded')
  assert.equal(f.db.prepare('SELECT governance_status FROM loop_rules WHERE id=?').get(second).governance_status, 'paused')
  assert.equal(f.runtime.importLegacyRule({ id: 'L1', type: 'workflow', action: '先跑测试' }), second)
  assert.equal(f.db.prepare('SELECT governance_status FROM loop_rules WHERE id=?').get(second).governance_status, 'candidate')
})

test('#28 长查询后半段的关键词仍参与召回', async (t) => {
  const f = fixture(); t.after(() => f.close())
  insertMemory(f, { text: 'zebra crossing' })
  const filler = Array.from({ length: 30 }, (_, i) => `w${i}x`).join(' ')
  const ctx = await f.runtime.buildContext({ query: `${filler} zebra` })
  assert.ok(ctx.sections.retrieval.top[0].matched.includes('zebra'))
})

test('#29 建议区先按范围过滤再取前 80 条', async (t) => {
  const f = fixture(); t.after(() => f.close())
  insertMemory(f, { text: '本项目建议', status: 'proposed', project: 'p1', scope_type: 'project', scope_id: 'p1', created_at: '2020-01-01T00:00:00.000Z' })
  for (let i = 0; i < 85; i++) insertMemory(f, { text: `别的项目 ${i}`, status: 'proposed', project: 'other' })
  const ctx = await f.runtime.buildContext({ project: 'p1' })
  assert.ok(ctx.sections.suggestions.some((s) => s.text === '本项目建议'))
})

test('#30 按 id 访问的路由显式传 owner 时做隔离', async (t) => {
  const f = fixture(); t.after(() => f.close())
  const imp = await request(f.runtime, '/import', { text: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }), format: 'json', owner: 'alice' })
  const batch = imp.body.batch_id; const src = imp.body.source.id
  assert.equal((await get(f.runtime, `/batches/${batch}?owner=bob`)).status, 404)
  assert.equal((await get(f.runtime, `/batches/${batch}?owner=alice`)).status, 200)
  assert.equal((await get(f.runtime, `/batches?owner=bob&source_id=${src}`)).body.items.length, 0)
  assert.equal((await request(f.runtime, `/batches/${batch}/retry`, { owner: 'bob' })).status, 404)
  assert.equal((await request(f.runtime, `/import/${src}/extract`, { owner: 'bob' })).status, 404)
  const mem = insertMemory(f, { owner: 'alice' })
  assert.equal((await get(f.runtime, `/memories/${mem}/versions?owner=bob`)).status, 404)
  const rule = insertRule(f, { owner: 'alice' })
  assert.equal((await get(f.runtime, `/rules/${rule}/versions?owner=bob`)).status, 404)
  assert.equal((await get(f.runtime, `/rules/${rule}/versions?owner=alice`)).status, 200)
})

test('#31 图谱按项目过滤规则/对象、排除已替代规则，limit 负数不绕过上限', async (t) => {
  const f = fixture(); t.after(() => f.close())
  insertRule(f, { id: 'r-mine', project: 'p1' }); insertRule(f, { id: 'r-other', project: 'other' }); insertRule(f, { id: 'r-old', project: 'p1', governance_status: 'superseded' })
  for (let i = 0; i < 3; i++) insertMemory(f)
  const g = (await get(f.runtime, '/graph?project=p1')).body
  const ruleIds = g.nodes.filter((n) => n.type === 'rule').map((n) => n.id)
  assert.deepEqual(ruleIds, ['r:r-mine'])
  assert.equal((await get(f.runtime, '/graph?limit=-5')).body.counts.memories, 1)
})

/* ---------------- P3 ---------------- */

test('#33 取消排队中的抽取任务后来源恢复 raw_saved', async (t) => {
  const f = fixture(); t.after(() => f.close())
  const imp = await request(f.runtime, '/import', { text: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }), format: 'json', autoExtract: true })
  assert.equal(f.db.prepare('SELECT extraction_status FROM loop_sources WHERE id=?').get(imp.body.source.id).extraction_status, 'queued')
  assert.equal((await request(f.runtime, `/jobs/${imp.body.job_id}/cancel`, {})).status, 200)
  assert.equal(f.db.prepare('SELECT extraction_status FROM loop_sources WHERE id=?').get(imp.body.source.id).extraction_status, 'raw_saved')
})

test('#34 消息数组里的 null 元素被跳过', () => {
  const parsed = parseJsonConversation({ messages: [null, { role: 'user', content: 'hi' }, 3] })
  assert.equal(parsed.messages.length, 1)
})

test('#35 #48 project.status 枚举是合法 JSON，证据 message_id 有索引', async (t) => {
  const f = fixture(); t.after(() => f.close())
  assert.deepEqual(JSON.parse(f.db.prepare("SELECT enum_json FROM loop_ontology_props WHERE id='prop_project_status'").get().enum_json), ['active', 'paused', 'done', 'archived'])
  assert.ok(f.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_loop_mem_evidence_msg'").get())
})

test('#37 租约过期且已达最大尝试次数的任务直接失败', async (t) => {
  const f = workerFixture(); t.after(() => f.close())
  f.db.prepare("INSERT INTO loop_jobs(id,type,status,attempts,max_attempts,lease_owner,lease_until,idempotency_key,created_at,updated_at) VALUES('job-x','extract','running',3,3,'w','2000-01-01T00:00:00.000Z','k',?,?)").run(stamp(), stamp())
  for (let i = 0; i < 100 && f.db.prepare("SELECT status FROM loop_jobs WHERE id='job-x'").get().status === 'running'; i++) await sleep(10)
  const job = f.db.prepare("SELECT status,error FROM loop_jobs WHERE id='job-x'").get()
  assert.equal(job.status, 'failed')
  assert.match(job.error, /最大尝试次数/)
})

test('#39 搜索中的 % 与 _ 按字面匹配', async (t) => {
  const f = fixture(); t.after(() => f.close())
  insertMemory(f, { text: 'abc' }); insertMemory(f, { text: '完成 50% 进度' })
  const out = (await get(f.runtime, '/search?q=%25')).body
  assert.deepEqual(out.items.map((i) => i.title), ['完成 50% 进度'])
})

test('#40 参数校验错误仍是 400，内部异常是 500', async (t) => {
  const f = fixture(); t.after(() => f.close())
  assert.equal((await request(f.runtime, '/preview', { text: '' })).status, 400)
  assert.equal((await request(f.runtime, '/import', { text: '{"messages":[]}', format: 'json' })).status, 400)
  f.db.exec("CREATE TRIGGER boom BEFORE INSERT ON loop_feedback BEGIN SELECT RAISE(ABORT, 'boom'); END")
  assert.equal((await request(f.runtime, '/feedback', { outcome: 'ok' })).status, 500)
})

test('#41 规则列表显示 keep_both / disable_both 裁决', async (t) => {
  const f = fixture(); t.after(() => f.close())
  insertRule(f, { id: 'ra', strength: 'must', actions_json: '[{"type":"execute","target":"x"}]' })
  insertRule(f, { id: 'rb', strength: 'must_not', actions_json: '[{"type":"block","target":"x"}]' })
  const key = (await get(f.runtime, '/rules/conflicts')).body.items[0].key
  await request(f.runtime, `/rules/conflicts/${encodeURIComponent(key)}/resolve`, { resolution: 'keep_both' })
  const rows = (await get(f.runtime, '/rules')).body.items
  assert.equal(rows.find((r) => r.id === 'ra').conflicts[0].resolution, 'keep_both')
})

test('#42 数值属性拒绝 null 与空串', async (t) => {
  const f = fixture(); t.after(() => f.close())
  f.db.prepare("INSERT INTO loop_ontology_instances(id,type_id,name,owner,status,candidate,created_at,updated_at) VALUES('w1','well','W1','local-user','active',0,?,?)").run(stamp(), stamp())
  for (const value of [null, '']) assert.equal((await request(f.runtime, '/ontology/instances/w1/props', { name: 'oil_rate', value })).status, 409)
  assert.equal((await request(f.runtime, '/ontology/instances/w1/props', { name: 'oil_rate', value: '0' })).status, 200)
})

test('#43 数值属性的条件值存成数字', async (t) => {
  const f = fixture(); t.after(() => f.close())
  const id = insertRule(f)
  const out = await request(f.runtime, `/rules/${id}`, { conditions: { op: 'gt', path: 'well.oil_rate', value: '5' } }, 'PATCH')
  assert.equal(out.body.rule.conditions.value, 5)
  const sim = await request(f.runtime, `/rules/${id}/simulate`, { context: { well: { oil_rate: 6 } } })
  assert.equal(sim.body.result, 'applicable')
})

test('#47 推断会话范围时匹配全局对象', async (t) => {
  const f = fixture(); t.after(() => f.close())
  f.db.prepare("INSERT INTO loop_ontology_instances(id,type_id,name,owner,status,candidate,created_at,updated_at) VALUES('g1','well','GW_1','local-user','active',0,?,?)").run(stamp(), stamp())
  const scope = f.runtime.inferConversationScope({ cwd: '/work/proj', query: '看看 GW_1 的情况' })
  assert.equal(scope.object_id, 'g1')
})
