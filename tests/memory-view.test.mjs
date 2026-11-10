import test from 'node:test'
import assert from 'node:assert/strict'
import { selectMemoryWindow } from '../web/src/memory-view.js'

test('visible graph pagination filters actual memories and preserves entity references', () => {
 const now=Date.parse('2026-11-10T00:00:00Z')
 const rows=[{id:1,kind:'fact',created_at:now/1000},{id:2,kind:'fact',created_at:now/1000-86400},{id:3,kind:'reasoning',created_at:now/1000},{id:4,kind:'fact',created_at:0}]
 const data={memories:rows,graph:{nodes:[{id:10}],edges:[],memories:[{...rows[0],entities:[10]}]}}
 const first=selectMemoryWindow(data,{range:'最近7天',tone:'fact',limit:1},now)
 assert.equal(first.total,2);assert.equal(first.loaded,1);assert.equal(first.graph.memories[0].id,1)
 assert.deepEqual(first.graph.memories[0].entities,[10])
 const more=selectMemoryWindow(data,{range:'最近7天',tone:'fact',limit:200},now)
 assert.equal(more.loaded,2);assert.deepEqual(more.graph.memories.map(m=>m.id),[1,2])
 assert.equal(data.graph.memories.length,1)
})
