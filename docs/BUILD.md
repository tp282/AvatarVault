# 构建说明（Windows 桌面版）

> 手机端 APK 的构建不在本文，见 [MOBILE.md](MOBILE.md)。

## 0. 环境

> 完整工具链见 [TOOLS.md](TOOLS.md)；开发约定见根目录 `AGENTS.md`。

- Node.js 20 或 22（推荐 22 LTS）
- Windows 10/11 x64
- 首次 `npm ci` 要下载约 100MB 的 Electron 运行时，国内建议设镜像：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm ci
```

## 1. 本地跑起来（开发调试）

```powershell
npm start
```

想开 DevTools：在 `main.js` 的 `createWindow()` 里临时加一行 `win.webContents.openDevTools()`。

造一个带样例数据的库，方便看界面：

```powershell
npm run seed-demo
# 然后用 AV_LIB_ROOT 指向它启动（PowerShell）
$env:AV_LIB_ROOT=".\_demo-library"; npm start
```

## 2. 打包 Windows exe

```powershell
npm run pack:win-icon
```

产物：`dist\AvatarVault-win32-x64\AvatarVault.exe`（整个文件夹就是要分发的绿色版）。

这一步在 **Windows 上执行**很关键——它会通过 `rcedit` 把 `assets\icon.ico` 和版本信息写进 exe 的资源段。
在 Linux/macOS 上打包只能出裸 exe，图标和「文件说明/版权」是 Electron 默认的，观感更差、更容易被 SmartScreen 拦。

其他开关：

```powershell
npm run pack:win        # 不写图标（跨平台可用）
npm run pack:asar       # 代码打进 app.asar，防随手改
node scripts/pack.js --asar   # 等价写法
```

## 3. 图标

```powershell
npm run make:icon   # 由 assets/icon.png 重新生成 icon.ico 与拖动图标
```

想换图标：把新的 256×256 PNG 覆盖 `assets/icon.png`，再跑一次 `npm run make:icon`。

## 4. 签名（可选，但能根治 SmartScreen）

未签名的 exe 第一次运行时 Windows 会弹「Windows 已保护你的电脑 / 发布者：未知」，这是声誉拦截，不是报毒。

拿到代码签名证书（OV/EV 或 Azure Trusted Signing）后：

```powershell
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /a `
  dist\AvatarVault-win32-x64\AvatarVault.exe
```

- **EV 证书**：签完立刻不弹。
- **OV 证书**：先去 reputation 攒一段时间，仍可能弹几次。
- 没证书时的替代方案：随包附说明，教用户「右键属性 → 解除锁定」或点「仍要运行」。

## 5. 目录结构

```
main.js              主进程：窗口、IPC、原生拖拽、导入导出
preload.js           contextBridge 桥 + 外部文件拖入（webUtils.getPathForFile）
lib/tar.js           流式 tar 读取（只读需要的小条目，恒定内存）
lib/unitypackage.js  .unitypackage 解析（gz+tar / pathname / preview / 贴图尺寸）
lib/zip.js           zip 中央目录解析、单条目解压、备份识别
lib/zipwrite.js      store 模式 zip 写入（整库打包导出）
lib/png.js           PNG / JPEG 文件头尺寸解析（估显存）
lib/classify.js      类目关键词打分
lib/ingest.js        入库编排：哈希 → 解析 → 落盘 → 统计 → 建条目
lib/store.js         index.json 原子读写
lib/vault.js         常驻索引 / 追加日志 / 原子快照
lib/thumbs.js        多档 WebP 缩略图缓存
lib/worker-pool.js   worker 线程池
lib/portable.js      整库导出 / 导入合并
src/                 渲染进程（原生 JS，无构建步骤，改完直接重启）
workers/             入库解析 / 统计 worker
scripts/             pack.js 打包、seed-demo 造样例、test-* 自测、make-ico 图标
assets/              icon.png / icon.ico / drag-icon.png
```

## 6. 数据放在哪

- 素材库目录：默认 `%USERPROFILE%\Documents\AvatarVault`（可在程序里「库 ▾ → 库位置…」改）
  结构：`index.json` + `orig\<id>\`（原件副本）+ `prev\<id>\`（示意图）
- 程序配置：`%APPDATA%\AvatarVault\config.json`（记录库路径）

## 7. 自测脚本

```powershell
npm test                   # 0.3.0 数据层 / 缩略图 / 日志 / 备份兼容回归
npm run test:ingest        # 造 .unitypackage / .zip / 文件夹，跑完整入库链路
npm run test:portable      # 整库导出 → 解包 → 导入到空库，验证路径重写
npm run test:mobile-import # 手机 stats.vramMB=0 的备份导入回归
npm run test:bundle        # 合并 ZIP 卡 / 还原回归
npm run test:stack         # 堆叠分组校验 / 解散 / 失效清理
node scripts/test-booth.js # BOOTH 链接/JSON 解析（默认不联网）
```

## 8. 已知限制

- 文件夹入库是「引用」模式，只记录路径，不能拖出。
- 包内自带的 `preview.png` 不展示也不入库，封面只认用户自己加的示意图。
- 不解析 FBX 面数（要 Unity 或 FBX SDK），面数相关判断请以 Unity 里为准。
- 导出 zip 用的是 store 模式（不压缩、无 ZIP64），单文件 >4GB 或总量 >4GB 会退回文件夹导出。
- Windows 混合选择文件+文件夹的对话框不可用，所以「从备份导入」拆成了两次选择。
