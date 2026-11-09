# 发布清单（PUBLISHING）

面向 `@wenxinzhang/dsh-memory-brain`。每一步都尽量用命令确认，而不是"看起来没问题"。

## 0. 发布前检查

- [ ] 工作区在预期的 checkout：`pwd` → `.../dsh-workspace/memory-brain`
- [ ] 版本号已更新：`package.json` 的 `version`（当前 `0.0.1`），README 中出现的版本示例同步更新
- [ ] `locale/zh.json`、`locale/en.json` 的 `meta.title` / `meta.description` 仍准确
- [ ] `icon.svg` 仍是有效 SVG 且 < 256 KiB
- [ ] 隐私：`web/data/payload.json`、`web/data/demo.json` 会随包发布；
      `web/data/rules.json` 可能含个人规则，确认发布前是空种子或已脱敏。
      `corpus/` 用户语料默认不发布，只发 `corpus/README.md`。
- [ ] 上游授权：`web/assets/cortex/` 保留 CC BY-SA 3.0 归属（LICENSE 与
      `web/assets/cortex/LICENSE-ATTRIBUTION.md` 已收录）

## 1. 静态校验

```bash
cd ~/dsh-workspace/memory-brain
node --check lib/index.js
node --check lib/client.js
node -e "for (const f of ['package.json','locale/zh.json','locale/en.json']) JSON.parse(require('fs').readFileSync(f,'utf8')); console.log('json ok')"
xmllint --noout icon.svg && echo 'icon ok'
node -e "const y=require('fs').readFileSync('cordis.patch.yml','utf8'); if(!/^- insert:/m.test(y)) process.exit(1); console.log('patch ok')"
```

## 2. 打包预览（必看文件清单）

```bash
npm pack --dry-run --json > /tmp/memory-brain-pack.json
node -e "const p=require('/tmp/memory-brain-pack.json')[0]; console.log(p.name, p.version, p.size+'B unpacked', p.unpackedSize+'B'); for (const f of p.files) console.log(f.path, f.size)"
```

- [ ] 清单含：`package.json`、`cordis.patch.yml`、`lib/index.js`、`lib/client.js`、`lib/rules.js`、
      `locale/*.json`、`icon.svg`、`README.md`、`LICENSE`、`PUBLISHING.md`、`corpus/README.md`
- [ ] 清单含 `web/**`：`index.html`、`styles/`、`src/`、`assets/cortex/*.bin`、
      `assets/three/`、`assets/vendor/brain3d.js`、`data/payload.json`、`data/demo.json`、`data/rules.json`
- [ ] 清单不含：`node_modules/`、`*.tgz`、`design-reference.png`、`shots/`、
      任何 `.env` / token 文件
- [ ] 大小合理（约 19 MB 未压缩；皮层 `.bin` 不可压缩，tarball 也会接近这个量级，
      远低于 npm 100 MB 限制）

## 3. 本地冒烟（发布前）

```bash
# 本地目录安装（绝对路径）
# plugin_manager install_bundle target: <repo>/memory-brain
curl -s http://127.0.0.1:<GUI端口>/memory-brain/api/health
curl -s http://127.0.0.1:<GUI端口>/memory-brain/api/all | head -c 120
```

- [ ] Web GUI → 会话视图 tab 出现「忆核大脑」，页面能加载并出图
- [ ] 故意写坏 payload（或临时改指不存在路径）→ tab 显示失败原因 + 重试；
      修好后点「重试」能恢复
- [ ] 重启后仍生效（客户端 bundle 已缓存，必要时确认 restart 后行为一致）

## 4. 发布

```bash
npm login                      # 确认有 @dafeiyu scope 发布权限
npm whoami
npm publish --access public    # publishConfig 里已声明 public，双保险
```

- [ ] `npm view @wenxinzhang/dsh-memory-brain version dist.tarball` 能看到新版本
- [ ] `npm view @wenxinzhang/dsh-memory-brain files`（或 registry 页面）确认文件清单

## 5. 发布后验证（干净安装）

```bash
# plugin_manager remove_bundle target @wenxinzhang/dsh-memory-brain
# plugin_manager install_bundle target @wenxinzhang/dsh-memory-brain@0.0.1
curl -s http://127.0.0.1:<GUI端口>/memory-brain/api/health
```

- [ ] 全新安装（不依赖本地 checkout）页面和数据都正常——这条同时验证了
      `files` 白名单没有漏文件

## 6. 回滚

- 停用：`plugin_manager set_bundle` / `set_plugin` 设为 disabled
- 卸载：`plugin_manager remove_bundle target @wenxinzhang/dsh-memory-brain`
  （profile patch 里手写的 `- id: memory-brain` config 行需自己删）
- 回旧版本：重新安装旧版本号（`install_bundle target @wenxinzhang/dsh-memory-brain@<old>`）
- npm 端：优先发补丁版本；`npm unpublish` 仅 72 小时内可用，且会影响已安装用户，慎用

## 7. 已知限制

- host 路由只挂在 webServer 已绑定的地址上（默认 127.0.0.1），不额外暴露公网
- 数据只读：页面不能改数据；换数据源靠 `config.payload` 或替换文件
- 页面按 1819×865 设计稿实现，栅格 + 3D 画布自适应；940px 以下收起右栏、720px 以下收起左栏

## 发布前必须清除真实数据

本机真实服务接入后，以下文件包含个人记忆/对话内容，不能直接打包发布：

- `web/data/payload.json`（主面板真实数据）
- `web/data/rules.json`（从个人语料提炼的规则）
- `web/data/payload.mock.json`（本地备份，不含真实数据，但仍需确认）

发布前请：

1. 用 `web/data/demo.json` 覆盖 `web/data/payload.json`
2. 用空规则种子覆盖 `web/data/rules.json`
3. 检查 `dist/` 里没有上述真实文件
4. 再执行 `npm pack`

当前源码中的 `web/data/payload.json` 是本机真实服务导出的数据，不要把它提交到公开仓库。
