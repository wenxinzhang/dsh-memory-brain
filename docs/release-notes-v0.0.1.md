# Mind Galaxy v0.0.1

首个开源版本（从 v0.0.1 开始）：DeepSeek Harness 内的本地优先「记忆闭环」插件。

## 亮点

- **完整闭环**：对话导入 → 原子记忆 → 动态本体 → 规则 → 上下文 → 反馈 → 版本更新。
- **持久任务**：`loop_jobs` + SQLite 租约 worker；导入/拆解/向量化异步执行，重启后恢复过期任务，失败可重试/取消。
- **本体版本**：结构发布生成快照 + diff + change log；支持影响评估后的回滚。
- **规则治理**：来源权威性与优先级、冲突检测、人工裁决（A/B/都保留/都暂停）。
- **上下文**：确定性硬约束 + 关键词/证据/范围/关联重排；可选向量召回；预算与 `why` 解释。
- **动作权限**：规则生效不等于执行授权；`blocked / pending / denied / authorized_not_executed`，不自动执行外部动作。
- **三维大脑**：真实闭环图谱投射到 Three.js 皮层。
- **数据不入库**：仓库与 npm 包只含源码、文档、合成样例。

## 质量

- 37 个行为测试。
- 53 项主流程 + 39 项管理动作浏览器 E2E。
- schema v4；支持 v1 → v4 原地迁移。

## 安装

```bash
git clone https://github.com/wenxinzhang/dsh-memory-brain.git ~/dsh-workspace/memory-brain
node ~/dsh-workspace/memory-brain/tools/seed-sample.mjs --force
# DSH Plugin Manager: install_bundle target ~/dsh-workspace/memory-brain
```

## 数据与许可

代码 MIT；数据不在开源范围内，详见 `DATA-POLICY.md`。
