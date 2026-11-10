/** @dafeiyu/dsh-memory-brain client UI. */
window.__ModuleLoader__.load({
  id: '@dafeiyu/dsh-memory-brain',
  factory(require) {
    const React = require('react')
    let PANEL_PATH = '/memory-brain/'
    let API_ROOT = '/memory-brain/api/loop'

    function panelUrl() {
      try {
        const loc = window.location
        if (!/^https?:$/.test(loc.protocol)) return PANEL_PATH
        const u = new URL(loc.origin + PANEL_PATH)
        const q = new URLSearchParams(loc.search)
        for (const k of ['token', 'access_token', 'auth', 't', 'key']) if (q.has(k)) u.searchParams.set(k, q.get(k))
        return u.toString()
      } catch { return PANEL_PATH }
    }
    function sessionIdOf(props) {
      return String(props?.sessionId || props?.conversationId || props?.session?.id || props?.conversation?.id || '')
    }
    function storageKey(id) { return `memory-brain:mode:${id || 'default'}` }
    function normalizeRecords(body) {
      const rows = Array.isArray(body) ? body : body?.items || body?.invocations || body?.records || body?.executions || []
      return (Array.isArray(rows) ? rows : []).filter((x) => x?.sent && x.sent_at).map((x) => ({
        id: x.invocation_id || x.id || x.attemptId,
        sent: x.sent || x.compiled || x.context || null,
        version: x.sent?.compiler_version || x.version || x.sent?.version || null,
        feedback: x.feedback || null,
        sentAt: x.sent_at || x.sentAt || x.started_at || x.startedAt || null,
      }))
    }
    async function getRecords(id, fetcher = window.fetch) {
      if (!id || typeof fetcher !== 'function') return []
      const paths = [`${API_ROOT}/invocations?conversation_id=${encodeURIComponent(id)}`, `${API_ROOT}/executions?conversation_id=${encodeURIComponent(id)}`, `/memory-brain/api/invocations?conversation_id=${encodeURIComponent(id)}`]
      for (const path of paths) {
        const r = await fetcher(path, { credentials: 'include', cache: 'no-store' })
        if (r.ok) return normalizeRecords(await r.json())
        if (![404, 405].includes(r.status)) throw new Error(`调用记录读取失败：HTTP ${r.status}`)
      }
      throw new Error('调用记录接口不可用（404/405）')
    }
    async function postJson(path, body, fetcher = window.fetch) {
      const r = await fetcher(path, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.json().catch(() => ({}))
    }
    async function getScope(id) {
      const response = await window.fetch(`${API_ROOT}/scope?conversation_id=${encodeURIComponent(id)}`, {credentials:'include',cache:'no-store'})
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      return {...(body.scope || body),auto_extract_available:body.auto_extract_enabled!==false}
    }
    function readSent(sent) {
      try {
        const text=typeof sent==='string'?sent:sent?.text
        const match=String(text || '').match(/^MEMORY_BRAIN_CONTEXT_BEGIN\n([\s\S]*)\nMEMORY_BRAIN_CONTEXT_END$/)
        const payload=JSON.parse(match?match[1]:text)
        const list=value=>Array.isArray(value)?value:[]
        return {parsed:true,background:payload.task_background || {},rows:[...list(payload.constraints).map(row=>({...row,category:'constraints'})),...list(payload.rules).map(row=>({...row,category:'rules'})),...list(payload.untrusted_reference_data)],unknowns:list(payload.unknowns)}
      } catch {return {parsed:false,background:{},rows:[],unknowns:[]}}
    }

    const pageStyle = { flex: '1 1 auto', minHeight: 0, position: 'relative', display: 'flex', background: '#01060e' }
    const cardStyle = { maxWidth: 560, padding: '22px 24px', border: '1px solid rgba(120,180,220,.25)', borderRadius: 12, background: 'rgba(6,18,30,.92)', fontFamily: 'system-ui,sans-serif', color: '#cfe3f2' }

    function MemoryRecordsView(props) {
      const id = sessionIdOf(props)
      const activeSession = React.useRef(id)
      activeSession.current = id
      const [mode, setMode] = React.useState(() => { try { return localStorage.getItem(storageKey(id)) || 'auto' } catch { return 'auto' } })
      const [records, setRecords] = React.useState([])
      const [open, setOpen] = React.useState(false)
      const [error, setError] = React.useState('')
      const [feedback, setFeedback] = React.useState({})
      const [busy, setBusy] = React.useState(false)
      const [scope, setScope] = React.useState(null)
      const [notice,setNotice] = React.useState('')
      const refresh = React.useCallback(async () => {
        if (!id) return
        const [nextRecords,nextScope] = await Promise.all([getRecords(id),getScope(id)])
        if (activeSession.current !== id) return
        setRecords(nextRecords); setScope(nextScope); setMode(nextScope.mode);setError('')
      }, [id])
      React.useEffect(() => {
        let alive=true;let inFlight=false
        activeSession.current=id
        setRecords([]);setScope(null)
        const update=async()=>{if(inFlight || !alive)return;inFlight=true;try{await refresh()}catch(e){if(alive)setError(String(e.message||e))}finally{inFlight=false}}
        update(); const timer=setInterval(update,2000)
        return ()=>{alive=false;if(activeSession.current===id)activeSession.current=null;clearInterval(timer)}
      }, [refresh])
      const chooseMode = async (next) => {
        if (!id) return
        setBusy(true); setError('')
        try { await postJson(`${API_ROOT}/scope`, {conversation_id:id,mode:next}); setMode(next); try { localStorage.setItem(storageKey(id), next) } catch {} }
        catch (e) { setError(`会话模式未保存：${e.message || e}`) }
        finally { setBusy(false) }
      }
      const ignoreTurn = async () => {
        if (!id) return
        setBusy(true); setError('')
        try {
          const scope = await getScope(id)
          if (scope.current_turn == null) throw new Error('尚无可忽略的轮次')
          await postJson(`${API_ROOT}/scope`, { conversation_id: id, ignored_by_turn: {...(scope.ignored_by_turn || {}),[scope.current_turn]:true} }); await refresh()
        } catch (e) { setError(`仅本轮忽略未写入：${e.message || e}`) } finally { setBusy(false) }
      }
      const sendFeedback = async (recordId, outcome) => {
        setBusy(true); setError('')
        try { await postJson(`${API_ROOT}/feedback`, { invocation_id: recordId, outcome, feedback: feedback[recordId] || '' }); setFeedback((x) => ({ ...x, [recordId]: '' })); await refresh() } catch (e) { setError(`反馈未提交：${e.message || e}`) } finally { setBusy(false) }
      }
      const submitPreview = async approved => {
        setBusy(true);setError('')
        try {
          await postJson(`${API_ROOT}/scope`,{conversation_id:id,...(approved?{preview_approval:scope.preview.fingerprint}:{preview_cancel:true})})
          setNotice(approved?'预览已确认，请返回聊天重新发送原问题；内容或状态变化会重新预览。':'本次预览已取消，没有发送模型请求。')
          await refresh()
        } catch(e) {setError(`预览未保存：${e.message||e}`)} finally {setBusy(false)}
      }
      const saveBindings = async event => {
        event.preventDefault()
        const fields=event.currentTarget.elements
        const patch=Object.fromEntries(['project_id','task_id','task_description','object_id'].map(key=>[key,String(fields[key]?.value||'').trim()||null]))
        setBusy(true);setError('')
        try {await postJson(`${API_ROOT}/scope`,{conversation_id:id,...patch});await refresh();setNotice('会话归属已保存，下一次调用使用新范围。')}
        catch(e){setError(`归属未保存：${e.message||e}`)}finally{setBusy(false)}
      }
      const restoreAutomatic = async () => {
        setBusy(true);setError('')
        try {
          await postJson(`${API_ROOT}/scope`,{conversation_id:id,project_id:null,task_id:null,task_description:null,object_id:null,object_name:null})
          await refresh();setNotice('已恢复自动识别，下次提问时自动关联。')
        } catch(e){setError(`恢复未保存：${e.message||e}`)}finally{setBusy(false)}
      }
      const setAutomaticExtraction=async enabled=>{
        setBusy(true);setError('')
        try{await postJson(`${API_ROOT}/scope`,{conversation_id:id,auto_extract:enabled});await refresh()}
        catch(e){setError(`自动整理设置未保存：${e.message||e}`)}finally{setBusy(false)}
      }
      const retryExtraction=async()=>{
        setBusy(true);setError('')
        try{await postJson(`${API_ROOT}/jobs/${encodeURIComponent(scope.auto_extraction.job_id)}/retry`,{});await refresh()}
        catch(e){setError(`整理重试未提交：${e.message||e}`)}finally{setBusy(false)}
      }
      const extraction=scope?.auto_extraction
      const extractionText=scope?.auto_extract_available===false?'后台已关闭聊天后自动整理':scope?.auto_extract===false || mode==='off'?'聊天后自动整理已关闭':
        ({queued:'对话原文已保存，等待后台提取。',running:'正在后台提取本轮记忆…',done:extraction?.memories_added || extraction?.rules_added?`新增 ${extraction?.memories_added || 0} 条记忆、${extraction?.rules_added || 0} 条规则候选。`:'本轮没有需要新增的长期记忆。',partial:'部分内容整理失败，原文保留，可重试。',failed:'整理失败，原文保留，可重试。',cancelled:'本轮整理已取消。',saved:'对话原文已保存，尚未取得可用的抽取模型。',skipped:'本轮没有可整理的用户内容。'})[extraction?.status] || '已开启，正常聊天结束后自动整理；使用本轮模型处理对话。'
      const recent=readSent(records[0]?.sent)
      const renderRecord=(record,index)=>{
        const content=readSent(record.sent)
        const labels={facts:'事实',constraints:'约束',rules:'规则',preferences:'偏好',methods:'方法',todos:'待办',objects:'业务对象'}
        return React.createElement('section',{key:record.id,style:{borderTop:'1px solid rgba(120,180,220,.2)',paddingTop:18,marginTop:18}},
          React.createElement('strong',null,index===0?'最近一次实际使用':'较早的调用'),
          React.createElement('div',{style:{fontSize:12,color:'#8ea4b8',marginTop:6}},record.sentAt || '时间未记录'),
          content.background.task ? React.createElement('p',{style:{lineHeight:1.6}},'当时的问题：',content.background.task) : null,
          React.createElement('div',{style:{margin:'12px 0',fontSize:13}},content.parsed?`实际带入 ${content.rows.length} 条记忆 / 规则`:'这是一条旧格式记录，可在下方查看原文'),
          ...content.rows.map((row,i)=>React.createElement('article',{key:`${row.category}:${row.id || i}`,style:{padding:14,marginTop:10,border:'1px solid rgba(120,180,220,.2)',borderRadius:8,background:'rgba(120,180,220,.04)'}},
            React.createElement('div',{style:{color:'#8ea4b8',fontSize:12}},labels[row.category] || '记忆'),
            React.createElement('div',{style:{marginTop:6,lineHeight:1.7,whiteSpace:'pre-wrap'}},row.text || row.name || row.label || '内容未记录'),
            row.current_state ? React.createElement('div',null,'当前状态：',row.current_state) : null,
            ...(Array.isArray(row.evidence)?row.evidence:[]).map((e,j)=>React.createElement('blockquote',{key:j,style:{margin:'10px 0 0',paddingLeft:12,borderLeft:'2px solid #648da3',fontSize:12,color:'#a9bdca',lineHeight:1.7}},
              React.createElement('div',null,'来源：',e.source_title || e.source || '原始对话'),
              e.quote || '该证据未保存引文')))),
          content.parsed && !content.rows.length ? React.createElement('p',{style:{lineHeight:1.7,color:'#a9bdca'}},'这次没有匹配到可直接使用的记忆。可到脑内星河查看已导入、已确认的记忆与项目归属。') : null,
          content.unknowns.length ? React.createElement('p',{style:{color:'#e6bf78'}},`另有 ${content.unknowns.length} 项规则条件尚无法确认，请在大脑中核对。`) : null,
          content.rows.length ? React.createElement('div',{style:{display:'grid',gap:8,marginTop:14}},
            React.createElement('textarea',{rows:2,value:feedback[record.id] || '',placeholder:'哪条不准确？在这里说明，反馈会进入记忆治理。',onChange:e=>setFeedback(value=>({...value,[record.id]:e.target.value}))}),
            React.createElement('div',null,
              React.createElement('button',{type:'button',disabled:busy,onClick:()=>sendFeedback(record.id,'helpful')},'这些记忆有帮助'),
              React.createElement('button',{type:'button',disabled:busy,onClick:()=>sendFeedback(record.id,'incorrect'),style:{marginLeft:8}},'提交不准确反馈'))) : null,
          React.createElement('details',{style:{marginTop:12,fontSize:12,color:'#8ea4b8'}},React.createElement('summary',null,'原始调用记录'),React.createElement('pre',{style:{whiteSpace:'pre-wrap',maxHeight:240,overflow:'auto'}},typeof record.sent==='string'?record.sent:JSON.stringify(record.sent,null,2))))
      }
      return React.createElement('div', { style: { ...pageStyle, overflow: 'auto', padding: 16, boxSizing: 'border-box' } },
        React.createElement('div', { style: { ...cardStyle, width: '100%', maxWidth: 960, margin: '0 auto',alignSelf:'flex-start',boxSizing:'border-box' } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
            React.createElement('strong', null, '大脑为这次回答提供了什么'),
            React.createElement('button',{type:'button',disabled:typeof props?.openView!=='function',onClick:()=>props.openView('memory-brain','graph')},'查看完整记忆图谱')),
          React.createElement('div', { style: { marginTop: 10, fontSize: 12, color: '#8ea4b8' } }, '自动检索，无需填写参数。这里直接展示实际带入模型的记忆、规则和来源。'),
          React.createElement('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 14, fontSize: 12 } }, '会话模式', React.createElement('select', { value: mode, onChange: (e) => chooseMode(e.target.value) }, React.createElement('option', { value: 'auto' }, 'auto · 自动'), React.createElement('option', { value: 'off' }, 'off · 关闭'), React.createElement('option', { value: 'preview' }, 'preview · 预览'))),
          React.createElement('button', { type: 'button', disabled: busy || !id, onClick: ignoreTurn, style: { marginLeft: 12, marginTop: 14 } }, '仅本轮忽略'),
          React.createElement('div',{role:'status',style:{display:'grid',gap:6,marginTop:14,fontSize:13}},
            React.createElement('div',null,'项目：',scope ? (scope.project_id ? scope.project_name || scope.project_id : '通用记忆（尚未绑定工作区）') : '正在读取…'),
            React.createElement('div',null,'当前任务：',scope?.task_description || recent.background.task || (records.length?'旧调用没有任务信息，下次提问时自动更新':'等待下一次提问，自动识别任务')),
            scope?.object_id ? React.createElement('div',null,'关联对象：',scope.object_name || scope.object_id) : null),
          React.createElement('div',{role:'status',style:{marginTop:12,fontSize:13,lineHeight:1.7,color:['failed','partial'].includes(extraction?.status)?'#e6bf78':'#a9bdca'}},'聊天后整理：',extractionText,
            ['failed','partial'].includes(extraction?.status) && extraction?.job_id ? React.createElement('button',{type:'button',disabled:busy,onClick:retryExtraction,style:{marginLeft:8}},'重试整理') : null),
          scope ? React.createElement('details',{style:{marginTop:14,fontSize:12,color:'#8ea4b8'}},
            React.createElement('summary',{style:{cursor:'pointer'}},'高级设置（通常无需修改）'),
            React.createElement('label',{style:{display:'block',marginTop:10}},React.createElement('input',{type:'checkbox',checked:scope.auto_extract!==false,disabled:busy || scope.auto_extract_available===false,onChange:event=>setAutomaticExtraction(event.target.checked)}),' 聊天结束后自动整理记忆'),
            React.createElement('form',{key:JSON.stringify([id,scope.project_id,scope.task_id,scope.task_description,scope.object_id]),onSubmit:saveBindings,style:{display:'grid',gap:8,marginTop:12}},
            ...[['project_id','项目 ID'],['task_id','任务 ID'],['task_description','任务说明'],['object_id','业务对象 ID']].map(([key,label])=>React.createElement('label',{key},label,React.createElement('input',{name:key,defaultValue:scope[key]||'',maxLength:1000,disabled:busy}))),
            React.createElement('button',{type:'submit',disabled:busy||!id},'保存手动调整')),
            React.createElement('button',{type:'button',disabled:busy||!id,onClick:restoreAutomatic},'恢复自动识别')) : null,
          mode === 'preview' ? React.createElement('div', { style: { marginTop: 8, color: '#e6bf78', fontSize: 12 } }, '首次发送会暂停模型请求。确认下方内容后，请回到聊天重发原问题；取消不会发送。') : null,
          scope?.preview ? React.createElement('div',null,
            React.createElement('pre',{style:{whiteSpace:'pre-wrap',maxHeight:240,overflow:'auto'}},scope.preview.text),
            React.createElement('button',{type:'button',disabled:busy,onClick:()=>submitPreview(true)},'确认这份预览'),
            React.createElement('button',{type:'button',disabled:busy,onClick:()=>submitPreview(false)},'取消这次预览')) : null,
          notice ? React.createElement('div',{role:'status'},notice) : null,
          error ? React.createElement('div', { role: 'alert', style: { color: '#ff9a9a', marginTop: 10, fontSize: 12 } }, error) : null,
          records.length ? renderRecord(records[0],0) : error ? null : React.createElement('p',{style:{marginTop:24,lineHeight:1.7,color:'#a9bdca'}},mode==='off'?'本会话已关闭记忆。切回自动后，下一次回答会检索大脑。':'本会话暂无实际调用记录。继续聊天后，这里会展示用到的记忆；已抽取的数据和关系可在完整记忆图谱中查看。'),
          records.length>1 ? React.createElement('button',{type:'button',style:{marginTop:16},onClick:()=>setOpen(value=>!value)},open?'收起较早记录':`查看较早的 ${records.length-1} 次调用`) : null,
          open ? records.slice(1).map((record,index)=>renderRecord(record,index+1)) : null
        ))
    }

    function MemoryBrainView(props) {
      const focus=props?.viewRequest?.focus
      const url = React.useMemo(()=>{const target=new URL(panelUrl(),window.location.origin);if(focus==='graph')target.searchParams.set('ui','graph');return target.toString()}, [focus]); const frameRef = React.useRef(null); const [phase, setPhase] = React.useState('probe'); const [detail, setDetail] = React.useState('')
      const probe = React.useCallback(() => { let alive = true; setPhase('probe'); setDetail(''); fetch((() => { const health = new URL(url, window.location.origin); health.pathname += 'api/health'; return health.toString() })(), { credentials: 'include', cache: 'no-store' }).then(async (r) => { const health = await r.json(); if (!alive) return; if (r.ok && health.ok === true) setPhase('ready'); else { setDetail(health.error || `HTTP ${r.status}`); setPhase('fail') } }).catch((e) => { if (alive) { setDetail(String(e.message || e)); setPhase('fail') } }); return () => { alive = false } }, [url])
      React.useEffect(() => probe(), [probe]); React.useEffect(() => { const onMessage = (e) => { if (e.origin !== window.location.origin || e.data?.type !== 'memory-brain:exit-to-chat') return; if (frameRef.current && e.source !== frameRef.current.contentWindow) return; props?.openView?.('chat', '') }; window.addEventListener('message', onMessage); return () => window.removeEventListener('message', onMessage) }, [props])
      if (phase === 'fail') return React.createElement('div', { style: { ...pageStyle, alignItems: 'center', justifyContent: 'center', padding: 24 } }, React.createElement('div', { style: cardStyle }, React.createElement('strong', null, '脑内星河加载失败'), React.createElement('div', { style: { color: '#ff9a9a', margin: '10px 0' } }, detail), React.createElement('button', { type: 'button', onClick: probe }, '重试')))
      return React.createElement('div', { style: pageStyle }, React.createElement('iframe', { ref: frameRef, src: url, title: '脑内星河', allow: 'fullscreen', style: { position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, opacity: phase === 'ready' ? 1 : 0 } }), phase === 'probe' ? React.createElement('div', { style: { margin: 'auto', color: '#9ff0ff' } }, '正在连接脑内星河…') : null)
    }

    const inject = ['slots']
    async function apply(ctx) {
      try {
        const response = await window.fetch('/memory-brain-config', {credentials:'include',cache:'no-store'})
        if (response.ok) {
          const settings = await response.json()
          if (settings.ok && /^\/(?!\/)[a-zA-Z0-9_/-]+$/.test(settings.prefix)) {
            PANEL_PATH = settings.prefix.replace(/\/$/,'') + '/'
            API_ROOT = PANEL_PATH + 'api/loop'
          }
        }
      } catch { /* Older hosts use the default prefix. */ }
      ctx.slots.inject('conversation.view', () => {
        ctx.slots.register({ name: 'conversation.view', id: 'memory-chat', order: 5, label: () => '本轮记忆' }, MemoryRecordsView)
        ctx.slots.register({ name: 'conversation.view', id: 'memory-brain', order: 10, label: () => '脑内星河' }, MemoryBrainView)
      })
    }
    if (typeof window !== 'undefined') window.__memoryBrainClientTest = { normalizeRecords, storageKey, getRecords }
    return { apply, inject }
  },
})
