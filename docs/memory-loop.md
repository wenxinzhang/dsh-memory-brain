# 记忆闭环（SQLite schema v4）

叠加在现有「星河大脑」页面上的完整闭环，复用 DSH 插件、深色三栏界面、本地模型和 SQLite，不引入图数据库或向量库。

```
原始对话（证据）→ 原子记忆 → 动态本体映射 → 规则候选 → 确认/生效
      → 上下文组装（适用记忆 + 硬约束）→ 执行反馈 → 版本化更新
```

## 入口

顶栏 **「闭环」** 打开五类工作区（抽屉）：

1. **对话导入**：文件/粘贴导入、预览与角色修正、归属设置、批次进度、失败重试、附件元数据「内容未解析」、来源详情与归档。
2. **记忆**：按类型/来源/范围/状态筛选，原文证据对照，确认、废弃、纠正、编辑、合并、版本历史。
3. **本体**：定义（对象/属性/关系/状态）与实例分离；实例属性、关系、状态转换；结构变更候选发布/拒绝。
4. **规则中心**：候选/生效/冲突/待整理视图；条件编辑、证据、版本比较、替代；用测试上下文模拟评估（只读，不触发业务动作）。
5. **上下文/反馈**：按用户/项目/任务/业务对象组装；必须遵守、事实、偏好、建议、未知/冲突、引用与过滤统计；分类反馈。
6. **图谱**：真实记忆/本体/规则节点和边；可把闭环图投射到中央 3D 大脑（`window.__MB_SET_GRAPH__`）。

## 存储与迁移

- 默认数据库：`web/data/loop.db`（SQLite，WAL），可用 `loopDb` 覆盖。
- 迁移表：`loop_schema_migrations`，当前版本 **4**；启动按顺序升级，不删旧数据。模型调用账本另用 `loop_execution_migrations`（v1）。升级前应使用 SQLite 一致性备份，不能只复制运行中的主 DB 文件。
- v1 → v2 新增：来源附件/角色修正/归档时间，记忆 `protected`/`extraction_run_id`/`parent_memory_id`，规则结构错误/反馈关联，批次详情/来源哈希/代次，记忆版本、本体属性历史、抽取分块运行、Skill 候选表。
- 不修改 `xiaojiu_brain` 服务数据库。

## 导入

- JSON：消息数组、`{messages}`、`{conversation:{messages}}`、ChatGPT `mapping`；文本：Markdown/TXT 角色标记。
- 文件校验：仅 `.json/.md/.markdown/.txt`，≤20MB，拒绝 NUL 字节；角色未知时保留 `unknown` 并在预览中人工修正。
- 重复文件按 `owner + source_kind + file_name + content_hash` 去重；同一外部会话增量导入按消息前缀追加，不重复。
- 相同内容在不同位置保留为不同证据；原文与拆解结果分表存储，原文不会被覆盖。
- 某条消息失败不阻断批次；拆解按分块记录进度，可只重试失败分块。
- 附件只保存元数据和关联，明确显示「内容未解析」，不假装理解附件。

## 原子记忆

- 类型：fact / preference / constraint / decision / event / todo / method。
- 一条记录一个主命题；保留主语、谓词、对象、否定、单位、条件与范围。
- 模型建议默认 `proposed/suggested`，只进入上下文的「建议」区；用户陈述默认 `confirmed/stated`。
- 「可以/继续」只在唯一可定位对象时确认，否则 `needs_confirmation`。
- 相同内容重复导入只追加证据，不虚增可信度；人工确认/编辑/纠正置 `protected=1`。
- 重新拆解不会覆盖 protected 记忆：只生成冲突候选并计入 `skipped_protected`。
- 冲突显式记录 `conflict`，不静默覆盖；纠正创建新版本（`supersedes_id` 指向旧记录），旧记录保留并退出当前视图。
- 删除/归档来源时，失去唯一证据的记忆归档、规则暂停，并返回受影响数量。

## 动态本体

- 种子类型：项目、任务、文档、模型、设备、油井、人物、记忆；属性带数据类型/单位/枚举/必填。
- 实例只在同 owner + project 内匹配；同名不自动合并。
- 属性写入校验类型、枚举和单位；可换算单位自动转换（kg/d↔t/d、m↔km、kPa↔MPa），不可换算返回 `unit_conflict`。
- 关系校验定义与两端类型（`relation_endpoint_mismatch`）；状态转换校验状态机（`illegal_transition`）。
- 结构变更（新类型/属性/关系）默认候选，人工发布后才修改正式本体；发布记录应用结果。
- 旧状态、旧本体版本不会自动当作当前状态。

## 规则模型与优先级

- 类别：业务约束、个人偏好、工作流、数据校验、状态转换、动作权限/前置条件；强度 must / must_not / prefer / suggest。
- 条件为受限 JSON AST（eq/ne/gt/gte/lt/lte/in/exists/and/or/not），不使用 eval/SQL/脚本；属性路径必须在正式本体定义中。
- 无法结构化的规则保存为 `needs_structure`/`unstructured`，不能自动执行。
- 权威性顺序：当前明确指令 > 当前任务/产物 > 项目 > 领域 > 个人长期偏好 > 模型推断。来源身份由应用元数据决定，导入文本不能自称高优先级。
- 冲突检测：同范围、共享条件对象、相反强度或冲突动作 → 保留双方并给出裁决/未裁决说明，不静默删除。
- 版本：人工编辑写 `loop_rule_versions`；替代先生成候选，审核生效后事务切换旧规则；过期规则不参与当前上下文。冲突裁决绑定双方版本，修改规则后需重新裁决；旧裁决保留历史。
- 模拟评估返回 `applicable / not_applicable / unknown` 与逐条件原因，只读。

## 上下文与反馈

- 过滤顺序：owner 隔离 → 用户/项目/任务/对象范围 → 有效期与状态 → 敏感过滤 → 关键词/证据/范围/本体关联检索重排 → 规则评估与优先级排序。
- 检索是确定性的（不声称向量语义）：硬约束始终保留；`sections.retrieval` 给出关键词、候选数、选中数、是否截断、前 12 条分数与命中词；语义检索仍由现有服务负责。
- 缺少关键状态/属性返回 `unknown`，不按满足处理。
- 硬约束超出 `loopContextChars`（或请求 budget）返回 409 `hard_constraints_exceed_budget`，不静默截断。
- 输出分区：任务背景、当前指令、事实、约束、偏好、建议候选、待办、方法、业务对象及状态、规则、冲突、未知、引用、过滤统计、`why`。
- 动作权限单独校验：`POST /actions/check` 区分 `blocked / pending_authorization / denied / authorized_not_executed`；`must_not` 不能被授权绕过；没有权限规则时拒绝；本机未连接执行器，永远不执行外部动作。上下文 `sections.actions` 会标明 `blocked / requires_authorization`。
- 反馈类别：rule_content / rule_scope / state / not_executed / tool_failure。
  - 规则内容/范围错误：生成候选规则版本（默认不生效）；
  - 状态错误 + 纠正文本：生成纠正记忆；
  - 未执行/工具失败：只记录，不自动降低规则有效性。
- `loop_runs` 保存使用时的上下文快照与评估；`loop_feedback`、`loop_audit` 可追溯。

## Skill 候选

- 同一 owner/范围下至少 2 条已确认 `method` 记忆可生成候选。
- 字段：场景、输入、前置条件、步骤、异常/回退、边界、验收标准、输出格式、证据、版本。
- 支持预览、人工编辑、导出 Markdown、忽略；第一阶段不自动安装或执行。
- 单条偏好/事实/未确认建议不会被包装成 Skill。

## 模型配置

- 复用 `rulesEndpoint` / `rulesModel` / `rulesApiKeyEnv` / `loopTimeoutMs`。
- 抽取请求使用 `PROMPT_VERSION=extract-v2`、schema v2；记录模型、分块哈希、处理批次。
- 模型不可用时导入只保存原文，`extraction_status=error`，不伪造提取结果；重试即可。
- 本地验收使用显式 mock 模型（测试文件内），演示数据标题带「演示」且 `platform=demo`。

## 单用户边界

当前没有多用户权限系统。所有接口按 `owner` 过滤（默认 `local-user`），用于隔离测试数据；不宣称多租户安全。无权限/跨 owner 数据不进入搜索、图谱或上下文。

## 测试与验收

```bash
npm test                                              # 当前自动化测试（含合成模型）
node tools/loop-dev-server.mjs --port 18912             # 独立 host，不动正在运行的 DSH
node tools/loop-e2e.mjs http://127.0.0.1:18912/ /tmp/loop-shots   # 53 项浏览器 E2E
node tools/loop-e2e-manage.mjs http://127.0.0.1:18912/ /tmp/loop-manage  # 39 项管理动作
```

验收明细与真实模型结果见 [verification-v3.md](verification-v3.md)。

浏览器验收：

```bash
cp web/data/loop.db web/data/loop-verify.db   # 可选，避免污染演示库
node tools/loop-dev-server.mjs --port 18912 --db web/data/loop-verify.db
# 打开 http://127.0.0.1:18912/ ，点顶栏「闭环」
```

## 持久任务队列

- `loop_jobs`：类型、来源、状态、进度、尝试次数、租约、幂等键、错误；`queued/running/done/partial/failed/cancelled`。
- host 启动时启动 worker，并把 `running` 且租约过期的任务重新入队；worker 以条件 UPDATE 抢占租约，避免重复执行。
- `/import`、`/import/:id/extract` 入队后立即返回；前端轮询 `/jobs`，支持 `/jobs/:id/retry` 与 `/cancel`。
- 模型调用在事务外，每个分块结果事务写入；分块失败保留明细，不阻断其他分块；重跑按 chunk_key 幂等。
- 记忆新增/编辑/纠正/合并/拆解后自动入队 embed 任务。

## 本体结构版本与回滚

- 每次结构发布生成 `loop_ontology_versions` 快照 + diff + change log。
- `GET /ontology/versions`、`GET /ontology/versions/:id/diff`、`POST /ontology/versions/:id/rollback`。
- 回滚前评估受影响实例/记忆/规则；未确认时 409 返回影响；确认后事务恢复并追加 rollback 版本。
- 受影响实例标记 orphaned、引用失效结构的规则暂停；数据不删除；旧版本不参与当前调用。

## 规则冲突人工裁决

- `POST /rules/conflicts/:key/resolve`：`prefer_a/prefer_b/keep_both/disable_both` + note。
- 上下文按裁决结果过滤；未裁决冲突继续保留并明确显示；规则与版本不删除。

## 向量召回

- 配置 `loopEmbedEndpoint/loopEmbedModel/loopEmbedApiKeyEnv`；未配置时显式降级词法。
- `loop_embeddings` + embed 批次任务（≤8/批，顺序，失败重试）。
- 上下文先过滤，再词法召回，可选向量召回，合并/去重/重排/预算；硬约束确定性加载。
- `sections.retrieval.vector` 明确 configured/used/error；不伪造向量结果。

## 动作权限边界

- 本机没有外部执行器：动作校验即使 `authorized_not_executed` 也不会调用任何工具或业务系统。
- 动作必须命中适用 permission 规则，并由 DSH 本次工具审批落实授权。HTTP 请求中的 `authorized:true` 不受信任；policy allow 也不等于用户批准。独立动作检查接口不执行外部动作。
- 禁止动作（must_not / block / deny / forbid）不能被授权绕过。

## 当前边界（明确未做）

- 导入/抽取/向量化通过 SQLite 持久队列处理；租约心跳与提交时所有权检查阻止迟到 worker 发布。取消不能撤回已发送给模型的请求。
- 向量召回需要显式配置端点；未配置或失败时显式降级词法。
- 附件只存元数据，不解析内容。
- 结构候选发布只支持 type/property/relation；复杂迁移需人工。
- 反馈不会自动训练或自动发布模型；不会把沉默当认可。
