# AGENTS.md — 开发者与 AI 协作约定

> 给接手这个项目的开发者或自动化代理：先读这一页，再动代码。
> 详细架构、数据格式、两端构建和版本历史见 `docs/ARCHITECTURE.md`。

## 先读什么

1. `docs/ARCHITECTURE.md`：模块、数据格式、IPC、两端构建、已知限制
2. `README.md`：功能、快速开始、项目结构
3. `docs/BUILD.md`：Windows 打包、图标、签名
4. `docs/MOBILE.md`：手机端 APK 构建
5. `SECURITY.md`：密钥、用户数据和漏洞报告

## 不能破坏的约定

- 库格式固定为 `<库根>/index.json + orig/<id>/ + prev/<id>/`。
- 普通素材的 `storedPath` 必须是**相对库根**的路径；`originPath` 只对 `refOnly` 文件夹引用有意义，换机器会标缺失。
- 0.3.0 起 `index.json` 由 `lib/vault.js` 的内存索引 + `.avatarvault/journal.ndjson` + 原子快照维护；不要绕过 `vault.record()` 直接 `saveIndex()`（批量导入和测试脚本除外）。
- 入库按 SHA-256 去重；导入备份按 `id` 去重，只增不覆盖（重复导入可以补统计，但不要覆盖用户字段）。
- `stats` 以 PC 解析结果为准：`.unitypackage` / `.zip` 导入后重新解析；补算过写 `statsRepaired`。不要改回“直接沿用手机端 stats”。
- 手机端 `.zip` 的 `vramMB` 恒为 0，`.unitypackage` 是压缩字节估算；这是已知限制，不是 PC 端 bug。
- UI 里 `.workspace`、`.center`、`.detail` 必须保留 `min-height:0`；否则详情栏会撑高整行、网格滚轮失效。
- 不显示 `.unitypackage` 自带的 `preview.png`；封面只认用户自己加的示意图。
- 堆叠/合并卡是 **PC-only 视图功能**：堆叠分组只放程序配置（`%APPDATA%\AvatarVault\config.json`，按库根分键），**不要写 `index.json`**；合并卡写入 `bundle`，原卡写 `bundledInto`，**不要删除原卡或原文件**。删除合并卡必须走还原，避免隐藏原卡变孤儿。
- 保持 `contextIsolation: true`、`nodeIntegration: false`；BOOTH 抓取只允许 `booth.pm` 和 `booth.pximg.net`。
- 用户确认过的交互（删图确认、删素材确认、类目删除规则、短提示语）不要改回去，详见 `docs/ARCHITECTURE.md` 第五节。

## 常用命令

```bash
npm ci
npm start
npm run seed-demo

npm test
npm run test:ingest
npm run test:portable
npm run test:mobile-import
npm run test:bundle
npm run test:stack
node scripts/test-booth.js
```

- `node scripts/test-booth.js` 默认不联网；需要真实抓 BOOTH 时用 `AV_TEST_BOOTH_NETWORK=1`。
- Windows 最终打包用 `npm run pack:win-icon`；Linux 只能做逻辑/界面验证，不能完整模拟 Windows GUI。

## 发布前检查

1. 先跑上面的测试，确认库格式 / 备份导入 / 拖拽相关回归通过。
2. 确认 `git status` 里没有 `index.json`、`orig/`、`prev/`、`_demo-library/`、`build/*.keystore`、`.env` 或构建产物。
3. Windows 上执行 `npm run pack:win-icon`，检查 `dist/AvatarVault-win32-x64/resources/app` 里含 `lib/vault.js`、`lib/thumbs.js`、`workers/heavy.js` 和 `node_modules/@img/sharp-win32-x64`。
4. 打 zip 后跑 `unzip -t`；发布包里保留 Electron 的 `LICENSE` / `LICENSES.chromium.html`。
5. 更新 `CHANGELOG.md` 和版本号；手机端 APK 需要签名时用环境变量提供 keystore，不要把密钥写进仓库。

## 当前状态

- 桌面端：`0.3.0`
- 手机端：`0.2.8`
- 源码不包含 `node_modules`、`dist`、`_demo-library`、用户素材库或签名密钥；用 `npm ci` 恢复依赖。
- 0.3.0 新增 `.avatarvault/`（日志/快照序号）与 `userData/thumb-cache/`，都不属于库格式，不要打进整库备份。
