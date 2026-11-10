import { randomUUID, createHash } from 'node:crypto'
import { compileContext, estimateTokens, messageTokens } from './context-compiler.js'

const call = async (target, names, ...args) => {
  for (const name of names) if (typeof target?.[name] === 'function') return target[name](...args)
}
const sessionIdOf = agent => agent?.session?.id ?? agent?.sessionId
const messageText = message => typeof message?.content === 'string' ? message.content : (message?.content || []).filter(p=>p.type==='text').map(p=>p.text).join('\n')
const SOURCE = 'plugin:@dafeiyu/dsh-memory-brain'
const memoryMessage = text => ({id:randomUUID(),role:'user',source:{kind:SOURCE},content:[{type:'text',text}]})
const owned = message => message?.source?.kind === SOURCE || (message?.source?.kind === 'plugin' && message.source.plugin === '@dafeiyu/dsh-memory-brain')

// Use the host's durable surface replacement API; never mutate historical events or frozen requests.
function projectContext(session, compiled) {
  if (!session?.append || !session.surface?.nodes) return false
  const desktop = typeof session.eventAt === 'function'
  if (!desktop && !session.events) return false
  const active = session.surface.nodes.map(seq => desktop ? session.eventAt(seq) : session.events.find(event => event.seq === seq))
    .filter(event => event?.type === 'user/message' && owned(event.data))
  if (!active.length) return false
  for (const event of active) {
    const text = compiled && event === active.at(-1) ? compiled.text : 'Earlier memory context retired; no personal memory is active in this block.'
    if (messageText(event.data) === text) continue
    const range = desktop ? {startSeq:event.seq,endSeq:event.seq} : {start:event.seq,end:event.seq}
    session.append('user/message', memoryMessage(text), {surfaceOp:{op:'replace',...range},sourceEventSeqs:[event.seq]})
  }
  return true
}

export function createDshIntegration({ ctx, runtime, executionStore, config = {}, logger } = {}) {
  const store = executionStore || runtime
  let modelService
  ctx?.inject?.(['llm'], serviceContext => {
    const service=serviceContext.llm
    modelService=service
    const release=runtime?.setChatExtractionModel?.(async(messages,selection,{signal})=>{
      const info=typeof service.resolveModelInfo==='function'?await service.resolveModelInfo(selection.provider,selection.model,signal):null
      const window=info?.context?.contextWindow
      const prepared=await service.prepareCall({provider:selection.provider,model:selection.model,temperature:0.1,maxTokens:window?Math.max(256,Math.min(6000,Math.floor(window/3))):6000},signal)
      const canonical=messages.map(message=>({id:randomUUID(),role:message.role,source:{kind:SOURCE},content:[{type:'text',text:message.content}]}))
      let deltas='';const blocks=[];let failed=false
      for await(const chunk of prepared.stream({...prepared.config,messages:canonical,signal})) {
        signal.throwIfAborted()
        if(['text','text-delta'].includes(chunk?.type))deltas+=chunk.text || ''
        if(chunk?.type==='block-end' && chunk.block?.type==='text')blocks.push(chunk.block.text || '')
        if(chunk?.type==='finish' && ['error','aborted'].includes(chunk.reason?.kind))failed=true
      }
      if(failed)throw new Error('聊天记忆抽取模型调用失败或被取消')
      signal.throwIfAborted()
      return blocks.length?blocks.join('\n'):deltas
    })
    serviceContext.effect?.(() => () => { release?.();if(modelService===service)modelService=undefined })
  })
  // Optional: the host token meter prices messages under the same fixed
  // heuristic it uses for compaction, so the request budget cannot disagree
  // with the host about how full the context is.
  let tokenMeter
  ctx?.inject?.(['tokenMeter'], serviceContext => {
    const service = serviceContext.tokenMeter
    tokenMeter = service
    serviceContext.effect?.(() => () => { if (tokenMeter === service) tokenMeter = undefined })
  })
  const associations = new WeakMap()
  const prepared = new Map()
  const latest = new Map()
  const attempts = new Map()
  const turns = new Map()
  const sessions = new Map()
  const chatTurns = new Map()
  const chatModels = new Map()
  const unknownWindowWarned = new Set()
  /**
   * Price one message. The host meter uses the same fixed heuristic the host
   * prices its own surface and compaction pressure with, so take whichever
   * price is larger: it can only make the guard more conservative.
   */
  const priceMessage = message => {
    const floor = messageTokens(message)
    if (typeof tokenMeter?.estimateMessage !== 'function') return floor
    try { return Math.max(floor, Number(tokenMeter.estimateMessage(message)) || 0) } catch { return floor }
  }
  const requestTokensOf = options => estimateTokens(options, priceMessage)
  /** Model window in tokens: live session metadata, then the explicit config fallback. 0 = unknown. */
  const windowTokensOf = (session, modelInfo) => Math.floor(
    Number(modelInfo?.context?.contextWindow)
    || Number(session?.requestContext?.()?.contextWindow)
    || Number(config.contextWindow)
    || 0)
  const reserveTokensOf = options => Math.floor(Number(options?.maxTokens) || Number(config.reservedOutput) || 2048)
  const scopeFor = async id => id ? await call(store,['scope'],id) || {} : {}
  const finish = async (id,patch) => typeof store?.finish === 'function' ? store.finish(id,patch) : call(store,['updateInvocation'],{invocation_id:id,...patch})
  const onPreStep = async (payload,next) => {
    const decision = await next()
    if (!decision || typeof decision !== 'object' || decision.kind === 'reject') return decision
    const conversation_id = sessionIdOf(payload.agent)
    if(conversation_id && payload.modelSelection)chatModels.set(conversation_id,{turn:payload.turn,selection:{provider:payload.modelSelection.provider,model:payload.modelSelection.model}})
    if (conversation_id && payload.agent?.session) sessions.set(conversation_id, payload.agent.session)
    let scope = await scopeFor(conversation_id)
    if (conversation_id && payload.turn != null && scope.current_turn !== payload.turn) await call(store,['scope'],conversation_id,{current_turn:payload.turn})
    if(scope.mode==='off' || scope.ignored_by_turn?.[payload.turn]) {
      projectContext(payload.agent?.session, null)
      prepared.delete(conversation_id)
      return decision
    }
    const query = (payload.messages || []).filter(m => m.role === 'user' && !owned(m) && (!m.source || m.source.kind === 'user')).map(messageText).join('\n')
      || (turns.get(conversation_id)?.turn === payload.turn ? turns.get(conversation_id).query : '')
      || scope.task_description || ''
    turns.set(conversation_id, {turn:payload.turn,query})
    if(conversation_id && typeof runtime?.inferConversationScope==='function') {
      const automatic=key=>scope[key]==null || scope[key]==='' || (scope.auto_scope && scope[key]===scope.auto_scope[key])
      const inferred=await runtime.inferConversationScope({cwd:payload.agent?.session?.header?.cwd,query,project_id:automatic('project_id')?undefined:scope.project_id})
      const values={project_id:inferred.project_id,task_id:conversation_id,task_description:query.slice(0,1000),object_id:inferred.object_id,object_name:inferred.object_name}
      const patch={auto_scope:{...(scope.auto_scope || {})},workspace:inferred.workspace,project_name:inferred.project_name}
      for(const [key,value] of Object.entries(values)) if(automatic(key) && (key!=='object_name' || automatic('object_id'))) {patch[key]=value;patch.auto_scope[key]=value}
      scope={...scope,...patch}
      await call(store,['scope'],conversation_id,patch)
    }
    const observed=chatTurns.get(conversation_id)
    if(observed && observed.turn===payload.turn && !observed.scope)observed.scope={project_id:scope.project_id,task_id:scope.task_id}
    const context = await call(runtime,['buildContext','loadContext','getContext'],{
      owner:'local-user',project:scope.project_id,task:scope.task_description || query,task_id:scope.task_id,object_id:scope.object_id,object_name:scope.object_name,query,
    })
    if (!context) { logger?.warn?.('[memory-brain] context API unavailable; no context injected'); return decision }
    if(context.ok===false) throw new Error(context.error || 'context_build_failed')
    const session = payload.agent?.session
    const header = session?.requestHeader?.() || {}
    const history = (session?.deriveMessages?.() || []).filter(m => !owned(m))
    const requestTokens = requestTokensOf({system:header.system,messages:[...history,...(decision.messages || [])],tools:header.tools})
    const selection=payload.modelSelection
    const modelInfo=selection && typeof modelService?.resolveModelInfo==='function'
      ? await modelService.resolveModelInfo(selection.provider,selection.model,payload.signal) : null
    const windowTokens=windowTokensOf(session,modelInfo)
    const compiled=compileContext(context,{contextWindow:windowTokens > 0 ? windowTokens : undefined,reservedOutput:config.reservedOutput ?? modelInfo?.defaultMaxTokens,requestTokens})
    if(scope.mode==='preview' && (payload.step == null || payload.step <= 1)) {
      const previewFingerprint=createHash('sha256').update(JSON.stringify({context:compiled.fingerprint,query,project:scope.project_id,task:scope.task_id,object:scope.object_id})).digest('hex')
      if (scope.preview_approval !== previewFingerprint) {
        if (conversation_id) await call(store,['scope'],conversation_id,{preview:{fingerprint:previewFingerprint,text:compiled.text,query,turn_id:payload.turn},preview_approval:null})
        return {...decision,kind:'reject',reason:'memory_preview_required'}
      }
      await call(store,['scope'],conversation_id,{preview:null,preview_approval:null})
    }
    if(conversation_id) prepared.set(conversation_id,{compiled,turn:payload.turn,step:payload.step})
    // Pre-step messages are persisted by agent-loop before immutable LLM request creation.
    if (projectContext(payload.agent?.session, compiled)) return decision
    const message=memoryMessage(compiled.text)
    return {...decision,messages:[...(decision.messages||[]),message]}
  }
  const onAgentRequest=(payload,next)=>{
    if(payload.signal && typeof payload.signal==='object') associations.set(payload.signal,{turn:payload.turn,step:payload.step,sessionId:sessionIdOf(payload.agent)})
    const session = payload.agent?.session
    if (session?.id) sessions.set(session.id, session)
    return next()
  }
  const onStream=(options,next)=>(async function*(){
    const association=options.signal ? associations.get(options.signal) : undefined
    const conversation_id=options.sessionId ?? association?.sessionId
    if(!conversation_id){ yield* next(); return }
    if(association && options.provider && options.model)chatModels.set(conversation_id,{turn:association.turn,selection:{provider:options.provider,model:options.model}})
    const invocation_id=randomUUID(); latest.set(conversation_id,invocation_id)
    const candidate=prepared.get(conversation_id)
    const pending=candidate && (!association || (candidate.turn===association.turn && candidate.step===association.step)) ? candidate : undefined
    const request_id = `${conversation_id}:${association?.turn ?? invocation_id}:${association?.step ?? 0}`
    const attempt = (attempts.get(request_id) || 0) + 1; attempts.set(request_id, attempt)
    await call(store,['start','recordInvocation'],{invocation_id,request_id,conversation_id,provider:options.provider,model:options.model,turn_id:association?.turn,step:association?.step,attempt})
    let terminal=false;let chunks=0;let answer='';let finishReason;let usage
    try {
      const window = windowTokensOf(sessions.get(conversation_id))
      if (window <= 0) {
        // No window metadata: never guess a small default (the old 8192 fallback
        // rejected every request). The host's compaction owns real pressure.
        if (!unknownWindowWarned.has(conversation_id)) {
          unknownWindowWarned.add(conversation_id)
          logger?.warn?.('[memory-brain] model context window unknown; request budget guard skipped for this conversation')
        }
      } else {
        const requestTokens = requestTokensOf({system:options.system,messages:options.messages,tools:options.tools})
        // `maxTokens` is the provider's output cap, not a demand on this request.
        // A profile that sets it to the whole window must not reject every call:
        // reserve at most a quarter of the window for the answer.
        const reserve = Math.min(reserveTokensOf(options), Math.floor(window / 4))
        if (requestTokens + reserve + 256 > window) {
          throw Object.assign(new Error('request_exceeds_model_budget'), { code: 'request_exceeds_model_budget', requestTokens, reserve, window })
        }
      }
      const actual=(options.messages||[]).find(m=>pending && messageText(m)===pending.compiled.text)
      if(actual && typeof store?.sent==='function') await store.sent(invocation_id,{...pending.compiled,injected:true})
      for await(const chunk of next()){
        if(options.signal?.aborted) throw Object.assign(new Error('aborted'),{name:'AbortError'})
        chunks++
        if (['text','text-delta'].includes(chunk?.type) && typeof chunk.text === 'string') answer += chunk.text
        if (chunk?.type === 'usage' && chunk.usage) usage = chunk.usage
        if (chunk?.type === 'finish') { finishReason = chunk.reason; if (chunk.usage) usage = chunk.usage }
        yield chunk
      }
      const status = finishReason?.kind === 'error' ? 'failed' : finishReason?.kind === 'aborted' || options.signal?.aborted ? 'cancelled' : 'completed'
      await finish(invocation_id,{status,chunks,answer,usage,finish_reason:finishReason});terminal=true
    }catch(error){
      await finish(invocation_id,{status:options.signal?.aborted || error?.name==='AbortError'?'cancelled':'failed',chunks,answer,error:String(error?.message||error)});terminal=true
      throw error
    }finally{
      if(!terminal) await finish(invocation_id,{status:'cancelled',chunks,answer})
    }
  })()
  const fields=exec=>{
    const conversation_id=sessionIdOf(exec.agent)
    return {tool_call_id:exec.callId,invocation_id:latest.get(conversation_id),conversation_id,name:exec.name,arguments:exec.arguments}
  }
  const onPreExecute=async(exec,next)=>{
    const scope=await scopeFor(sessionIdOf(exec.agent))
    const input={owner:'local-user',project:scope.project_id,task:scope.task_id,task_id:scope.task_id,object_id:scope.object_id,object_name:scope.object_name,event:exec.name,action:{type:exec.name,target:exec.name,object_id:scope.object_id,parameters:exec.arguments},callId:exec.callId}
    let result=await call(runtime,['checkAction'],input)
    let hostDecision
    if (result?.result === 'pending_authorization') {
      hostDecision=await next()
      if(hostDecision?.kind!=='allow') return hostDecision
      // Policy allow is not user approval. Return ask so the host's approval service runs.
    }
    const decision=result?.result||result?.decision
    const kind=(!result || result.ok===false || ['blocked','denied','deny'].includes(decision))?'deny':['pending_authorization','ask'].includes(decision)?'ask':null
    if(kind){await call(store,['tool'],{...fields(exec),decision:kind,check:result});return {kind,reason:result.reason||result.note||'Memory rule requires review'}}
    return hostDecision || next()
  }
  const onPostExecute=async(exec,result,next)=>{
    await call(store,['tool','recordToolResult'],{...fields(exec),result})
    return next?next():{kind:'accept'}
  }
  const onSessionEvent=(session,event)=>{
    try {
      if(event.type==='turn/start')chatTurns.set(session.id,{turn:event.data?.turn,startSeq:event.seq})
      if(event.type==='turn/end') {
        const current=chatTurns.get(session.id)
        chatTurns.delete(session.id)
        const model=chatModels.get(session.id)
        chatModels.delete(session.id)
        const scope=typeof store?.scope==='function'?store.scope(session.id):{}
        const enabled=config.loopAutoExtract!==false && scope.auto_extract!==false && scope.mode!=='off' && !scope.ignored_by_turn?.[event.data?.turn]
        if(enabled && event.data?.reason?.kind==='completed' && typeof runtime?.captureChatTurn==='function') {
          const at=seq=>typeof session.eventAt==='function'?session.eventAt(seq):session.events?.find(item=>item.seq===seq)
          let start=current?.turn===event.data.turn?current.startSeq:null
          if(start==null && Number.isInteger(event.seq))for(let seq=event.seq-1;seq>=Math.max(0,event.seq-10000);seq--){const previous=at(seq);if(previous?.type==='turn/start'){if(previous.data?.turn===event.data.turn)start=seq;break}}
          if(Number.isInteger(start) && Number.isInteger(event.seq)) {
            const messages=[]
            for(let seq=start+1;seq<event.seq;seq++) {
              const entry=at(seq)
              const message=entry?.type==='user/message'?entry.data:entry?.type==='assistant/message' && entry.data?.turn===event.data.turn && !entry.data.interrupted?entry.data.message:null
              if(!message || owned(message) || (message.role==='user' && message.source?.kind!=='user'))continue
              if(!['user','assistant'].includes(message.role))continue
              const content=messageText(message)
              if(content.trim())messages.push({id:message.id || `event-${seq}`,role:message.role,content,seq})
            }
            const bound=current?.scope || scope
            const snapshot={conversation_id:session.id,turn_id:`seq:${start}`,project:bound.project_id || null,task:bound.task_id || null,messages,modelSelection:model?.turn===event.data.turn?model.selection:null}
            const result=runtime.captureChatTurn(snapshot)
            store?.scope?.(session.id,{auto_extraction:{...result,turn:event.data.turn}})
          }
        }
      }
    } catch(error) {
      logger?.warn?.(`[memory-brain] automatic chat capture failed: ${error?.message || error}`)
      try{store?.scope?.(session.id,{auto_extraction:{status:'failed',error:String(error?.message || error)}})}catch{}
    }
    return call(runtime,['recordSessionEvent','recordEvent'],{sessionId:session.id,event})
  }
  for(const [event,handler] of [['agent/pre-step',onPreStep],['agent/request',onAgentRequest],['llm/stream',onStream],['tools/pre-execute',onPreExecute],['tools/post-execute',onPostExecute],['session/event',onSessionEvent]]) ctx?.on?.(event,handler)
  return {onPreStep,onAgentRequest,onStream,onPreExecute,onPostExecute,onSessionEvent}
}
