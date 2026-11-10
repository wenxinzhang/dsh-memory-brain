# 记忆闭环 API v3 契约（前后端共同遵守）

> 接口契约版本 v3；数据库迁移版本 **v4**（v3 已用于动作权限/检索，v4 新增持久任务、本体版本、冲突裁决、embedding）。

基址：`<prefix>/api/loop`（默认 `/memory-brain/api/loop`）。
成功统一 `{ ok: true, ... }`；失败统一 HTTP 400/404/409/503 + `{ ok: false, error, ...detail }`。
单用户运行边界：所有列表接口都接受 `owner`（默认 `local-user`），跨 owner 数据不返回。
写入接口都会写 `loop_audit`；敏感文本不得出现在审计 detail 中。

## 概览 / 批次

- `GET /overview`
  `{ ok, counts:{sources,messages,memories,rules,active_rules,instances,proposals,runs,skills,conflicts}, by_memory_status, by_memory_type, model:{endpoint,model,configured}, boundary:{singleUser:true}, versions:{schema,prompt} }`
- `GET /batches?source_id=&limit=`
  `{ ok, items:[{ id, source_id, kind:'import'|'extract', status:'queued'|'running'|'partial'|'done'|'failed', total, done, failed, progress:0..1, error, created_at, updated_at }] }`
- `GET /batches/:id` → `{ ok, batch, chunks:[{ index, status, error, memories, rules }] }`
- `POST /batches/:id/retry` → 只重跑 failed/queued 分块；`{ ok, batch }`

## 导入

- `POST /preview {text, format}` → `{ ok, format, warnings, messages:[{index,role,content,originalTime,warnings}], hash, encoding, size }`
- `POST /import` body:
  `{ text, format?, filename?, owner?, project?, task?, platform?, externalConversationId?, title?, autoExtract?,
     roleOverrides?: { "1": "user", "2": "assistant", "3": "system", "4": "tool" },
     attachments?: [{ name, size, type }], mimeType?, sizeBytes? }`
  → `{ ok, duplicate, appended, source, batch_id, warnings, attachment_count }`
  - 文件扩展名仅 `.json/.md/.markdown/.txt`；>20MB 或含 NUL 拒绝。
  - `source.attachments=[{name,size,type,parsed:false}]`，UI 显示“内容未解析”。
- `GET /imports?owner=&status=&limit=` → `{ ok, items:[source + messages + attachments + batches + derived:{memories,rules}] }`
- `GET /imports/:id` → `{ ok, source, messages:[{id,role,ordinal,content,original_time,warnings,attachments}], batches, derived }`
- `POST /imports/:id/archive` → 归档来源；失去唯一证据的记忆/规则退出当前调用。
  `{ ok, archived:{ sources, memories, rules }, note }`
- `POST /import/:id/extract { force?:boolean }` → 同步执行但逐块写进度；`{ ok, batch_id, status, chunks, memories_added, memories_duplicate, conflicts, rules_added, proposals, skipped_protected, failed_chunks, model }`
  - 同一 source + 内容哈希 + prompt 版本重复调用是幂等的；`force` 生成新批次，但人工保护记忆不被覆盖。

## 原子记忆

- `GET /memories?owner=&type=&status=&scope_type=&source_id=&q=&sensitive=&limit=`
  item 至少含 `protected, version, sensitive, ontology, evidence[]`。
- `GET /memories/:id` → `{ ok, memory, versions, evidence:[{quote,message,source}] }`
- `GET /memories/:id/versions` → `{ ok, items:[{version,text,object_value,status,note,created_at}] }`
- `PATCH /memories/:id { text?, type?, subject?, predicate?, object_value?, scope_type?, scope_id?, note? }`
  → 人工编辑：version+1、`protected=1`、`confirmation=confirmed`、写版本与审计。
- `POST /memories/:id/correct { action:'confirm'|'archive'|'supersede', text? }`（保持一致；supersede 新记录 `protected=1`）
- `POST /memories/:id/merge { ids:[...], text? }` → `{ ok, memory, merged_ids }`

## 动态本体

- `GET /ontology` → `{ ok, types:[{...,props,states,relationsFrom}], relations, instances:[{...,properties,relations,state_history,current_state}], proposals }`
- `GET /ontology/instances/:id` → `{ ok, instance, properties, relations, state_history }`
- `POST /ontology/instances/:id/props { prop_id?|name?, value, unit? }`
  类型/枚举/单位校验；可转换单位自动转换并返回 `converted`，不可转换 409 `{error:'unit_conflict',expected,got}`；
  类型不符 409 `{error:'type_mismatch'}`。
- `POST /ontology/instances/:id/relations { relation_id?|name?, to_instance_id?|to_name? }`
  端点类型不符 409 `{error:'relation_endpoint_mismatch'}`。
- `POST /ontology/instances/:id/state { state, reason? }` → 非法转换 409 `{error:'illegal_transition',from,to}`。
- `POST /ontology/proposals/:id/approve` → `{ ok, applied:{kind,id}|error }`；`POST /ontology/proposals/:id/reject`。

## 规则

- `GET /rules?owner=&status=&view=all|conflicts|unstructured`
  item 增加 `authority, authority_rank, authority_label, conflicts:[], versions_count, expired`。
- `GET /rules/:id` → `{ ok, rule, versions, conflicts, evidence_messages }`
- `GET /rules/:id/versions` → `{ ok, items }`
- `POST /rules/:id/approve`（结构必须合法）`| pause | resume | archive`
- `PATCH /rules/:id { name?, description?, category?, scope_type?, scope_id?, strength?, conditions?, actions?, exceptions?, acceptance?, valid_from?, valid_to?, structure_status?, note? }`
  人工编辑：写 `loop_rule_versions`，version+1，confirmation=`human_edited`。
- `POST /rules/:id/supersede { ...覆盖字段, note?, activate? }`
  新规则 `supersedes_id=旧 id`；旧规则 `governance_status='superseded'`；新规则默认 candidate。
- `POST /rules/:id/simulate {context}`（现有）
- `GET /rules/conflicts` → `{ ok, items:[{ key, a, b, reason, resolution:'prefer_a'|'prefer_b'|'unresolved', precedence }] }`

## 上下文 / 反馈

- `POST /context` body：
  `{ owner?, project?, task?, object?:{id?,name?,type?}, state?, instruction?, query?, retrieval_limit?, include_sensitive?, budget? }`
  → `{ ok, run_id, sections:{ task_background, instruction, facts, constraints, preferences, suggestions, todos, objects, rules, conflicts, unknowns, citations, filtered }, evaluations, precedence, usage, budget }`
  - `query` 用于确定性关键词/证据/范围/本体关联重排；硬约束始终保留；`sections.retrieval` 返回候选数/选中数/是否截断/前 12 条分数与命中词。
  - `sections.actions` 列出适用规则动作及 `blocked` / `requires_authorization`；规则生效不等于执行授权。
  - `facts` 只含已确认记忆；`suggestions` 单独放未确认模型建议；敏感内容默认不进上下文。
  - 规则按优先级：当前明确指令 > 当前任务/产物 > 项目 > 领域 > 个人长期偏好 > 模型推断；每条带 `why`。
  - 硬约束超预算返回 409 `{ ok:false, error:'hard_constraints_exceed_budget', hard_chars, budget }`。
- `POST /feedback` body：
  `{ run_id?, outcome:'useful'|'problem'|'incorrect'|'not_executed'|'tool_failure',
     category?:'rule_content'|'rule_scope'|'state'|'not_executed'|'tool_failure',
     feedback?, rule_id?, memory_id?, correction?:{ text?, fields? } }`
  → `{ ok, id, applied?:{ kind, id } }`
  - rule_content/rule_scope：生成候选规则版本（默认不生效）；state + correction.text：生成纠正记忆；
    not_executed/tool_failure：只记录，不削弱规则。
- `GET /feedback?limit=` / `GET /runs?owner=` / `GET /audit?limit=`

## 动作权限（v3）

- `POST /actions/check` body：
  `{ owner?, project?, task?, object?, state?, query?, action?:{type?,target?}, authorized?:boolean, authorization_note? }`
  → `{ ok, check_id, result:'blocked'|'pending_authorization'|'denied'|'authorized_not_executed'|'no_applicable_action', authorized, executed:false, context_run_id, items:[{rule_id,rule_name,strength,action,result,authorization,reason,permission_rule_id}] }`
  - `must_not` 或 block/deny/forbid 动作 → `blocked`，明确授权也不能绕过；
  - 执行类动作未传 `authorized:true` → `pending_authorization`；
  - 已明确授权但没有适用 `category=permission` 且包含 allow/grant 动作的规则 → `denied`；
  - 授权 + 权限规则均满足 → `authorized_not_executed`；本机没有外部执行器，永远不执行。
  - 每次校验写 `loop_action_checks` 与审计，`detail.executed=false`。
- `GET /actions?owner=&limit=` → 历史校验记录（只记录，不执行）。
- 规则生效、业务记忆、导入文本都不能替代系统/工具授权。

## Skill 候选

- `GET /skills?owner=&status=` → `{ ok, items }`
- `POST /skills/derive { owner?, project?, min_memories? }` → 从 method 记忆生成候选；`{ ok, items, derived }`
- `PATCH /skills/:id { name?,scenario?,inputs?,preconditions?,steps?,exceptions?,boundaries?,acceptance?,output_format? }`
- `POST /skills/:id/export` → `{ ok, markdown, filename }`
- `POST /skills/:id/reject`
  item：`{ id,name,scenario,inputs[],preconditions[],steps[{order,text,memory_id}],exceptions[],boundaries[],acceptance,output_format,evidence[],status,source,version,created_at,updated_at }`

## 图 / 搜索 / 隔离

- `GET /graph?owner=&project=&limit=` → `{ ok, nodes:[{id,name,type:'memory'|'object'|'rule',subtype,degree,meta}], edges:[{src,dst,kind,label,weight}], counts }`
  边必须来自真实数据（记忆→本体实例、规则→证据记忆、记忆→来源、冲突/替代关系）。
- `GET /search?q=&owner=&limit=` → `{ ok, items:[{id,kind:'memory'|'rule'|'object',title,snippet,score}], total }`
- 所有列表接口支持 `owner` 隔离；无 owner 默认 `local-user`；跨 owner 不可见。

## 中央大脑投射

`app.js` 暴露 `window.__MB_SET_GRAPH__('loop'|'base')`：`loop` 时拉取 `/graph` 并转成 3D 图数据；
`base` 恢复原始 payload graph。UI 在“图谱”视图提供“投射到中央大脑”开关。


## 持久任务队列（v4）

- `GET /jobs?owner=&status=&type=&source_id=&limit=`
  → `{ ok, items:[job], counts:[{status,n}], worker:{enabled,id,intervalMs} }`
  job：`{ id, owner, type:'extract'|'embed', source_id, status:'queued'|'running'|'done'|'partial'|'failed'|'cancelled', progress_done, progress_total, attempts, max_attempts, lease_owner, lease_until, lease_expired, cancel_requested, idempotency_key, payload, result, error, created_at, started_at, finished_at }`
- `GET /jobs/:id` → `{ ok, job, batches }`
- `POST /jobs/:id/retry` → 仅 failed/partial/cancelled 可重试，重置 attempts 并重新入队。
- `POST /jobs/:id/cancel` → queued 立即 cancelled；running 置 `cancel_requested=1`，当前分块结束后停止。
- `POST /import` 与 `POST /import/:id/extract` 入队后立即返回：
  - import → `{ source, job, job_id, queued, status:'queued', extracted:null }`
  - extract → `{ job, job_id, status:'queued', duplicate_job, batch_id:null }`
- 幂等键：`extract:{source_id}:{content_hash}:{promptVersion}:{normal|force:ts}`；分块级 `loop_extraction_runs(chunk_key)` 仍保证重跑不重复生成。
- 租约：worker 启动时把 `running` 且 `lease_until` 过期任务重新入队；单实例 `UPDATE ... WHERE status='queued'` 抢占；长任务按分块续租。
- 模型调用在事务外；每个分块结果事务写入；分块失败保留明细，其他分块继续。

## 本体结构版本 / 回滚（v4）

- `GET /ontology` 额外返回 `current_version`、`versions_count`。
- `GET /ontology/versions` → 版本列表（含差异计数、是否当前）。
- `GET /ontology/versions/:id/diff` → `{ version, diff:{added,removed,changed}, snapshot, change_log }`。
- `POST /ontology/versions/:id/rollback` body `{ note?, confirm_impact? }`
  - 先评估影响；若有影响且未 `confirm_impact:true` → 409 `{error:'rollback_has_impact', impact}`
  - 确认后事务恢复快照；受影响实例标记 `orphaned`，引用失效结构的规则 `paused`；不删除记忆/实例/规则
  - 回滚追加新版本 `action='rollback'`，写 change log + 审计
- `POST /ontology/proposals/:id/approve` 现在：校验 → 事务应用 → 结构校验 → 保存版本快照 + 差异 + change log；校验失败返回 400 且不产生版本。
- 旧版本只用于差异/回滚，不参与当前调用；当前调用始终使用最新版本定义。

## 规则冲突人工裁决（v4）

- `GET /rules/conflicts` item 增加 `adjudicated`、`manual:{resolution,note,actor,created_at}`、`unresolved`、`auto_resolution`。
- `POST /rules/conflicts/:key/resolve` body `{ resolution:'prefer_a'|'prefer_b'|'keep_both'|'disable_both', note?, owner? }`
  - `prefer_a/prefer_b`：上下文中被淘汰一方不执行；
  - `keep_both`：双方保留并在上下文中标记已裁决；
  - `disable_both`：双方退出当前上下文；
  - 裁决不删除规则/版本；每次裁决写 `loop_rule_conflict_resolutions` + 审计；未裁决冲突继续保留。
- 上下文 `sections.conflicts.rules` 返回人工裁决/未裁决状态；`filtered.adjudicated_excluded` 统计被裁决排除规则数。

## 向量检索（v4）

配置（host Config）：

```yaml
loopEmbedEndpoint: http://127.0.0.1:8781/v1/embeddings
loopEmbedModel: bge-m3
loopEmbedApiKeyEnv: ""
loopEmbedEnabled: true
```

- `GET /embeddings/status?probe=1` → `{configured, endpoint, model, counts:{memories,embedded,stale,missing,pending_jobs}, available, note, probe}`
- `POST /embeddings/reindex` body `{owner?}` → 入队 embed 任务；未配置返回 409 `embed_unconfigured`
- `GET /overview` 增加 `vector` 与 `jobs` 摘要。
- `loop_embeddings(memory_id, model, dimension, vector_json, content_hash)`；记忆新增/编辑/纠正/合并/拆解后自动入队 embed 任务；批次 ≤8、顺序执行（并发限制），失败可重试。
- 上下文检索：owner/项目/任务/时间/状态过滤 → 词法召回 → 可选向量召回（query embedding）→ 合并去重重排 → 预算。硬约束（must/must_not/constraint）始终确定性保留。
- `sections.retrieval.vector = {configured, used, model, dimension, query_embedded, matched, error}`；未配置/不可用/冷却时显式降级，不伪造向量。
- embedding 调用只发送记忆文本与 query，不默认外传完整历史；端点必须显式配置。

## 规则审核三档模式（v5）

`loop_runtime_settings` 持久化 `rule_review_mode`；页面切换优先于 host 配置
`loopRuleReviewMode`（默认 `semi`）。

| 模式 | 行为 |
|---|---|
| `auto` 全自动 | AI 提炼的规则只要**结构校验无错误**就自动生效（`governance_status='active'`，`confirmation='auto_approved'`，写入规则版本与审计 `rule.auto_approved`）；条件有错误的仍保留候选 |
| `semi` 半自动（默认） | 普通规则（偏好/工作流等，非硬性、非高影响范围）自动生效；**重要规则必须人工**：分类为业务约束/权限/数据校验/状态迁移，或强度 must/must_not，或范围 artifact/domain |
| `manual` 手动 | AI 只产出候选，全部由用户在规则中心确认后生效 |

- 无条件规则视为“始终适用”，属于结构合法；条件含未定义本体路径等错误则任何模式都不自动生效。
- 自动生效同样进入既有治理：可暂停/归档/版本/冲突裁决；审计记录 `review_mode` 与 `review_reasons`。
- 对**之后**的提炼生效，不追溯改变已有候选/生效规则。

接口：

- `GET /rules/review-mode` → `{ ok, mode, name, description, modes:[{id,name,description}] }`
- `POST /rules/review-mode` body `{ mode:'auto'|'semi'|'manual' }` → `{ ok, mode, previous, name, description }`；非法值 400；审计 `rule.review_mode`
- 拆解批次 chunk 计数新增 `rules_auto_approved`。
- `simulateRule`：无条件规则现在返回 `applicable`（无条件，始终适用）；此前无条件规则即使生效也永远不会进入上下文。
