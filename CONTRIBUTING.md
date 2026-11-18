# 贡献指南

感谢你愿意改进 AvatarVault。这个项目优先保证三件事：**用户素材不丢、库格式可迁移、桌面端拖拽可用**。

## 开发环境

- Node.js 20 或 22（推荐 22）
- Windows 10/11 x64 用于最终打包；Linux/macOS 可以做逻辑与界面验证
- 手机端构建额外需要 JDK 17 和 Android SDK build-tools，见 [docs/MOBILE.md](docs/MOBILE.md)

```bash
npm ci
npm start
```

国内下载 Electron 较慢时可以设置镜像：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm ci
```

## 提交前检查

至少运行：

```bash
npm test
npm run test:ingest
npm run test:portable
npm run test:bundle
npm run test:stack
node scripts/test-booth.js
```

改到手机端或备份导入时，再补：

```bash
npm run test:mobile-import
```

Windows 打包：

```bash
npm run pack:win-icon
```

## 代码约定

- 库格式、`storedPath` 相对路径、SHA-256 去重、导入只增不覆盖等约定见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)；不要为了局部方便改坏兼容性。
- 0.3.0 起 `index.json` 由 `lib/vault.js` 的日志 + 快照维护；业务代码不要绕过 `vault.record()` 直接全量写索引（批量导入和测试脚本除外）。
- UI 里 `.workspace`、`.center`、`.detail` 的 `min-height:0` 不要删，否则详情栏会撑高布局并让网格失去滚动。
- 不显示 `.unitypackage` 自带的 `preview.png`，封面只认用户自己加的示意图。
- 保持 `contextIsolation: true`、`nodeIntegration: false`；BOOTH 抓取只允许 `booth.pm` 和 `booth.pximg.net`。
- 新增依赖前先确认许可证兼容 MIT，并在 `THIRD_PARTY_NOTICES.md` 里补充说明。

## 不要提交

- `node_modules/`、`dist/`、`release/`
- `build/*.keystore`、`*.jks`、`*.p12`、`*.pem`、`*.key`、`.env*`
- 真实素材库：`index.json`、`orig/`、`prev/`、`exports/`、`.avatarvault/`
- `_demo-library/`、日志、截图里的私人路径
- 任何 APK / EXE / ZIP 构建产物

## Issue 与 PR

- Bug 请附版本、系统、复现步骤；涉及用户素材时请先脱敏，不要上传真实库。
- PR 请保持范围单一，说明改了什么、怎么验证、是否影响库格式或旧备份兼容。
- 提交信息建议使用 `type: summary`，例如 `fix: 避免导入时覆盖已有素材`、`docs: 补充手机端构建说明`。

## 行为准则

参与本项目即表示同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
