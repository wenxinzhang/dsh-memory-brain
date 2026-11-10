# 模型调用闭环接入（本地修复版，待真实 DSH 联调）

## 真实宿主接缝

已只读核实本机已安装 DSH 的 `@deepseek-ai/dsh-llm/lib/index.js`、`dsh-agent-loop/lib/index.js`、`dsh-tools/lib/index.js`，未修改安装依赖。

核对了 D 盘桌面版 0.2.2-rc.1 与 AppData 旧版：桌面 Session 使用 `eventAt(seq)` 和 `{op:'replace',startSeq,endSeq}`；旧版使用 `events` 和 `{op:'replace',start,end}`。通过追加替换事件保持一个有效记忆块，关闭/忽略时退休旧块，保留历史。

`agent/pre-step` 的 `modelSelection` 为 `{provider,model,reasoningEffort?}`。用公共 `ctx.llm.resolveModelInfo(provider,model,signal)` 读取 `context.contextWindow`，避免使用首次空窗口或切换前的旧窗口；`llm/stream` 前用 `session.requestContext()?.contextWindow`（宿主当前路由窗口）复核完整请求预算，两者都没有且未配置 `contextWindow` 时不拦截，交给宿主压缩。token 估算沿用宿主同款密度启发式（4 字符/token，块/角色各 4 token 开销），中文按 1 token/字 计价以抵消宿主启发式对 CJK 的低估；声明注入的 `ctx.tokenMeter` 可用时对单条消息取 `estimateMessage` 与本地估算的较大值。

预览模式首次返回 `reject/memory_preview_required`，保存文本和绑定问题、范围的指纹；用户确认后需回聊天重发原问题，确认只使用一次，内容变化重新预览。当前没有自动恢复已拒绝问题的机制。

工具门禁区分业务权限与宿主审批：缺权限规则直接 deny；具备权限但待批准返回 ask，交给宿主真实审批。`next()` 的 policy allow 不会被伪造为用户授权；HTTP body 的授权勾选不具执行效力。

- `llm/stream(options,next)`：返回 AsyncIterable；必须延迟到迭代时执行异步加载，不能返回 Promise 替代流。实际 options 包含 provider/model/messages/system/tools/sessionId/signal。
- `agent/request({turn,step,signal,agent},next)`：请求配置 waterfall。Agent Loop 调用点仅传 turn/step/signal，但 dsh-agent 的 agentEvents 分派器将 agent 融合进 payload，因此应沿融合层读取 agent.session。turn 与 invocation 不可混同。
- `agent/pre-step({messages,turn,step,signal,agent},next)`：模型请求构建前的持久化入口。`next()` 返回 enter/reject 与待提交 messages；返回修改后的 decision，宿主随后写入 user/message 并 deriveMessages。
- 重要：Cordis 的 waterfall `next()` 不接收替换参数；`next(newOptions)` 不能替换冻结的 LLM 请求。必须在请求构建前注入，并保持 session 的 durable derivation 与实际请求一致。
- `tools/pre-execute(exec,next)`：最终工具参数为 exec.arguments，工具名 exec.name，标识 exec.callId，关联会话 exec.agent?.session。返回 `{kind:'allow'|'ask'|'deny'}`，由宿主执行器落实。
- `tools/post-execute(exec,result,next)`：执行结果策略返回 accept/block，不可将校验成功记录为工具执行成功。
- `session/event(session,event)`：用户消息及会话事件，不能把任意用户文本直接当作已确认事实。

## 数据与编译

### 会话归属自动识别

用户无需填写 ID。模型调用前读取可信 `agent.session.header.cwd`：先精确匹配已有项目路径，再匹配同名项目标识，没有对应记录时以工作区完整路径隔离；无工作区时只使用通用范围。已有项目范围记录的 scope_id 也参与匹配。

任务 ID 默认沿用会话 ID，任务说明取本轮原始用户问题，多步工具继续沿用本轮目标。对象只从选定项目（未绑定时为公共范围）中的有效对象识别，问题同时提及多个对象时不自动指定唯一对象；不会扫描其他项目猜测归属。

自动值及来源保存到同一 SQLite scope。此前明确手动绑定保留；页面默认只显示当前项目、任务与关联对象，参数调整收进折叠的高级设置，可恢复自动识别。识别发生在下次提问前，不需要点击保存。静态 payload 与宿主工作区名称不同且无法确定关联时不会自动合并项目。

### 用户可见的调用结果

最近一次真实 sent 快照默认直接展示事实、偏好、规则、业务对象等内容及证据引文。新调用的来源标题和 source/message ID 来自真实数据库关联；旧调用缺少标题时显示原始对话，不补造历史来源。原始 JSON 与较早调用默认折叠。没有匹配结果明确显示空结果，接口读取失败显示错误，不冒充零条记忆。完整图谱入口复用现有脑内星河视图，不创建第二套图谱数据。

`lib/context-compiler.js` 只使用 loop runtime 的上下文 sections，不重写检索/规则逻辑。默认排除 suggestions；硬 constraints、must/must_not 规则先预算，超预算明确报错。其余 facts/objects/preferences/methods/todos 在剩余预算中确定性选取。记忆原文作为 JSON 引用数据，不提升到 system；宿主系统规则、权限机制始终优先。本轮用户要求可覆盖长期偏好。

无真实 tokenizer 时采用与宿主一致的密度启发式：`countTokens` 按 4 字符/token 计价，CJK 字符按 1 token/字 计价（宿主启发式按 4 字符/token 会把中文低估约 3 倍），块/角色开销与宿主常量一致，`counting_method` 记为 `heuristic_tokens`。输入预算需包含 system、messages、tools 与回答预留，不能仅按 memory 文本算；但 `maxTokens` 是输出上限而不是本请求必须预留的量，预留最多取窗口的 1/4，避免某份 profile 把整个窗口都声明成输出后每次请求都被误拦。窗口已知时仅当 `请求 + 预留 + 256 > 窗口` 才抛 `request_exceeds_model_budget` 阻止派发；窗口未知时只告警一次并放行，由宿主压缩负责真实压力。

## 调用账本迁移

`lib/execution-store.js` 在同一 SQLite 上以独立版本表 `loop_execution_migrations` 事务迁移，不改写已有 loop_schema_migrations 历史：

- v1：loop_conversation_scopes、loop_model_invocations、loop_tool_executions、loop_invocation_feedback 及查询索引。
- 旧业务表和数据不清空。拒绝未来不支持的 execution schema。
- conversation_id、turn_id、invocation_id、context_run_id、tool_call_id、attempt 分开存储。
- scope 持久化 mode/project_id/task_id/object_id；owner 固定本地可信范围，不是多租户身份认证。
- sent 保存实际编译文本、版本清单、指纹、token估算、context_run_id；不意味着模型遵守。
- finish 终态幂等，不因取消回调重写已完成记录；工具结果单独存储；不按每token写数据库。
- 独立 usage chunk 保留；finish error/aborted 按失败/取消记录；reasoning chunk 不作为答案。延迟请求不关联另一轮准备的上下文；同会话高并发仍需真实宿主压力验证。
- 字段名含 API key、authorization、password、secret、access/refresh token 会脱敏，常见 Bearer 与 sk- 格式也会脱敏；不应主动将密钥作为记忆内容。该过滤不保证识别任意自然语言中的秘密。

## 聊天结束后的自动抽取

默认启用 `loopAutoExtract`。实际 `session/event` 的 `turn/start` 记录起始 seq，`turn/end` 仅在 `reason.kind==='completed'` 时捕获新轮次。按固定 seq 边界读取真正的用户文字和非中断助手文字；不包含插件注入记忆、工具输出、system/developer 或 reasoning。项目/任务归属按本轮首次加载时固定，避免运行中手工修改把原文归入下一项目。

`captureChatTurn` 在同一事务保存 `dsh-auto` 来源、原始角色和消息 ID，并提交现有 extract 队列。来源标识按 session ID 与轮次起始 seq 稳定去重，完成或重启后重复事件不重复调用模型。后台使用任务中保存的 provider/model，经已声明注入的 `llm.prepareCall` 调用；使用独立超时，不传 sessionId、tools 或旧轮次 signal，避免递归形成聊天。模型服务尚未加载时保留排队，不消耗重试次数；无法确认原模型时只保存文字，不自动切到 REST 端点。

助手推断与模糊确认继续走既有候选治理，规则默认候选。寒暄或没有值得长期保存的信息允许空结果。来源归档会取消排队/运行任务，迟到结果在事务内重查归档与内容版本，不能复活已撤回记忆。失败及部分失败持久保留，支持任务/批次手动重试；重试保留原模型通道，不承诺分块失败自动重试三次。

页面显示最近整理的排队、运行、完成数量或失败状态，并提供重试。高级设置可关闭本会话自动整理；off 和仅本轮忽略也跳过该轮捕获。关闭只影响后续新轮次，已排队任务可在闭环任务区取消。此功能不回扫历史、不会修改模型权重；抽取会额外把本轮可见文字发送给该轮已选择的模型服务。

隔离验证使用真实本机 Cordis 与 Session、合成模型返回，输出 `REAL_CORDIS_SESSION_AUTO_EXTRACTION_PASS`（1 来源、2 消息、1 记忆、任务 done）。这不代表真实提供方和当前 GUI 的端到端调用已经验收。

## 验证边界

Node 合成模型/执行器契约测试只能证明测试请求链，不能替代当前 GUI 的真实 DSH 验证。真实宿主验收还需插件被当前进程加载、模型提供方可用、请求重建 invariant、流结束及真实工具门禁均通过。未完成的真实验证应明确报告，不可用 mock 测试宣称已上线。
