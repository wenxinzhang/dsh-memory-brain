// 初始化实际闭环库，导入一组明确标识的演示对话，并调用本机模型拆解。
// 这是演示夹具，不是用户真实历史；页面中 platform=demo、title 带“演示”。
import { createLoopRuntime } from '../lib/loop.js'
import http from 'node:http'
import { resolve } from 'node:path'

const root = resolve(new URL('../web', import.meta.url).pathname)
const rt = createLoopRuntime({ root, config: { loopDb: resolve(root, 'data', 'loop.db') } })
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  return rt.handle(req, res, url, url.pathname.slice('/api/loop'.length))
})
await new Promise((r) => server.listen(18910, '127.0.0.1', r))
const base = 'http://127.0.0.1:18910/api/loop'
const post = async (p, body) => {
  const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() }
}
const text = `用户：WELL_001 现在检修，先不要做参数优化，恢复生产后再进行。
助手：收到。我会记录这条限制，但不会自动启动优化任务。
用户：另外，以后给我方案时先给结论，再给依据。`
const imported = await post('/import', {
  text, filename: 'demo-well-001.md', format: 'text', owner: 'local-user', project: 'demo-project',
  title: '演示：WELL_001 检修约束', platform: 'demo', autoExtract: true,
})
console.log('import:', imported.status, JSON.stringify(imported.body).slice(0, 400))
if (!imported.body.source) { server.close(); rt.close(); process.exit(1) }
const id = imported.body.source.id
if (imported.body.source.extraction_status !== 'extracted') {
  const ex = await post(`/import/${id}/extract`, {})
  console.log('extract:', ex.status, JSON.stringify(ex.body).slice(0, 800))
}
// 演示夹具：确认「检修期间禁止优化」这条硬约束，便于展示上下文中的 must_not；
// 其余规则保持候选，方便展示「候选 → 人工确认」的流程与模拟评估。
const rules = await (await fetch(base + '/rules?owner=local-user')).json()
console.log('rules:', (rules.items || []).map((r) => `${r.name} [${r.strength}/${r.structure_status}]`).join(' | '))
const hard = (rules.items || []).find((r) => r.strength === 'must_not' && r.scope_id === 'WELL_001')
if (hard) {
  const approved = await post(`/rules/${hard.id}/approve`, {})
  console.log('approve demo hard rule:', approved.status, approved.body.ok ? 'ok' : JSON.stringify(approved.body))
}
const ctx = await post('/context', { owner: 'local-user', project: 'demo-project', object: { name: 'WELL_001' }, well: { status: 'maintenance' } })
console.log('context:', ctx.status, ctx.body.ok ? JSON.stringify({ run: ctx.body.run_id, rules: ctx.body.sections.rules.map((r) => r.name), facts: ctx.body.sections.facts.length }) : JSON.stringify(ctx.body))
const ov = await (await fetch(base + '/overview')).json()
console.log('overview:', JSON.stringify(ov.counts))
server.close(); rt.close()
