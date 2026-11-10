import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createExecutionStore } from '../lib/execution-store.js'

test('automatic extraction controls and durable job association are persisted',()=>{
 const db=new DatabaseSync(':memory:');const store=createExecutionStore(db)
 store.scope('s',{auto_extract:false,auto_extraction:{status:'queued',job_id:'j'}})
 assert.equal(store.scope('s').auto_extract,false)
 assert.equal(store.scope('s').auto_extraction.job_id,'j')
 assert.throws(()=>store.scope('s',{auto_extract:'yes'}),/invalid_auto_extract/)
 db.close()
})

test('automatic scope provenance survives persistence and reloading the store', () => {
 const db=new DatabaseSync(':memory:');const first=createExecutionStore(db)
 first.scope('s',{project_id:'p',project_name:'项目',workspace:'E:\\p',auto_scope:{project_id:'p',task_id:'s'}})
 const result=createExecutionStore(db).scope('s')
 assert.deepEqual(result.auto_scope,{project_id:'p',task_id:'s'})
 assert.equal(result.project_name,'项目');assert.equal(result.workspace,'E:\\p')
 db.close()
})

test('execution ledger preserves scopes, retries, actual sent context and terminal state', () => {
 const db = new DatabaseSync(':memory:'); const store = createExecutionStore(db)
 store.scope('c1',{project_id:'p1',task_id:'task-id',mode:'off'})
 assert.equal(store.scope('c1').project_id,'p1')
 store.start({invocation_id:'i1',conversation_id:'c1',turn_id:'t1',attempt:1,provider:'test',model:'model'})
 store.sent('i1',{text:'actual sent',selected:{memories:[{id:'m1',version:1}],rules:[]},tokens:10,fingerprint:'f',compiler_version:'1',context_run_id:'r1'})
 store.finish('i1',{status:'completed',answer:'answer'})
 store.finish('i1',{status:'cancelled',answer:''})
 assert.equal(store.get('i1').status,'completed')
 assert.equal(store.list('c1')[0].sent.text,'actual sent')
 assert.equal(store.get('i1').context_run_id,'r1')
 store.tool({tool_call_id:'tc1',invocation_id:'i1',name:'read',status:'completed',result:{api_key:'secret',value:'ok'}})
 assert.ok(!JSON.stringify(store.get('i1')).includes('secret'))
 db.close()
})

test('execution migration keeps existing data and is repeatable', () => {
 const db = new DatabaseSync(':memory:')
 db.exec("CREATE TABLE original_memory(id TEXT PRIMARY KEY,text TEXT); INSERT INTO original_memory VALUES('m','keep')")
 createExecutionStore(db); createExecutionStore(db)
 assert.equal(db.prepare('SELECT text FROM original_memory').get().text,'keep')
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM loop_execution_migrations').get().n,1)
 db.exec("INSERT INTO loop_execution_migrations VALUES(99,'future')")
 assert.throws(()=>createExecutionStore(db),/unsupported_execution_schema/)
 db.close()
})
