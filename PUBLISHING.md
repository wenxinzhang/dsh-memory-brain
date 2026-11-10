# 发布检查

包名以 package.json 的 `@dafeiyu/dsh-memory-brain` 为准。此清单不代表已发布。

1. 使用 Node >=22.19.0，运行 `npm run check`、`npm test`、`git diff --check`。
2. 运行 `npm pack --dry-run --json`，逐项检查文件清单。必须包含 lib 的编译器、执行账本、宿主接入，以及 web/src/memory-view.js 和 Three.js 静态依赖。
3. 只允许发布完全合成的 `web/data/sample-payload.json`、数据说明和 `corpus/README.md`。不得包含真实 payload/demo/rules、SQLite/WAL/SHM、原始对话、个人截图、.env、token、语料和 node_modules。
4. 用隔离临时库验收页面、导入、抽取、规则、上下文及反馈；不得对个人库运行 seed 的 --force。不要复制运行中 WAL 库的主文件作为完整备份，应使用 SQLite backup。
5. 在当前 DSH 真实进程加载本包，验证连续两轮、多步工具、off/preview/忽略、模型切换、取消和失败、业务 deny 与宿主 ask。合成模型及独立 dev server 不替代该项。
6. 只有用户要求发布时才登录 registry、确认 scope 权限、更新版本并执行 npm publish；发布后用 npm view @dafeiyu/dsh-memory-brain version dist.tarball 回读，在干净 profile 安装验证。
7. 更新前备份 SQLite 与配置；回退必须匹配代码和兼容数据库版本。不要删除用户数据或自动降级 schema。

当前宿主接入及自动抽取验证边界见 docs/model-integration.md。历史 verification-v3.md 的浏览器结果属于其记录版本。
