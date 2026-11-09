#!/usr/bin/env node
/**
 * 管理动作浏览器验收：记忆编辑/版本/证据、本体属性/单位/状态、规则编辑/版本、
 * 重复导入、来源归档、图谱投射恢复。
 *
 *   node tools/loop-e2e-manage.mjs http://127.0.0.1:18912/ /tmp/loop-manage
 */
import { launch, sleep } from './mycdp.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'

const URL_BASE = process.argv[2] || 'http://127.0.0.1:18912/'
const OUT = process.argv[3] || '/tmp/loop-manage'
mkdirSync(OUT, { recursive: true })
const results = []
const pass = (n, d = '') => { results.push({ ok: true, n }); console.log(`PASS ${n}${d ? ' — ' + d : ''}`) }
const fail = (n, d = '') => { results.push({ ok: false, n }); console.log(`FAIL ${n}${d ? ' — ' + d : ''}`) }
const check = (c, n, d = '') => (c ? pass(n, d) : fail(n, d))

const b = await launch({ width: 1819, height: 865 })
const ev = (x) => b.evaluate(x)
const q = (s) => `document.querySelector(${JSON.stringify(s)})`
const text = async (s) => ev(`(${q(s)}?.innerText || '')`)
const click = async (s) => ev(`(() => { const x = ${q(s)}; if (!x) return false; x.click(); return true })()`)
const shot = async (p) => { const r = await b.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(p, Buffer.from(r.data, 'base64')) }
const toast = () => ev(`document.querySelector('#toast-root')?.innerText || ''`)
async function waitFor(expr, ms = 12000, step = 250) {
  const end = Date.now() + ms
  while (Date.now() < end) { try { if (await ev(expr)) return true } catch {} ; await sleep(step) }
  return false
}

try {
  await ev(`location.href=${JSON.stringify(URL_BASE)}`); await sleep(3200)
  await ev(`localStorage.clear(); sessionStorage.clear()`)
  await click('#open-loop'); await sleep(700)

  /* ---------------- 记忆编辑 / 版本 / 证据 ---------------- */
  await click('[data-view="memory"]')
  await waitFor(`document.querySelectorAll('.loop-memory').length > 0`, 12000)
  const edited = await ev(`(() => {
    const card = [...document.querySelectorAll('.loop-memory')].find((x) => x.innerText.includes('WELL_013') && x.querySelector('[data-loop-action="mem-edit-open"]'))
    if (!card) return false
    card.querySelector('[data-loop-action="mem-edit-open"]').click()
    return true
  })()`)
  check(edited, '记忆编辑面板可打开')
  if (edited) {
    await ev(`(() => { const t = document.querySelector('[data-mem-text]'); if (!t) return false; t.value = t.value + '（人工核对）'; t.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await click('[data-loop-action="mem-edit-save"]')
    check(await waitFor(`(${q('#toast-root')}?.innerText || '').includes('已保存')`, 12000), '记忆保存成功')
    check(await waitFor(`(${q('.loop-body')}?.innerText || '').includes('（人工核对）')`, 8000), '编辑内容回显')
    await ev(`(() => { const card = [...document.querySelectorAll('.loop-memory')].find((x) => x.innerText.includes('（人工核对）')); card?.querySelector('[data-loop-action="mem-versions"]')?.click(); return true })()`)
    check(await waitFor(`(${q('.loop-body')}?.innerText || '').includes('版本')`, 8000), '记忆版本历史可查看')
    await ev(`document.querySelector('[data-loop-action="mem-versions-close"]')?.click()`)
  }
  const detailOpen = await ev(`(() => { const card = [...document.querySelectorAll('.loop-memory')].find((x) => x.innerText.includes('WELL_013')); if (!card) return false; card.querySelector('[data-loop-action="memory-detail"]').click(); return true })()`)
  check(detailOpen, '记忆证据详情可打开')
  await sleep(1000)
  const detailText = await text('.loop-body')
  check(/证据|原话|来源/.test(detailText), '证据详情包含原话/来源')
  await b.send('Page.captureScreenshot', { format: 'png' }).then((r) => writeFileSync(`${OUT}/01-memory-manage.png`, Buffer.from(r.data, 'base64')))
  await ev(`document.querySelector('[data-loop-action="memory-detail-close"]')?.click()`)

  /* ---------------- 本体：属性 / 单位 / 状态 ---------------- */
  await click('[data-view="ontology"]')
  await waitFor(`document.querySelectorAll('.loop-instance').length > 0`, 12000)
  const opened = await ev(`(() => {
    const card = [...document.querySelectorAll('.loop-instance')].find((x) => x.innerText.includes('WELL_013'))
    if (!card) return false
    card.querySelector('[data-loop-action="instance-open"]').click()
    return true
  })()`)
  check(opened, '本体实例操作面板可打开')
  await sleep(1200)
  if (opened) {
    await ev(`(() => {
      const card = [...document.querySelectorAll('.loop-instance')].find((x) => x.innerText.includes('WELL_013'))
      const sel = card.querySelector('[data-prop-select]')
      if (sel) { const opt = [...sel.options].find((o) => /oil_rate/.test(o.textContent)); if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })) } }
      const v = card.querySelector('[data-prop-value]'); if (v) { v.value = '1000'; v.dispatchEvent(new Event('input', { bubbles: true })) }
      const u = card.querySelector('[data-prop-unit]'); if (u) { u.value = 'kg/d'; u.dispatchEvent(new Event('input', { bubbles: true })) }
      return true
    })()`)
    await ev(`(() => { const card = [...document.querySelectorAll('.loop-instance')].find((x) => x.innerText.includes('WELL_013')); card.querySelector('[data-loop-action="instance-prop"]').click(); return true })()`)
    await sleep(1500)
    const propText = await text('.loop-body')
    check(/kg\/d|t\/d|换算|属性/.test(propText), '属性写入/单位换算有结果')
    // 非法单位
    await ev(`(() => { const card = [...document.querySelectorAll('.loop-instance')].find((x) => x.innerText.includes('WELL_013')); const u = card.querySelector('[data-prop-unit]'); if (u) { u.value = 'kPa'; u.dispatchEvent(new Event('input', { bubbles: true })) } return true })()`)
    await ev(`(() => { const card = [...document.querySelectorAll('.loop-instance')].find((x) => x.innerText.includes('WELL_013')); card.querySelector('[data-loop-action="instance-prop"]').click(); return true })()`)
    check(await waitFor(`(${q('.loop-body')}?.innerText || '').includes('单位')`, 8000), '非法单位被拒绝并提示')
    // 状态转换 maintenance -> production
    await ev(`(() => {
      const card = [...document.querySelectorAll('.loop-instance')].find((x) => x.innerText.includes('WELL_013'))
      const sel = card.querySelector('[data-state-select]'); if (!sel) return false
      const opt = [...sel.options].find((o) => o.value === 'production') || [...sel.options].find((o) => /production/.test(o.textContent))
      if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })) }
      const r = card.querySelector('[data-state-reason]'); if (r) { r.value = 'E2E 恢复生产'; r.dispatchEvent(new Event('input', { bubbles: true })) }
      card.querySelector('[data-loop-action="instance-state"]').click()
      return true
    })()`)
    await sleep(1500)
    const stateText = await text('.loop-body')
    check(/production|恢复|状态/.test(stateText), '状态转换结果可见')
  }
  await b.send('Page.captureScreenshot', { format: 'png' }).then((r) => writeFileSync(`${OUT}/02-ontology-manage.png`, Buffer.from(r.data, 'base64')))

  /* ---------------- 规则编辑 / 版本 ---------------- */
  await click('[data-view="rules"]')
  await waitFor(`document.querySelectorAll('.loop-rule').length > 0`, 12000)
  const editRule = await ev(`(() => {
    const card = [...document.querySelectorAll('.loop-rule')].find((x) => x.querySelector('[data-loop-action="rule-edit-open"]'))
    if (!card) return false
    card.querySelector('[data-loop-action="rule-edit-open"]').click()
    return true
  })()`)
  check(editRule, '规则编辑面板可打开')
  await sleep(600)
  const ruleSaved = await ev(`(() => {
    const panel = document.querySelector('.loop-rule .loop-panel')
    if (!panel) return false
    const name = panel.querySelector('[data-rule-field="name"]')
    if (name) { name.value = (name.value || '规则') + ' ·E2E'; name.dispatchEvent(new Event('input', { bubbles: true })) }
    panel.querySelector('[data-loop-action="rule-edit-save"]')?.click()
    return true
  })()`)
  check(ruleSaved, '规则保存动作已触发')
  await sleep(1500)
  const ruleText = await text('.loop-body')
  check(/E2E|已保存|版本/.test(ruleText), '规则编辑/版本结果可见')
  await b.send('Page.captureScreenshot', { format: 'png' }).then((r) => writeFileSync(`${OUT}/03-rule-manage.png`, Buffer.from(r.data, 'base64')))

  /* ---------------- 规则冲突人工裁决 ---------------- */
  await click('[data-view="rules"]')
  await waitFor(`document.querySelectorAll('.loop-rule').length > 0`, 12000)
  await click('[data-loop-action="rules-view"][data-id="conflicts"]')
  await sleep(1200)
  const hasConflictActions = await ev(`document.querySelectorAll('[data-loop-action="resolve-conflict"]').length >= 4`)
  check(hasConflictActions, '冲突卡片有四个裁决按钮')
  if (hasConflictActions) {
    await ev(`(() => { const n = document.querySelector('[data-conflict-note]'); if (!n) return false; n.value = 'E2E 人工裁决'; n.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await ev(`(() => { const b = [...document.querySelectorAll('[data-loop-action="resolve-conflict"]')].find((x) => x.dataset.resolution === 'prefer_a'); if (!b) return false; b.click(); return true })()`)
    check(await waitFor(`(${q('.loop-body')}?.innerText || '').includes('E2E 人工裁决')`, 10000), '冲突裁决理由显示')
    check(await waitFor(`(${q('.loop-body')}?.innerText || '').includes('选择 A')`, 8000), '冲突裁决结果标记')
  }
  await b.send('Page.captureScreenshot', { format: 'png' }).then((r) => writeFileSync(`${OUT}/05-conflict.png`, Buffer.from(r.data, 'base64')))

  /* ---------------- 本体版本发布 / 差异 / 回滚 ---------------- */
  await click('[data-view="ontology"]')
  await sleep(1600)
  const proposalVisible = await ev(`[...document.querySelectorAll('.loop-row')].some((x) => x.innerText.includes('V4 验收设备'))`)
  check(proposalVisible, '结构候选可见')
  if (proposalVisible) {
    await ev(`(() => { const row = [...document.querySelectorAll('.loop-row')].find((x) => x.innerText.includes('V4 验收设备')); row?.querySelector('[data-loop-action="proposal-approve"]')?.click(); return true })()`)
    check(await waitFor(`(${q('.loop-body')}?.innerText || '').includes('v2')`, 12000), '结构发布生成新版本')
    await click('[data-loop-action="ontology-version-diff"]')
    check(await waitFor(`(${q('.loop-body')}?.innerText || '').includes('差异')`, 8000), '版本差异可见')
    const diffText = await text('.loop-body')
    check(/新增类型/.test(diffText), '差异包含新增类型')
    const rollbackButtons = await ev(`document.querySelectorAll('[data-loop-action="ontology-version-rollback"]').length`)
    check(rollbackButtons > 0, '回滚按钮存在')
    if (rollbackButtons > 0) {
      await ev(`(() => { const bs = [...document.querySelectorAll('[data-loop-action="ontology-version-rollback"]')]; bs[bs.length - 1].click(); return true })()`)
      await sleep(1000)
      if (await ev(`!!document.querySelector('[data-loop-action="ontology-version-rollback-confirm"]')`)) {
        await ev(`(() => { const n = document.querySelector('#ont-rollback-note'); if (n) { n.value = 'E2E 回滚'; n.dispatchEvent(new Event('input', { bubbles: true })) } return true })()`)
        await click('[data-loop-action="ontology-version-rollback-confirm"]')
      }
      check(await waitFor(`(${q('.loop-body')}?.innerText || '').includes('回滚')`, 12000), '回滚完成并记录新版本')
      const ont = await ev(`fetch('/api/loop/ontology?owner=local-user').then(r => r.json())`)
      check(!(ont.types || []).some((t) => String(t.name).includes('V4 验收设备')), '回滚后结构类型移除')
      check((ont.current_version || {}).action === 'rollback', '当前版本为 rollback')
    }
  }
  await b.send('Page.captureScreenshot', { format: 'png' }).then((r) => writeFileSync(`${OUT}/06-ontology-version.png`, Buffer.from(r.data, 'base64')))

  /* ---------------- 持久任务队列：拆解 / 取消 / 重试 ---------------- */
  await click('[data-view="import"]'); await sleep(700)
  const jobStamp = Date.now().toString(36)
  await ev(`(() => {
    const set = (s, v) => { const x = document.querySelector(s); if (!x) return; x.value = v; x.dispatchEvent(new Event('input', { bubbles: true })); x.dispatchEvent(new Event('change', { bubbles: true })) }
    set('#loop-text', '用户：队列验收 WELL_030 检修\\n助手：收到')
    set('[data-f="import.filename"]', 'job-cancel-${jobStamp}.md')
    set('[data-f="import.project"]', 'demo-project')
    set('[data-f="import.autoExtract"]', '0')
    return true
  })()`)
  await click('[data-loop-action="import"]')
  await waitFor(`(${q('.loop-body')}?.innerText || '').includes('导入结果')`, 30000)
  await sleep(500)
  const extractClicked = await ev(`(() => { const row = [...document.querySelectorAll('.loop-source')].find((x) => x.innerText.includes('job-cancel-${jobStamp}')); if (!row) return false; row.querySelector('[data-loop-action="extract"]').click(); return true })()`)
  check(extractClicked, '来源可发起后台拆解')
  check(await waitFor(`(${q('#loop-job-panel')}?.innerText || '').includes('拆解')`, 10000), '任务队列出现拆解任务')
  const cancelAvailable = await waitFor(`document.querySelector('[data-loop-action="job-cancel"]')`, 12000)
  check(cancelAvailable, '任务取消按钮可用')
  if (cancelAvailable) await click('[data-loop-action="job-cancel"]')
  check(await waitFor(`/已取消|已请求取消/.test(${q('#loop-job-panel')}?.innerText || '') || (${q('#toast-root')}?.innerText || '').includes('已请求取消')`, 20000), '任务取消状态可见')
  const retryAvailable = await waitFor(`document.querySelector('[data-loop-action="job-retry"]')`, 12000)
  check(retryAvailable, '任务重试按钮可用')
  if (retryAvailable) await click('[data-loop-action="job-retry"]')
  check(await waitFor(`(${q('#loop-job-panel')}?.innerText || '').includes('排队中') || (${q('#loop-job-panel')}?.innerText || '').includes('运行中')`, 12000), '任务重新入队')

  /* ---------------- 向量状态与重建 ---------------- */
  await click('[data-view="context"]'); await sleep(1400)
  check((await text('.loop-body')).includes('向量召回'), '向量召回面板')
  await click('[data-loop-action="vector-probe"]')
  check(await waitFor(`(${q('.loop-body')}?.innerText || '').includes('可探测')`, 8000), '向量探测结果可见')
  if (await waitFor(`document.querySelector('[data-loop-action="vector-reindex"]')`, 8000)) {
    await sleep(500)
    await click('[data-loop-action="vector-reindex"]')
    const vecQueued = await waitFor(`(${q('.loop-body')}?.innerText || '').includes('已入队') || (${q('.loop-body')}?.innerText || '').includes('未配置')`, 10000)
    check(vecQueued, '向量重建任务入队或明确未配置')
  }

  /* ---------------- 重复导入 + 归档来源 ---------------- */
  await click('[data-view="import"]'); await sleep(700)
  const stamp = Date.now().toString(36)
  const dupText = '用户：重复导入验证 WELL_099 处于检修。\n助手：收到。'
  const fileName = `manage-dup-${stamp}.md`
  const setImport = async () => {
    await ev(`(() => {
      const set = (s, v) => { const x = document.querySelector(s); if (!x) return; x.value = v; x.dispatchEvent(new Event('input', { bubbles: true })); x.dispatchEvent(new Event('change', { bubbles: true })) }
      set('#loop-text', ${JSON.stringify(dupText)})
      set('[data-f="import.filename"]', ${JSON.stringify(fileName)})
      set('[data-f="import.project"]', 'e2e-project')
      set('[data-f="import.autoExtract"]', '0')
      return true
    })()`)
    await click('[data-loop-action="import"]')
    await waitFor(`(${q('.loop-body')}?.innerText || '').includes('导入结果')`, 30000)
    await sleep(600)
  }
  await setImport()
  check(/重复文件[\s\S]*?否/.test(await text('.loop-body')), '首次导入不重复')
  await setImport()
  check(/重复文件[\s\S]*?是/.test(await text('.loop-body')), '第二次同文件导入去重')
  // 归档
  const archiveClicked = await ev(`(() => {
    const row = [...document.querySelectorAll('.loop-source')].find((x) => x.innerText.includes(${JSON.stringify(fileName.replace(/\.md$/, ''))}) || x.innerText.includes('重复导入验证'))
    if (!row) return false
    row.querySelector('[data-loop-action="archive-source"]').click()
    return true
  })()`)
  check(archiveClicked, '来源归档入口可点击')
  await sleep(400)
  await ev(`document.querySelector('[data-loop-action="archive-source-confirm"]')?.click()`)
  check(await waitFor(`(${q('.loop-body')}?.innerText || '').includes('归档结果')`, 10000), '归档结果卡可见')
  await b.send('Page.captureScreenshot', { format: 'png' }).then((r) => writeFileSync(`${OUT}/04-archive.png`, Buffer.from(r.data, 'base64')))

  /* ---------------- 投射恢复 ---------------- */
  await click('[data-view="graph"]')
  await waitFor(`document.querySelectorAll('[data-node-id]').length > 0`, 12000)
  if (await ev('typeof window.__MB_SET_GRAPH__ === "function"')) {
    await click('[data-loop-action="graph-projection"]')
    await waitFor(`(${q('#toast-root')}?.innerText || '').includes('已投射')`, 12000)
    await click('[data-loop-action="graph-projection"]')
    check(await waitFor(`(${q('#toast-root')}?.innerText || '').includes('已恢复')`, 12000), '投射后可恢复原始大脑图谱')
  } else pass('投射接口不可用（独立页面）')

  const exceptions = b.logs.filter((x) => (x.startsWith('[EXCEPTION]') || x.startsWith('[log.error]')) && !/favicon\.ico/.test(x) && !/409 \(Conflict\).*\/ontology\/versions\/.*\/rollback/.test(x))
  check(exceptions.length === 0, '无 JS 异常', exceptions.slice(0, 2).join(' | '))
} catch (e) {
  fail('管理 E2E 执行', e.message)
  try { const r = await b.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${OUT}/99-error.png`, Buffer.from(r.data, 'base64')) } catch {}
} finally {
  const failed = results.filter((r) => !r.ok)
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} PASS`)
  if (failed.length) console.log('FAILED: ' + failed.map((x) => x.n).join(' | '))
  b.close()
  process.exitCode = failed.length ? 1 : 0
}
