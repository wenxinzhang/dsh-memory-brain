# 星河大脑 · 记忆闭环（Galaxy Brain）软件说明

> 一个运行在 DeepSeek Harness 内的本地优先记忆系统：把历史对话变成可追溯的原子记忆、
> 动态本体、可执行规则和可解释上下文，并用版本与反馈形成闭环。

## 1. 软件定位

普通聊天记录只能“翻找”，不能可靠复用。星河大脑把对话当作证据，把其中事实、偏好、
约束、决策、事件、待办和方法拆成原子记忆，再映射到动态本体和业务规则；在需要时按
用户/项目/任务/业务对象/当前状态组装上下文，并把执行结果和用户纠正回写成新版本。

它适合：

- 需要在多个项目/会话间保持长期一致偏好的个人用户；
- 需要把业务约束（如设备检修期间禁止操作）沉淀为规则的小团队；
- 希望本地保存对话、记忆和模型调用记录，不接受默认云端外传的用户；
- 想研究“记忆 → 本体 → 规则 → 上下文 → 反馈”闭环的开发者。

## 2. 核心概念

| 概念 | 作用 |
|---|---|
| 原始对话 | 不可变证据；导入后保留原文、角色、时间、来源、附件元数据 |
| 原子记忆 | 一条主要命题；带主语/谓词/对象、范围、来源、确认状态、时间、版本 |
| 动态本体 | 对象类型、属性、关系、状态机、事件、动作；定义与实例分离 |
| 规则 | 在特定条件下施加的约束/建议；带强度、适用条件、例外、验收标准、权威性和版本 |
| 上下文 | 权限/范围/时间/状态过滤后，加载适用记忆、硬约束、偏好、对象状态、冲突和引用 |
| 反馈 | 区分规则内容错误、范围错误、状态错误、未执行、工具失败；生成候选版本而非自动发布 |
| Skill 候选 | 多条方法记忆形成的可复用流程；可编辑/导出，不自动执行 |

## 3. 功能

- **对话导入**：JSON / Markdown / TXT / 粘贴；角色修正、归属、附件元数据、重复导入去重、增量追加、批次进度与失败重试。
- **持久后台队列**：导入/拆解/向量化任务写入 SQLite；host 启动恢复过期租约；任务可取消、重试；重启/关页面不丢任务。
- **原子记忆**：模型建议默认候选；用户陈述/确认/纠正生成受保护版本；冲突保留；证据链可回到原文。
- **动态本体**：属性类型/枚举/单位校验、关系端点校验、状态转换校验；结构变更候选、版本快照、差异、回滚。
- **规则中心**：受限 JSON 条件（不使用 eval/SQL）；优先级 当前指令 > 任务/产物 > 项目 > 领域 > 个人偏好 > 模型推断；冲突检测与人工裁决。
- **上下文**：确定性硬约束 + 关键词/证据/范围/本体关联重排；可选向量召回；预算控制；输出“为什么召回/为什么生效”。
- **动作权限**：规则生效不等于执行授权；blocked / pending_authorization / denied / authorized_not_executed；不自动执行外部动作。
- **反馈与演进**：生成候选规则版本/纠正记忆，不自动训练、不自动发布。
- **三维大脑**：复用现有 Three.js 皮层可视化，可把闭环真实图谱投射到中央大脑。
- **单用户边界**：owner 仅用于本地数据隔离，不宣称多租户安全。

## 4. 架构

```
DSH host（lib/index.js）
 ├─ webServer 前缀路由 /memory-brain，
 │   ├─ 静态页面 web/
 │   ├─ 只读数据 API /api/*
 │   └─ 闭环 API /api/loop/*
 ├─ lib/loop.js：SQLite（node:sqlite）+ 闭环运行时
 │   ├─ loop_sources / loop_messages / loop_memories / loop_memory_evidence
 │   ├─ loop_ontology_* / loop_rules / loop_rule_* 
 │   ├─ loop_jobs（租约 worker）
 │   ├─ loop_embeddings（可选向量）
 │   └─ loop_runs / loop_feedback / loop_audit
 └─ web/src：原生 ES Modules + Three.js 3D 大脑
```

- 不引入图数据库/向量数据库；对象、关系、版本、证据都在 SQLite。
- 模型调用使用 OpenAI 兼容端点（默认本机），未配置/不可用时明确降级。
- 迁移通过 `loop_schema_migrations`，当前 schema v4；旧库原地升级。

## 5. 安装

### 作为 DSH 插件（推荐）

```bash
git clone <repo> memory-brain
plugin_manager install_bundle target: ~/dsh-workspace/memory-brain
```

或用 npm 包安装（发布后）：

```bash
plugin_manager install_bundle target: @fuxing/dsh-brain@0.0.1
```

安装后在 DSH 任意会话打开「星河大脑」tab → 顶栏「闭环」。host 代码变更后需重启
DSH 或重载插件；纯静态页面刷新即可。

### 独立开发/验收

```bash
node tools/seed-sample.mjs --force       # 生成完全合成的开放样例
node tools/loop-dev-server.mjs --port 18912
# 打开 http://127.0.0.1:18912/
```

## 6. 配置

在 DSH profile 的 `cordis.patch.yml` 覆盖 `memory-brain` 行配置（整份替换）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `prefix` | `/memory-brain` | 页面/API 前缀 |
| `root` | 包内 `web/` | 页面根目录 |
| `payload` | `<root>/data/payload.json` → `demo.json` → `sample-payload.json` | 3D 大脑数据包 |
| `loopDb` | `<root>/data/loop.db` | 闭环 SQLite |
| `rulesEndpoint` / `rulesModel` | 本机 OpenAI 兼容端点 | 抽取模型 |
| `loopEmbedEndpoint` / `loopEmbedModel` / `loopEmbedApiKeyEnv` | `http://127.0.0.1:8781/v1/embeddings` / `bge-m3` / 空 | 可选向量召回 |
| `loopWorkerIntervalMs` | 1200 | 后台任务轮询毫秒 |
| `loopContextChars` | 20000 | 上下文硬约束预算 |

## 7. 数据与隐私

- **代码开源，数据不入库**：仓库不包含真实对话、记忆数据库、规则库、工作区域语料或截图中的私有数据。
- 所有记忆、本体、规则、任务、评估、反馈默认仅保存在本机 SQLite。
- 模型/embedding 端点必须显式配置；不会默认把完整历史静默外传。
- 未配置向量服务时只使用词法检索，并明确显示“向量未配置/不可用”。
- 敏感记忆默认不进入上下文；普通日志/审计不输出原始敏感文本。
- 单用户运行边界；不应把它当作多租户安全系统。

详见 [DATA-POLICY.md](../DATA-POLICY.md)。

## 8. 测试与验收

```bash
node --test tests/loop.test.mjs
node tools/loop-e2e.mjs http://127.0.0.1:18912/ /tmp/loop-shots
node tools/loop-e2e-manage.mjs http://127.0.0.1:18912/ /tmp/loop-manage
```

当前自动化测试为 143 项通过。53 + 39 项浏览器 E2E 属于历史版本记录，见 [verification-v3.md](verification-v3.md)；当前接入及真实环境验证边界见 [model-integration.md](model-integration.md)。

## 9. 边界

- 不自动执行外部业务动作；动作权限通过也只记录，不调用执行器。
- 不自动训练/发布模型；反馈只生成候选版本。
- 附件只保存元数据，不解析正文。
- 单用户边界，无 RBAC。
- 后台 worker 为进程内 + SQLite 租约，不是分布式调度器。
- 向量召回需要外部 embedding 服务；不可用时降级词法。

## 10. 许可证

代码 MIT。`web/assets/cortex` 与 `web/assets/three` 等第三方资源遵循各自许可证，
详见 [LICENSE](../LICENSE) 与 `web/assets/*LICENSE*`。
数据不在开源许可范围内，详见 [DATA-POLICY.md](../DATA-POLICY.md)。
