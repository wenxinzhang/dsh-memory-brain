# web/data（运行时数据目录）

本目录存放**本机运行时数据**，默认不进入 Git、不随 npm 包分发。

- `sample-payload.json`：完全合成的开放样例，供 3D 大脑首次启动使用。
- `payload.json` / `demo.json`：用户自己的数据包，不入库。
- `rules.json` / `loop.db` / `loop.db-wal` / `loop.db-shm`：本机闭环数据，不入库。
- `loop.db.bak-*`：本地备份，不入库。

首次使用：

```bash
node tools/seed-sample.mjs --force   # 生成合成闭环样例
```

真实数据请留在本机；数据政策见仓库根目录 `DATA-POLICY.md`。
