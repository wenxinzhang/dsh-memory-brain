import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLoopRuntime } from '../lib/loop.js'
import { Readable } from 'node:stream'

async function request(runtime, path, body = {}, method = 'POST') {
  const req = Readable.from(body === null ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  return new Promise((resolve, reject) => {
    const res = { writeHead(status) { this.status = status }, end(raw) { resolve({ status: this.status, body: JSON.parse(raw) }) } }
    runtime.handle(req, res, new URL(`http://test${path}`), path).catch(reject)
  })
}

function fixture(config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'memory-review-mode-'))
  const runtime = createLoopRuntime({ root, config: { loopWorker: true, loopWorkerIntervalMs: 30, loopEmbedEnabled: false, ...config } })
  return { runtime, close() { runtime.close(); rmSync(root, { recursive: true, force: true }) } }
}

// 两条规则：普通偏好（半自动应自动生效）+ 业务硬性禁令（必须人工）
const MODEL_OUTPUT = JSON.stringify({
  memories: [],
  rules: [
    { name: '先给结论', description: '回答先给结论', category: 'personal_preference', scope_type: 'personal', strength: 'prefer', conditions: {}, actions: [{ type: 'prefer', target: 'answer_style' }], evidence_message_ids: ['m1'], confidence: 0.8 },
    { name: '检修禁止优化', description: 'WELL_9 检修期间禁止参数优化', category: 'business_constraint', scope_type: 'artifact', scope_id: 'WELL_9', strength: 'must_not', conditions: { op: 'eq', path: 'well.status', value: 'maintenance' }, actions: [{ type: 'block', target: 'parameter_optimization' }], evidence_message_ids: ['m1'], confidence: 0.9 },
  ],
  ontology_candidates: [],
})

async function runExtraction(f, messages = [{ role: 'user', content: 'WELL_9 检修期间先不要做参数优化，回答请先给结论' }]) {
  f.runtime.setChatExtractionModel(async () => MODEL_OUTPUT)
  const captured = f.runtime.captureChatTurn({ conversation_id: 's-rm', turn_id: 't1', modelSelection: { provider: 'p', model: 'm' }, messages })
  for (let i = 0; i < 300; i++) {
    const job = f.runtime.db.prepare('SELECT status,error FROM loop_jobs WHERE id=?').get(captured.job_id)
    if (['done', 'failed', 'partial'].includes(job.status)) { assert.equal(job.status, 'done', job.error); return }
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('extraction job timeout')
}
const ruleRows = (f) => Object.fromEntries(f.runtime.db.prepare('SELECT name,governance_status,confirmation FROM loop_rules').all().map((r) => [r.name, r]))

test('半自动（默认）：普通规则自动生效，业务硬性禁令保留候选', async t => {
  const f = fixture(); t.after(() => f.close())
  const mode = await request(f.runtime, '/rules/review-mode', null, 'GET')
  assert.equal(mode.body.mode, 'semi')
  assert.deepEqual(mode.body.modes.map((m) => m.id), ['auto', 'semi', 'manual'])
  await runExtraction(f)
  const rows = ruleRows(f)
  assert.equal(rows['先给结论'].governance_status, 'active')
  assert.equal(rows['先给结论'].confirmation, 'auto_approved')
  assert.equal(rows['检修禁止优化'].governance_status, 'candidate')
  const audit = f.runtime.db.prepare("SELECT count(*) n FROM loop_audit WHERE action='rule.auto_approved'").get().n
  assert.equal(audit, 1)
  // 半自动生效的规则进入上下文适用规则集，候选的不进
  const ctx = await f.runtime.buildContext({ owner: 'local-user', project: null, query: '参数优化', limit: 10 })
  const names = ((ctx.sections && ctx.sections.rules) || ctx.rules || []).map((r) => r.name)
  assert.ok(names.includes('先给结论'), JSON.stringify(names))
  assert.ok(!names.includes('检修禁止优化'))
})

test('全自动：结构合法的规则一律自动生效；结构不合法仍候选', async t => {
  const f = fixture(); t.after(() => f.close())
  const set = await request(f.runtime, '/rules/review-mode', { mode: 'auto' })
  assert.equal(set.body.ok, true); assert.equal(set.body.mode, 'auto'); assert.equal(set.body.previous, 'semi')
  f.runtime.setChatExtractionModel(async () => JSON.stringify({
    memories: [],
    rules: [
      { name: '检修禁止优化', description: 'd', category: 'business_constraint', scope_type: 'artifact', scope_id: 'WELL_9', strength: 'must_not', conditions: { op: 'eq', path: 'well.status', value: 'maintenance' }, actions: [{ type: 'block', target: 'x' }], evidence_message_ids: ['m1'] },
      { name: '始终适用规则', description: 'd', category: 'workflow', scope_type: 'personal', strength: 'prefer', conditions: {}, actions: [{ type: 'prefer', target: 'x' }], evidence_message_ids: ['m1'] },
      { name: '非法条件规则', description: 'd', category: 'workflow', scope_type: 'personal', strength: 'prefer', conditions: { op: 'eq', path: 'ghost.attr', value: 'x' }, actions: [{ type: 'prefer', target: 'x' }], evidence_message_ids: ['m1'] },
    ],
    ontology_candidates: [],
  }))
  const captured = f.runtime.captureChatTurn({ conversation_id: 's-auto', turn_id: 't1', modelSelection: { provider: 'p', model: 'm' }, messages: [{ role: 'user', content: '检修期间禁止参数优化，流程上先读历史' }] })
  for (let i = 0; i < 300; i++) {
    const job = f.runtime.db.prepare('SELECT status,error FROM loop_jobs WHERE id=?').get(captured.job_id)
    if (['done', 'failed', 'partial'].includes(job.status)) { assert.equal(job.status, 'done', job.error); break }
    await new Promise((r) => setTimeout(r, 10))
  }
  const rows = ruleRows(f)
  assert.equal(rows['检修禁止优化'].governance_status, 'active')
  assert.equal(rows['始终适用规则'].governance_status, 'active', '无条件视为始终适用，可自动生效')
  assert.equal(rows['非法条件规则'].governance_status, 'candidate', '结构校验错误在任何模式都不自动生效')
  // 自动生效写入规则版本
  const versions = f.runtime.db.prepare('SELECT note FROM loop_rule_versions WHERE rule_id=(SELECT id FROM loop_rules WHERE name=?)').get('检修禁止优化')
  assert.match(versions.note, /自动生效/)
})

test('手动：AI 只产出候选，全部等用户确认', async t => {
  const f = fixture(); t.after(() => f.close())
  await request(f.runtime, '/rules/review-mode', { mode: 'manual' })
  await runExtraction(f)
  const rows = ruleRows(f)
  assert.equal(rows['先给结论'].governance_status, 'candidate')
  assert.equal(rows['检修禁止优化'].governance_status, 'candidate')
  assert.equal(f.runtime.db.prepare("SELECT count(*) n FROM loop_audit WHERE action='rule.auto_approved'").get().n, 0)
})

test('模式端点：非法值 400，设置持久化并优先于配置默认', async t => {
  const f = fixture({ loopRuleReviewMode: 'auto' }); t.after(() => f.close())
  const bad = await request(f.runtime, '/rules/review-mode', { mode: 'yolo' })
  assert.equal(bad.status, 400)
  const init = await request(f.runtime, '/rules/review-mode', null, 'GET')
  assert.equal(init.body.mode, 'auto', '未持久化时回落到配置默认')
  await request(f.runtime, '/rules/review-mode', { mode: 'manual' })
  const after = await request(f.runtime, '/rules/review-mode', null, 'GET')
  assert.equal(after.body.mode, 'manual', '页面设置优先于配置')
  const audit = f.runtime.db.prepare("SELECT detail_json FROM loop_audit WHERE action='rule.review_mode' ORDER BY created_at").get()
  assert.match(audit.detail_json, /previous/)
})
