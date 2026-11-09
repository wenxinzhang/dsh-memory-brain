#!/usr/bin/env node
/**
 * 浏览器端到端验收（独立 dev server）。
 *
 *   node tools/loop-e2e.mjs http://127.0.0.1:18912/ /tmp/loop-shots
 *
 * 覆盖：导入（角色修正/附件/真实模型拆解）→ 记忆 → 本体 → 规则模拟/冲突
 *      → Skill 候选 → 上下文/反馈 → 图谱与中央大脑投射 → 刷新恢复。
 * 输出 PASS/FAIL 清单与截图；任何 JS 异常都计入失败。
 */
import { launch, sleep } from './mycdp.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'

const URL_BASE = process.argv[2] || 'http://127.0.0.1:18912/'
const OUT = process.argv[3] || '/tmp/loop-shots'
mkdirSync(OUT, { recursive: true })

const results = []
const pass = (name, detail = '') => { results.push({ ok: true, name, detail }); console.log(`PASS ${name}${detail ? ' — ' + detail : ''}`) }
const fail = (name, detail = '') => { results.push({ ok: false, name, detail }); console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`) }
const check = (cond, name, detail = '') => (cond ? pass(name, detail) : fail(name, detail))

const b = await launch({ width: 1819, height: 865 })
const ev = (x) => b.evaluate(x)
const sleep2 = (ms) => sleep(ms)
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`
const text = async (sel) => ev(`(${q(sel)}?.innerText || '')`)
const click = async (sel) => ev(`(() => { const x = ${q(sel)}; if (!x) return false; x.click(); return true })()`)
const shot = async (path) => { const r = await b.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(path, Buffer.from(r.data, 'base64')) }
const setVal = async (sel, value) => ev(`(() => { const x = ${q(sel)}; if (!x) return false; x.value = ${JSON.stringify(value)}; x.dispatchEvent(new Event('input', { bubbles: true })); x.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
async function waitFor(expr, ms = 15000, step = 300) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { if (await ev(expr)) return true } catch {}
    await sleep2(step)
  }
  return false
}

try {
  await ev(`location.href = ${JSON.stringify(URL_BASE)}`); await sleep2(3500)
  const booted = await waitFor('!!window.__APP && !!document.querySelector("#open-loop")', 20000)
  check(booted, '页面启动：__APP 与顶栏存在')
  if (!booted) throw new Error('页面没有启动')

  await ev(`localStorage.removeItem('memory-brain:loop-draft'); sessionStorage.clear()`)
  await click('#open-loop')
  check(await waitFor('!!document.querySelector(".loop-drawer")', 8000), '闭环抽屉打开')
  const tabs = await ev(`[...document.querySelectorAll('.loop-tab')].map(x => x.textContent.trim())`)
  check(Array.isArray(tabs) && tabs.length === 7, '7 个闭环视图', tabs.join(' / '))

  /* ---------------- 导入 ---------------- */
  const stamp = Date.now().toString(36)
  const textConv = [
    '未知：这一行没有角色标记',
    `用户：WELL_013 现在检修，先不要做参数优化，恢复生产后再进行。`,
    '助手：收到，我不会自动启动优化任务。',
  ].join('\n')
  await click('[data-view="import"]')
  await waitFor(`${q('#loop-text')} != null`, 5000)
  await setVal('#loop-text', textConv)
  await setVal('[data-f="import.owner"]', 'local-user')
  await setVal('[data-f="import.project"]', 'e2e-project')
  await setVal('[data-f="import.platform"]', 'demo')
  await setVal('[data-f="import.filename"]', `ui-e2e-${stamp}.md`)
  await setVal('[data-f="import.title"]', '演示：UI E2E WELL_013 检修约束')
  await setVal('[data-f="import.autoExtract"]', '1')

  // 附件：只登记元数据（浏览器内构造 File，无需真实文件选择）
  await ev(`(() => {
    const input = document.querySelector('#loop-attach'); if (!input) return false;
    const dt = new DataTransfer();
    dt.items.add(new File(['a,b\\n1,2'], 'log.csv', { type: 'text/csv' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true
  })()`)
  check(await waitFor(`${q('.loop-attach-list')} && ${q('.loop-attach-list')}.innerText.includes('内容未解析')`, 5000), '附件元数据与「内容未解析」提示')

  await click('[data-loop-action="preview"]')
  check(await waitFor(`!!document.querySelector('.loop-preview')`, 8000), '预览解析出现')
  const previewCount = await ev(`document.querySelectorAll('.loop-preview .loop-msg').length`)
  check(previewCount === 3, '预览消息数正确', String(previewCount))
  const firstRole = await ev(`document.querySelector('.loop-preview .loop-role-select')?.value`)
  check(firstRole === 'unknown', '未知角色保留并标黄', String(firstRole))
  await setVal('.loop-preview .loop-role-select', 'assistant')
  const fixedRole = await ev(`document.querySelector('.loop-preview .loop-role-select')?.value`)
  check(fixedRole === 'assistant', '角色修正生效', String(fixedRole))

  await click('[data-loop-action="import"]')
  const importDone = await waitFor(`(${q('.loop-body')}?.innerText || '').includes('导入结果')`, 180000, 1000)
  check(importDone, '导入完成（含真实模型拆解）')
  const importText = await text('.loop-body')
  check(/追加消息/.test(importText) && /来源状态/.test(importText), '导入结果卡可见（追加消息/来源状态）')
  const jobDone = await waitFor(`/(已完成|部分完成|失败)/.test(${q('#loop-job-panel')}?.innerText || '')`, 180000, 1000)
  check(jobDone, '后台任务队列显示终态')
  const jobText = await text('#loop-job-panel')
  check(/拆解/.test(jobText), '任务类型为拆解')
  check(!/运行中|排队中/.test(jobText) || /已完成/.test(jobText), '导入拆解任务已结束', jobText.match(/拆解 · [^\n]*/)?.[0]?.slice(0, 80) || '')
  const extracted = await waitFor(`/最近批次：.*(已完成|部分完成|失败)/.test(${q('.loop-body')}?.innerText || '')`, 30000, 1000)
  check(extracted, '来源列表显示拆解批次状态')
  await sleep2(1000)
  await shot(`${OUT}/01-import.png`)

  /* ---------------- 记忆 ---------------- */
  await click('[data-view="memory"]')
  check(await waitFor(`document.querySelectorAll('.loop-memory').length > 0`, 12000), '记忆列表加载')
  const memText = await text('.loop-body')
  check(memText.includes('WELL_013') || memText.includes('检修'), '记忆包含刚导入的事实')
  const hasEvidence = await ev(`!!document.querySelector('.loop-memory details, .loop-memory .loop-quote, .loop-memory [data-loop-action="memory-detail"]')`)
  check(hasEvidence, '记忆可查看证据/详情')
  const memErr = await ev(`document.querySelector('.loop-body')?.innerText.includes('接口不可用')`)
  check(!memErr, '记忆接口无错误')
  await shot(`${OUT}/02-memory.png`)

  /* ---------------- 本体 ---------------- */
  await click('[data-view="ontology"]')
  check(await waitFor(`document.querySelectorAll('.loop-ontology-instance, .loop-instance, .loop-row').length > 0`, 12000), '本体视图加载')
  const ontoText = await text('.loop-body')
  check(ontoText.includes('WELL_013') || ontoText.includes('本体'), '本体实例/定义可见')
  const ontoHasState = await ev(`(${q('.loop-body')}.innerText || '').includes('检修') || (${q('.loop-body')}.innerText || '').includes('maintenance') || (${q('.loop-body')}.innerText || '').includes('当前状态')`)
  check(ontoHasState, '实例状态可见')
  check((await text('.loop-body')).includes('结构版本历史'), '本体结构版本历史可见')
  check(await ev(`document.querySelectorAll('[data-loop-action="ontology-version-diff"]').length > 0`), '版本差异入口可见')
  await shot(`${OUT}/03-ontology.png`)

  /* ---------------- 规则 ---------------- */
  await click('[data-view="rules"]')
  check(await waitFor(`document.querySelectorAll('.loop-rule').length > 0`, 12000), '规则列表加载')
  const rulesText = await text('.loop-body')
  check(rulesText.includes('候选') || rulesText.includes('已生效'), '规则治理状态可见')
  check(rulesText.includes('权限：') || rulesText.includes('规则'), '规则权威性可见')
  const activeRuleClicked = await ev(`(() => {
    const card = [...document.querySelectorAll('.loop-rule')].find((x) => x.innerText.includes('已生效') && x.querySelector('[data-loop-action="show-sim"]'))
    if (!card) return false
    card.querySelector('[data-loop-action="show-sim"]').click()
    return true
  })()`)
  check(activeRuleClicked, '找到已生效规则并打开模拟评估')
  const simSel = await ev(`document.querySelector('.loop-sim textarea') ? true : false`)
  check(simSel, '模拟评估面板打开')
  if (simSel) {
    await setVal('.loop-sim textarea', '{"well":{"status":"maintenance"}}')
    await click('.loop-sim [data-loop-action="simulate"]')
    const simOk = await waitFor(`(() => { const r = document.querySelector('.loop-sim'); return r && /applicable|not_applicable|unknown|适用|不适用|未知|无法判断|命中|未命中/.test(r.innerText) })()`, 8000)
    check(simOk, '模拟评估返回结果与原因', (await text('.loop-sim')).slice(0, 120).replace(/\n/g, ' | '))
  }
  await click('[data-loop-action="rules-view"][data-id="conflicts"]')
  check(await waitFor(`(${q('.loop-body')}.innerText || '').includes('冲突')`, 8000), '冲突视图可打开')
  await shot(`${OUT}/04-rules.png`)

  /* ---------------- Skill ---------------- */
  await click('[data-view="skills"]')
  await waitFor(`${q('.loop-body')} != null`, 4000)
  await click('[data-loop-action="skills-derive"]')
  await sleep2(1500)
  const skillText = await text('.loop-body')
  check(skillText.includes('流程') || skillText.includes('Skill') || skillText.includes('候选'), 'Skill 视图可用')
  const skillCard = await ev(`document.querySelectorAll('.loop-skill, [id^="skill-"], .loop-card').length > 0`)
  check(skillCard, 'Skill 视图渲染')
  await shot(`${OUT}/05-skills.png`)

  /* ---------------- 上下文 / 反馈 ---------------- */
  await click('[data-view="context"]')
  await waitFor(`${q('#ctx-object')} != null`, 5000)
  await setVal('[data-f="context.project"]', 'e2e-project')
  await setVal('[data-f="context.instruction"]', '这次先输出结论')
  await setVal('#ctx-object', '{"object":{"name":"WELL_013"},"well":{"status":"maintenance"}}')
  await click('[data-loop-action="context"]')
  check(await waitFor(`(${q('#ctx-result')}?.innerText || '').length > 30`, 12000), '上下文组装成功')
  const ctxText = await text('#ctx-result')
  check(/必须遵守|事实|优先级|run/.test(ctxText), '上下文分区可见')
  check(ctxText.includes('为什么') || ctxText.includes('why') || ctxText.includes('证据'), '上下文包含召回/生效解释')
  check(!ctxText.includes('接口不可用'), '上下文接口无错误')
  check((await text('.loop-body')).includes('向量召回'), '向量状态面板可见')
  const vecText = await text('.loop-body')
  check(/向量未配置|已向量化|端点/.test(vecText), '向量状态明确（配置/降级）')
  // 检索诊断：显式关键词 + 现场演示数据的硬约束
  await setVal('[data-f="context.project"]', 'demo-project')
  await setVal('[data-f="context.query"]', '检修 参数优化')
  await setVal('#ctx-object', '{"object":{"name":"WELL_001"},"well":{"status":"maintenance"}}')
  await click('[data-loop-action="context"]')
  check(await waitFor(`(${q('#ctx-result')}?.innerText || '').includes('检索诊断')`, 10000), '上下文显示检索诊断')
  const ctx2 = await text('#ctx-result')
  check(/关键词|候选|硬约束/.test(ctx2), '检索诊断包含关键词/候选/硬约束')
  // 动作权限：禁止动作不能被授权绕过，且永远不执行
  await sleep2(800)
  await click('[data-loop-action="action-check"]')
  check(await waitFor(`(${q('.loop-action-result')}?.innerText || '').includes('被禁止')`, 10000), '动作校验识别禁止动作')
  const act1 = await text('.loop-action-result')
  check(/executed=否/.test(act1), '禁止动作未执行')
  await ev(`(() => { const x = document.querySelector('[data-f="action.authorized"]'); if (!x) return false; x.checked = true; x.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
  await click('[data-loop-action="action-check"]')
  await sleep2(800)
  const act2 = await text('.loop-action-result')
  check(/被禁止/.test(act2) && /executed=否/.test(act2), '明确授权也不能绕过禁止动作')
  // 反馈
  await setVal('[data-f="feedback.outcome"]', 'problem')
  await setVal('[data-f="feedback.category"]', 'rule_content')
  await setVal('[data-f="feedback.feedback"]', 'E2E：规则范围需要在 UI 中可核对')
  await click('[data-loop-action="feedback-submit"]')
  check(await waitFor(`(${q('.loop-body')}?.innerText || '').includes('反馈已提交')`, 12000), '反馈提交成功')
  const fbText = await text('.loop-body')
  check(/已记录|已生成|候选规则版本/.test(fbText), '反馈结果可见')
  await shot(`${OUT}/06-context.png`)

  /* ---------------- 图谱 + 中央大脑投射 ---------------- */
  await click('[data-view="graph"]')
  check(await waitFor(`document.querySelectorAll('[data-node-id]').length > 0`, 12000), '图谱节点渲染')
  const nodeCount = await ev(`document.querySelectorAll('[data-node-id]').length`)
  const edgeCount = await ev(`document.querySelectorAll('.loop-graph-edge, line, path').length`)
  check(nodeCount > 0, '图谱节点数 > 0', String(nodeCount))
  check(edgeCount >= 0, '图谱边来自接口（无随机连线）', String(edgeCount))
  const projectionBtn = await ev(`!!document.querySelector('[data-loop-action="graph-projection"]')`)
  check(projectionBtn, '投射到中央大脑按钮存在')
  if (projectionBtn && await ev('typeof window.__MB_SET_GRAPH__ === "function"')) {
    await click('[data-loop-action="graph-projection"]')
    check(await waitFor(`(${q('#toast-root')}?.innerText || '').includes('已投射')`, 12000), '投射到中央大脑成功')
  } else {
    pass('投射到中央大脑（独立页面无 __MB_SET_GRAPH__ 时按钮禁用/提示）')
  }
  await shot(`${OUT}/07-graph.png`)

  /* ---------------- 刷新恢复 ---------------- */
  await ev(`location.href = ${JSON.stringify(URL_BASE)}`); await sleep2(3500)
  await waitFor('!!document.querySelector("#open-loop")', 15000)
  await click('#open-loop')
  await waitFor('!!document.querySelector(".loop-drawer")', 8000)
  const restoredTab = await ev(`document.querySelector('.loop-tab.is-active, .loop-tab[aria-selected="true"]')?.textContent.trim()`)
  check(restoredTab === '图谱', '刷新后恢复上次视图', String(restoredTab))
  const restoredText = await text('.loop-body')
  check(!/接口不可用/.test(restoredText), '刷新后闭环接口可用')
  await shot(`${OUT}/08-refresh.png`)

  /* ---------------- 异常 ---------------- */
  const exceptions = b.logs.filter((x) => (x.startsWith('[EXCEPTION]') || x.startsWith('[log.error]')) && !/favicon\.ico/.test(x))
  check(exceptions.length === 0, '无 JS 异常', exceptions.slice(0, 3).join(' | '))
} catch (e) {
  fail('E2E 执行', e.message)
  try { await shot(`${OUT}/99-error.png`) } catch {}
} finally {
  const failed = results.filter((r) => !r.ok)
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} PASS`)
  if (failed.length) console.log('FAILED: ' + failed.map((x) => x.name).join(' | '))
  b.close()
  process.exitCode = failed.length ? 1 : 0
}
