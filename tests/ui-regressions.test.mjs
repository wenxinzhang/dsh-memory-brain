import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { selectMemoryWindow } from '../web/src/memory-view.js'

test('closing and reopening the loop drawer leaves one set of root listeners', async () => {
  let code=readFileSync(new URL('../web/src/ui/loop.js',import.meta.url),'utf8')
  code=code.replace(/^import .*$/gm,'').replace('export function openLoop','function openLoop')
  const listeners=new Map();const element={innerHTML:'',querySelector:()=>null,querySelectorAll:()=>[]}
  const root={...element,querySelector:()=>element,addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn)},removeEventListener(name,fn){listeners.get(name)?.delete(fn)}}
  const storage={getItem:()=>null,setItem(){},removeItem(){}}
  const document={getElementById:()=>root,body:{classList:{add(){},remove(){}}},addEventListener(){},removeEventListener(){},querySelector:()=>null}
  const context={document,window:{localStorage:storage,sessionStorage:storage},api:new Proxy({},{get:()=>async()=>({items:[],counts:{}})}),esc:v=>String(v??''),fmt:v=>String(v),toast(){},console,setTimeout,clearTimeout,setInterval,clearInterval,Map,Set,Date}
  vm.createContext(context);vm.runInContext(code+'\nthis.openLoop=openLoop',context)
  context.openLoop({view:'graph'});await new Promise(r=>setTimeout(r,5))
  assert.match(root.innerHTML,/data-view="graph" aria-selected="true"/)
  for(const listener of [...listeners.get('click')]) await listener({target:{closest:selector=>selector==='[data-close]'?{}:null}})
  context.openLoop();await new Promise(r=>setTimeout(r,5))
  try {assert.equal(listeners.get('click').size,1);assert.equal(listeners.get('drop').size,1)}
  finally {for(const listener of [...listeners.get('click')])await listener({target:{closest:selector=>selector==='[data-close]'?{}:null}})}
})

test('application filter and load-more handlers update actual visible graph data', async () => {
 let code=readFileSync(new URL('../web/src/app.js',import.meta.url),'utf8').replace(/^import .*$/gm,'')
 const rows=Array.from({length:205},(_,id)=>({id,kind:'fact',tone:'fact',created_at:Date.now()/1000}))
 const data={overview:{loaded:2,total:205,timeRange:'全部时间',memoryType:'推理'},memories:rows,graph:{nodes:[],edges:[],memories:rows.slice(0,2)}}
 let handlers;const graphs=[];let requestedView
 const element={style:{},hidden:false,querySelector:()=>null,addEventListener(){},classList:{add(){},remove(){},toggle(){}}}
 const panel=()=>({setOverview(){},setLoaded(){},setStatus(){}})
 const context={window:{addEventListener(){}},location:{search:'?ui=graph'},document:{getElementById:()=>element,addEventListener(){}},URLSearchParams,selectMemoryWindow,loadAll:async()=>data,clearCache(){},mountTopbar:panel,mountLeft:(_,__,h)=>{handlers=h;return panel()},mountRight:panel,mountToolbar:panel,mountBrain:async()=>({setData:graph=>graphs.push(graph)}),toast(){},openRules(){},openLoop(options){requestedView=options?.view},icons:{},console,setTimeout,clearTimeout}
 vm.createContext(context);vm.runInContext(code,context)
 await new Promise(resolve=>setTimeout(resolve,5))
 assert.equal(requestedView,'graph','graph navigation must open the actual database workspace')
 assert.equal(graphs.at(-1)?.memories.length,0,'initial graph must match the displayed payload filter')
 handlers.onFilter({range:'全部时间',tone:'fact',type:'事实'})
 await handlers.onLoadMore()
 assert.equal(graphs.at(-1)?.memories.length,202)
 handlers.onFilter({range:'全部时间',tone:'reasoning',type:'推理'})
 assert.equal(graphs.at(-1)?.memories.length,0)
})
