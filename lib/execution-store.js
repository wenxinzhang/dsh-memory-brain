import { randomUUID } from 'node:crypto'

const sensitiveKey = /api.?key|authorization|password|secret|access.?token|refresh.?token/i
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,sensitiveKey.test(k) ? '[REDACTED]' : redact(v)]))
  if (typeof value === 'string') return value.replace(/Bearer\s+[\w.\-]+/gi,'Bearer [REDACTED]').replace(/sk-[\w-]{8,}/g,'[REDACTED]')
  return value
}
const json = value => JSON.stringify(redact(value))
const parsed = row => row ? JSON.parse(row.payload_json) : null
const now = () => new Date().toISOString()

export function createExecutionStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS loop_execution_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`)
  const latest = db.prepare('SELECT MAX(version) AS version FROM loop_execution_migrations').get().version || 0
  if (latest > 1) throw new Error('unsupported_execution_schema')
  if (latest < 1) {
    db.exec('BEGIN')
    try {
      db.exec(`CREATE TABLE loop_conversation_scopes(conversation_id TEXT PRIMARY KEY,payload_json TEXT NOT NULL,updated_at TEXT NOT NULL);
       CREATE TABLE loop_model_invocations(invocation_id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,turn_id TEXT,context_run_id TEXT,status TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,payload_json TEXT NOT NULL);
       CREATE INDEX idx_loop_invocation_conversation ON loop_model_invocations(conversation_id,started_at);
       CREATE TABLE loop_tool_executions(tool_call_id TEXT PRIMARY KEY,invocation_id TEXT,conversation_id TEXT,payload_json TEXT NOT NULL,updated_at TEXT NOT NULL);
       CREATE INDEX idx_loop_tool_invocation ON loop_tool_executions(invocation_id);
       CREATE TABLE loop_invocation_feedback(id TEXT PRIMARY KEY,invocation_id TEXT NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL);
       CREATE INDEX idx_loop_invocation_feedback ON loop_invocation_feedback(invocation_id);`)
      db.prepare('INSERT INTO loop_execution_migrations VALUES(1,?)').run(now())
      db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }
  }
  function scope(id, patch) {
    if (!id) throw new Error('conversation_id_required')
    const previous = parsed(db.prepare('SELECT payload_json FROM loop_conversation_scopes WHERE conversation_id=?').get(id)) || {conversation_id:id,owner:'local-user',project_id:null,task_id:null,object_id:null,mode:'auto'}
    if (!patch) return previous
    const allowed = ['project_id','task_id','task_description','object_id','object_name','mode','ignored_by_turn','preview','preview_approval','current_turn','auto_scope','workspace','project_name','auto_extract','auto_extraction']
    const next = {...previous}
    for (const key of allowed) if (Object.hasOwn(patch,key)) next[key] = patch[key]
    if (!['auto','off','preview'].includes(next.mode)) throw new Error('invalid_memory_mode')
    if(next.auto_extract!=null && typeof next.auto_extract!=='boolean')throw new Error('invalid_auto_extract')
    if (next.ignored_by_turn != null && (typeof next.ignored_by_turn !== 'object' || Array.isArray(next.ignored_by_turn) || Object.values(next.ignored_by_turn).some(value => typeof value !== 'boolean'))) throw new Error('invalid_ignored_turns')
    db.prepare('INSERT INTO loop_conversation_scopes VALUES(?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at').run(id,json(next),now())
    return next
  }
  function base(id) { return parsed(db.prepare('SELECT payload_json FROM loop_model_invocations WHERE invocation_id=?').get(id)) }
  function save(record) {
    db.prepare(`INSERT INTO loop_model_invocations VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(invocation_id) DO UPDATE SET context_run_id=excluded.context_run_id,status=excluded.status,finished_at=excluded.finished_at,payload_json=excluded.payload_json`).run(record.invocation_id,record.conversation_id,record.turn_id || null,record.context_run_id || null,record.status,record.started_at,record.finished_at || null,json(record))
    return record
  }
  function start(record) {
    if (!record.invocation_id || !record.conversation_id) throw new Error('invocation_identity_required')
    return base(record.invocation_id) || save({...record,status:'running',started_at:now()})
  }
  function sent(id, compiled) {
    const record = base(id); if (!record) throw new Error('invocation_not_found')
    if (record.status !== 'running') throw new Error('invocation_not_running')
    return save({...record,context_run_id:compiled.context_run_id,sent:compiled,sent_at:now()})
  }
  function finish(id, patch) {
    const record = base(id); if (!record) throw new Error('invocation_not_found')
    if (record.status !== 'running' && record.status !== 'queued') return record
    if (!['completed','failed','cancelled'].includes(patch.status)) throw new Error('invalid_terminal_status')
    return save({...record,...patch,invocation_id:id,finished_at:now(),duration_ms:Date.now()-Date.parse(record.started_at)})
  }
  function tool(record) {
    if (!record.tool_call_id) throw new Error('tool_call_id_required')
    const previous = parsed(db.prepare('SELECT payload_json FROM loop_tool_executions WHERE tool_call_id=?').get(record.tool_call_id)) || {}
    const next = {...previous,...record}
    db.prepare('INSERT INTO loop_tool_executions VALUES(?,?,?,?,?) ON CONFLICT(tool_call_id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at').run(next.tool_call_id,next.invocation_id || null,next.conversation_id || null,json(next),now())
    return next
  }
  function feedback(record) {
    if (!base(record.invocation_id)) throw new Error('invocation_not_found')
    const id = record.id || randomUUID()
    db.prepare('INSERT OR IGNORE INTO loop_invocation_feedback VALUES(?,?,?,?)').run(id,record.invocation_id,json({...record,id}),now())
    return {...record,id}
  }
  function get(id) {
    const record = base(id); if (!record) return null
    return {...record,tools:db.prepare('SELECT payload_json FROM loop_tool_executions WHERE invocation_id=?').all(id).map(parsed),feedback:db.prepare('SELECT payload_json FROM loop_invocation_feedback WHERE invocation_id=?').all(id).map(parsed)}
  }
  return {scope,start,sent,finish,tool,feedback,get,list:(id) => db.prepare('SELECT invocation_id FROM loop_model_invocations WHERE conversation_id=? ORDER BY started_at DESC LIMIT 100').all(id).map(r=>get(r.invocation_id))}
}
