# corpus/ — 规则提炼语料

把要提炼的语料放在这里，然后在忆核大脑页面点「规则提炼」→「提炼规则」。

支持格式：`.txt`、`.md`、`.json`、`.csv`、`.log`（UTF-8）。
子目录会递归扫描；`README.md`、隐藏文件、`node_modules` 会被跳过。

建议：
- 一个主题一个文件，文件名用中文/英文都可
- 语料尽量是**你本人写的或对你有约束力的内容**（日记、复盘、沟通原则、工作方法、偏好记录）
- 不要把隐私内容提交到公开仓库；这个目录默认不随 npm 包发布（只发布本 README）

默认使用本地 Strata：
- endpoint: `http://127.0.0.1:8080/v1`
- model: `qwen3.8-flash-next`

可在 profile 的 `memory-brain` config 里改 `rulesEndpoint` / `rulesModel` / `corpus`。
