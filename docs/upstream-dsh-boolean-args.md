# 上游提案：plugin_manager 的布尔参数支持大小写容错

## 背景（现象）

调用 DSH 内置 `plugin_manager` 工具的 `set_plugin` / `set_bundle` / `install_bundle` 时，
若参数被序列化成字符串 `"True"` / `"False"`（大小写混用的常见情形），会得到：

```text
invalid arguments: "enabled" must be a boolean
```

而 JSON 原生布尔（小写 `true` / `false`）一切正常。日常使用不受影响：
调用方按 JSON 标准传小写布尔即可。

## 根因（已核实，勿改本机应用）

这不是星河大脑插件的问题，也不是 DSH 的 bug，而是三层叠加：

1. **JSON 标准**：JSON 布尔只有小写 `true` / `false`。`True` / `False` 不是合法
   JSON 布尔，序列化后变成字符串。
2. **DSH 内核严格校验**（官方应用内，位于签名的只读 `app.asar`）：
   - `@deepseek-ai/dsh-tools` → `validateArgs(spec, args)`（编译产物
     `dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js:300`）；
   - 底层标量校验 `case "boolean": finish(typeof frame.value === "boolean" ? … :
     ["must be a boolean"])`（编译产物 `lib/types/json-schema.js:543`）。
3. **工具声明**：`@deepseek-ai/dsh-plugin-manager` →
   `lib/types/tools.js:81` 的 `enabled: { type: 'boolean' }`。

上述文件都打包在 `/Applications/DeepSeek Harness.app` 的签名归档内，**没有可写的
本地源码 checkout**；解包重打包（asar）会破坏代码签名、导致无法启动或自动更新失败，
且随版本升级被覆盖。因此该修复只能走上游。

## 建议补丁（供提交 DSH 上游）

原则：只放宽「模型生成参数」入口 `validateArgs`，不影响 authoring / 远程 API 的
严格 JSON Schema 校验；并把归一化结果传给执行器，保证校验与执行看到同一个值。

```ts
/** Lenient coercion of string booleans for model-generated tool arguments.
 *  Only applies to properties whose declared type is boolean. */
function coerceStringBooleans(schema: RawObjectSchema, args: unknown): unknown {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
	const properties = schema.properties;
	if (properties === undefined) return args;
	let out = args as Record<string, unknown>;
	let copied = false;
	for (const [key, value] of Object.entries(out)) {
		if (typeof value !== "string") continue;
		const lowered = value.toLowerCase();
		if (lowered !== "true" && lowered !== "false") continue;
		if (properties[key]?.type !== "boolean") continue;
		if (!copied) { out = { ...out }; copied = true; }
		out[key] = lowered === "true";
	}
	return out;
}

function validateArgs(spec, args) {
	const schema = parameterSchemaSpecToJsonSchema(spec);
	return validateJsonSchemaValue(schema, coerceStringBooleans(schema, args), "");
}
```

要点：

- **仅** `type: 'boolean'` 的属性参与强制转换；`"yes"` / `"1"` 等仍然拒绝，保持严格性。
- 工具执行入口也要使用转换后的 `args`（否则校验通过但 handler 仍收到字符串）：
  建议给执行分发链增加一个 `normalizeToolArgs(schema, rawArgs)` 步骤，
  `validateArgs` 与 handler 共用其输出。
- 建议在转换发生时打一条可观测日志（violation 之外加 warning 级诊断），便于模型侧纠正。
- 同类参数如 `acceptRisk`、`loopEmbedEnabled` 等自动受益，无需逐工具修改。

## 当前规避（已在用）

- 调用工具时始终传 JSON 原生布尔：`"enabled": true` / `"enabled": false`（全小写）。
- 星河大脑自身的 HTTP API 不经过该工具校验，不受影响。

## 状态

- [x] 根因定位（文件/行号见上）
- [ ] 提交 DSH 上游（需要 DSH 源码仓库权限；本机没有源码 checkout）
- [ ] 上游合入后删除本文档
