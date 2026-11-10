import test from 'node:test'
import assert from 'node:assert/strict'
import { loadAll, clearCache } from '../web/src/api.js'

test('a fallback sample is visibly degraded rather than falsely connected', async t => {
  const previous=globalThis.fetch
  globalThis.fetch=async url=>String(url).includes('sample-payload')
    ? {ok:true,text:async()=>JSON.stringify({source:'sample',status:{connected:true},graph:{nodes:[],edges:[],memories:[]}})}
    : {ok:false,status:503,text:async()=>'{"error":"offline"}'}
  clearCache();t.after(()=>{globalThis.fetch=previous;clearCache()})
  const data=await loadAll()
  assert.equal(data.status.connected,false)
  assert.equal(data.status.degraded,true)
  assert.equal(data.source,'sample')
})
