# v3 闭环缺口补齐 · 验收记录（数据库 schema v4）

本轮在现有闭环上增量实现：

1. 持久化后台导入/拆解队列（`loop_jobs`）
2. 本体结构版本快照 / 差异 / 回滚（`loop_ontology_versions`、`loop_ontology_change_log`）
3. 规则冲突人工裁决（`loop_rule_conflict_resolutions`）
4. 向量召回（`loop_embeddings` + 混合检索 + 后台 embed 任务）

环境：macOS · Node.js v26.11.1 · `node:sqlite` · DSH Desktop · 本机模型
`http://127.0.0.1:8080/v1`。embedding 服务 `http://127.0.0.1:8781/v1/embeddings`
在本轮验收时**未启动**，因此线上/演示库表现为“已配置但不可用 → 显式降级词法”，
没有伪造任何向量结果；向量功能用本地 mock embedding 服务做行为验证。

## 1. 行为测试

```bash
node --test tests/loop.test.mjs
```

**37 tests / 37 pass / 0 fail**（连续运行稳定）。

新增覆盖：

- 持久队列：入队立即返回、同幂等键去重、取消、重试、`running + lease 过期` 重启后自动重新入队；
- 本体版本：发布生成快照/差异、无效候选不产生版本、回滚前影响评估、确认回滚后实例 `orphaned`、规则暂停、追加 rollback 版本；
- 冲突裁决：`prefer_a` 只保留 A、`disable_both` 双方退出、`keep_both` 双方保留；规则不删除，审计可查，未裁决冲突继续保留；
- 向量：mock embedding 下语义召回生效（无关键词重叠也能排前）、硬约束始终保留；未配置时 `configured:false` 且只走词法，reindex 返回 409；向量只参与排序。

## 2. 浏览器 E2E（真实后端 + 真实模型 + mock embedding 的独立用例）

准备验收库：

```bash
cd ~/dsh-workspace/memory-brain
cp web/data/loop.db web/data/loop-verify.db
node tools/seed-v4-fixtures.mjs web/data/loop-verify.db   # 冲突/权限/结构候选验收夹具
node tools/loop-dev-server.mjs --port 18912 --db web/data/loop-verify.db
node tools/loop-e2e.mjs http://127.0.0.1:18912/ /tmp/loop-shots-v4
node tools/loop-e2e-manage.mjs http://127.0.0.1:18912/ /tmp/loop-manage-v4
```

- `loop-e2e.mjs`：**53/53 PASS**。新增：后台任务队列显示 queued/running/已完成、本体版本历史/差异入口、向量状态与降级提示；原有导入→真实模型拆解→记忆→本体→规则→Skill→上下文→反馈→图谱投射→刷新恢复全部保持。
- `loop-e2e-manage.mjs`：**39/39 PASS**。新增：冲突四个裁决按钮与理由持久化、结构发布生成 v2、差异、回滚到 v1 并确认类型移除、拆解任务取消/重试、向量探测/重建入口；原有记忆编辑/版本/本体操作/规则编辑/重复导入/归档/投射恢复全部保持。

## 3. 线上 GUI（52083）

通过 `plugin_manager` 对 `include:memory-brain` 做 disable/enable 热重载后：

- `/api/loop/overview` 返回 `versions.schema=4`、`vector`、`jobs`；
- `/api/loop/ontology/versions` 返回 baseline；
- `/api/loop/jobs` worker 已启动；
- `/api/loop/embeddings/status` 明确 `configured:true, available:false`；
- Chrome CDP 实测 **8/8 PASS**：任务队列面板、本体版本历史、向量召回面板与探测、冲突视图、无 JS 异常。

截图：[线上面板](verification-shots/v3-live-panels.png)。

## 4. 页面截图

- [导入 + 持久任务队列](verification-shots/v3-import-job.png)
- [规则中心](verification-shots/v3-rules.png)
- [冲突人工裁决](verification-shots/v3-conflict.png)
- [本体版本历史 / 回滚](verification-shots/v3-ontology-version.png)
- [图谱与投射](verification-shots/v3-graph.png)
- [线上 v4 面板](verification-shots/v3-live-panels.png)

## 5. 数据库迁移与兼容

- 迁移版本：v1 → v2 → v3 → **v4**；启动时按 `loop_schema_migrations` 顺序执行。
- v4 只新增表，不删列：`loop_jobs`、`loop_ontology_versions`、`loop_ontology_change_log`、
  `loop_rule_conflict_resolutions`、`loop_embeddings`；旧数据（来源/消息/记忆/规则/实例）保留。
- 首次启动 v4 时生成本体结构 baseline v1；后续发布/回滚追加版本。
- 旧数据库可直接被新 runtime 打开；本轮用 v3 演示库升级到 v4 验证通过。

## 6. 仍然未完成 / 外部依赖

- embedding 服务 `bge-m3`（8781）未运行：演示库无向量，页面显示“可探测 否 / 缺失”，上下文自动降级词法；启动服务后点“重建向量索引”即可。
- 外部业务执行器未接入；动作权限校验通过也只记录 `authorized_not_executed`。
- 单用户运行边界，未做多租户 RBAC。
- 附件仍只存元数据（“内容未解析”）。
- 任务 worker 为进程内单 worker + SQLite 租约；未做多进程调度器，但租约机制可避免重复抢占。
- 拆解/embedding 的历史失败不会自动无限重试；超过 `max_attempts=3` 后进入 failed，需人工 `POST /jobs/:id/retry`。

## 7. 复现完整闭环

```bash
cd ~/dsh-workspace/memory-brain
node --test tests/loop.test.mjs

# 浏览器（独立后端，不污染演示库）
cp web/data/loop.db web/data/loop-verify.db
node tools/seed-v4-fixtures.mjs web/data/loop-verify.db
node tools/loop-dev-server.mjs --port 18912 --db web/data/loop-verify.db
# 打开 http://127.0.0.1:18912/ → 顶栏「闭环」

# 线上：DSH → 脑内星河 → 闭环（当前已加载 v4）
```

在线体验顺序：导入（自动入队）→ 任务队列看进度 → 记忆/本体/规则 → 规则模拟与冲突裁决 →
本体版本历史/差异/回滚 → 上下文（关键词/向量状态/动作校验）→ 反馈 → 图谱投射。
