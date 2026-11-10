import { toneOfKind } from './util.js'

export function selectMemoryWindow(data, {range='全部时间',tone='all',limit=200} = {}, now=Date.now()) {
  const merged=new Map()
  for (const row of [...(data.memories || []),...(data.graph?.memories || [])]) merged.set(String(row.id),{...merged.get(String(row.id)),...row})
  const timestamp = row => {
    const value=row.created_at ?? row.event_time ?? row.date
    return typeof value === 'number' ? (Math.abs(value)<1e12?value*1000:value) : Date.parse(value)
  }
  const days=Number(String(range).match(/(\d+)天/)?.[1])
  const toneOf = row => row.tone || (['fact','reasoning','followup'].includes(row.kind)?row.kind:toneOfKind(row.kind || row.type))
  const rows=[...merged.values()].filter(row => (tone==='all' || toneOf(row)===tone)
    && (!days || (timestamp(row)>=now-days*86400000 && timestamp(row)<=now)))
    .sort((a,b)=>(timestamp(b)||0)-(timestamp(a)||0))
  const memories=rows.slice(0,Math.max(0,limit))
  return {total:rows.length,loaded:memories.length,graph:{...(data.graph || {}),memories}}
}
