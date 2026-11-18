# AvatarVault

A local-first asset library for VRChat modding assets. Collect `.unitypackage` / `.zip` / folder assets into one local vault, browse and search them, manage sets and tags, then **drag them straight into Unity's Project window**.

AvatarVault is a standalone desktop tool, not a Unity editor plugin. It only manages the library; rigging, material migration, and performance checks still belong in Unity. The desktop app is built with Electron; the mobile app uses native Java + the system WebView and shares the same library format.

> **Status:** desktop `0.3.0`, mobile `0.2.8`. Windows builds are unsigned, so SmartScreen may warn on first launch.

> **Built with AI assistance:** AvatarVault was developed with an AI coding agent. Architecture, implementation, tests, and documentation were drafted with AI assistance and reviewed/validated by the maintainer. The project does not claim that every line was written by a human; see [AI-assisted development](#ai-assisted-development).

## Why this exists

VRChat modding assets tend to be scattered across downloads, cloud drives, and old folders. Before importing a model into Unity, you often need to remember which body, outfit, makeup, or prop package it belongs to, find a preview, and check its size or estimated VRAM. AvatarVault turns that into a local library:

- one copy of every asset, deduplicated by SHA-256;
- one searchable, tagged, categorised grid with covers;
- one-click drag into Unity, without opening a file explorer;
- portable backups that can move between PCs and the mobile app.

The app is local-first: the vault, index, thumbnails, tags, notes and covers stay on your disk. It does not upload library data to a server.

## Features

- **Ingest:** drag `.unitypackage`, `.zip`, individual files or folders; content deduplication; original copy + thumbnail cache.
- **Parse:** built-in streaming tar.gz and ZIP central-directory readers; no Unity dependency.
- **Classify:** path-keyword scoring, editable categories.
- **Stats:** asset/material/texture/prefab counts, estimated VRAM from PNG-JPEG headers, size.
- **Browse:** virtual-scrolling thumbnail wall, category sidebar, favourites, tags, search; comfortable/compact/list density.
- **Batch:** Shift range select, Ctrl+A, Delete/Backspace; batch category/tag/delete actions (0.3.0).
- **Performance:** multi-size WebP covers, in-memory index with append-only journal and async snapshots, worker pool (0.3.0).
- **Covers:** import local images or paste a clipboard screenshot; multiple covers per item.
- **BOOTH:** paste a `booth.pm` item link in notes to fetch the product name and first image.
- **Migration:** export the whole library as one ZIP or a folder; import and merge backups by id.
- **Sets:** create sets, add/remove/reorder members, drag a whole set into Unity.
- **Stacks:** stack same-category cards, persist per library, merge into a ZIP bundle card and restore.
- **Drag out:** native `webContents.startDrag`, lands directly in Unity's Project panel.

## Quick start

Requires Node.js 20 or 22 (22 recommended):

```bash
npm ci
npm start
```

Create a demo library:

```bash
npm run seed-demo
# Linux/macOS
AV_LIB_ROOT=./_demo-library npm start
# PowerShell
$env:AV_LIB_ROOT="./_demo-library"; npm start
```

Build the Windows portable folder:

```bash
npm run pack:win-icon
```

More details:

- [docs/BUILD.md](docs/BUILD.md) — Windows build, icon, code signing
- [docs/MOBILE.md](docs/MOBILE.md) — Android APK build
- [docs/TOOLS.md](docs/TOOLS.md) — toolchain
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — modules, IPC and data format

## Library format

```text
<vault-root>/
├── index.json
├── orig/<id>/       # original copies
└── prev/<id>/       # user covers
```

Desktop config lives in `%APPDATA%\AvatarVault\config.json` and only stores the vault path and stack groups. The mobile app stores its vault in the private `files/vault` directory. The app only connects to `booth.pm` and `booth.pximg.net` when you ask it to fetch a BOOTH item.

Never commit a real vault (`index.json`, `orig/`, `prev/`, `exports/`) to a repository. `.gitignore` already excludes those paths.

## Tests

```bash
npm test                    # 0.3.0 data layer / thumbnails / journal / backup compatibility
npm run test:ingest
npm run test:portable
npm run test:mobile-import
npm run test:bundle
npm run test:stack
node scripts/test-booth.js  # offline by default
```

## AI-assisted development

This project was built with AI assistance. The maintainer defined the product requirements and acceptance criteria; an AI coding agent helped with architecture, implementation, tests and documentation; the maintainer reviewed the changes, ran the test suite and made the release decisions.

If you contribute, please treat AI-generated code like any other contribution: review it, test it, and keep the library-compatibility and user-data-safety rules described in [AGENTS.md](AGENTS.md).

## Search keywords / 搜索关键词

If you are looking for a **VRChat asset manager, avatar modding asset library, unitypackage organizer, BOOTH asset manager, local-first Unity drag-and-drop library, or an AI-assisted open-source desktop tool**, these terms describe the project:

VRChat, VRChat 改模, Avatar 素材, 模型素材管理, unitypackage 素材库, Unity 资源库, BOOTH 素材, 本地素材库, 拖拽到 Unity, Electron 桌面应用, AI 辅助开发, local-first asset library, VRChat modding, avatar assets, Unity drag-out, asset manager, open source.

## Contributing, security and license

- [CONTRIBUTING.md](CONTRIBUTING.md)
- [SECURITY.md](SECURITY.md)
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

Released under the [MIT License](LICENSE).

AvatarVault is an independent third-party tool. It is not affiliated with or endorsed by VRChat, Unity Technologies, BOOTH or Pixiv. All product names and trademarks belong to their respective owners. If you use the BOOTH fetch feature, follow BOOTH's terms of service.

---

# 中文说明

AvatarVault 是一个**本地优先的 VRChat 改模素材库**。它把散落在硬盘里的 `.unitypackage` / `.zip` / 文件夹素材收进一个本地库，支持分类、搜索、标签、套装和封面管理，再**原生拖出**到 Unity 的 Project 窗口直接用。

它只负责「库」，不负责「装配」：骨骼重绑、材质迁移、性能校验这些仍然需要 Unity 编辑器插件。桌面端使用 Electron，手机端使用原生 Java + 系统 WebView，两端共用同一套库格式。

> 当前版本：桌面端 `0.3.0`，手机端 `0.2.8`。Windows 安装包未签名，首次运行可能触发 SmartScreen 提示。

> **开发说明：本项目是在 AI 编程助手参与下完成的。** 产品需求、验收标准和最终发布由维护者确定；架构、代码、测试与文档由 AI 起草/实现，维护者负责审阅、运行验证和发布决策。项目不声称每一行代码都由人工从零编写，详见下文「开发方式」。

## 用途

VRChat 改模素材常常散落在下载目录、网盘和旧文件夹里。导入 Unity 前，你往往要回忆某个模型属于哪个素体、哪套服装、哪套妆容或道具，还要找预览图、看体积和预估显存。AvatarVault 把这些动作收敛成一个本地库：

- 每份素材只存一份，按 SHA-256 去重；
- 一个可搜索、可打标签、可分类、带封面的缩略图墙；
- 不用打开资源管理器，直接从卡片拖进 Unity；
- 支持整库备份，在电脑和手机之间迁移。

素材、索引、缩略图、标签、备注和封面都保存在你自己的磁盘上，不上传服务器。

## 功能

| 模块 | 说明 |
|---|---|
| 入库 | 拖 `.unitypackage` / `.zip` / 散文件 / 文件夹；SHA-256 内容去重；原件副本 + 缩略图缓存 |
| 解析 | 自带流式 tar.gz 与 zip 中央目录解析器，纯 Node 实现，不依赖 Unity |
| 识别 | 按包内路径关键词给类目打分，可手动改 |
| 统计 | 资产数 / 材质 / 贴图 / Prefab / 预估显存（读 PNG-JPEG 文件头）/ 体积 |
| 浏览 | 虚拟滚动缩略图墙、类目侧栏、收藏、标签、搜索；大图 / 紧凑 / 列表三档 |
| 批量 | Shift 连选 / Ctrl+A / Delete；右键批量改类目、加标签、删除（0.3.0） |
| 性能 | 多档 WebP 封面缓存、主进程常驻索引 + 追加日志 + 异步快照、worker 线程池（0.3.0） |
| 示意图 | 「＋」导入本地图片 / Ctrl+V 粘贴剪贴板截图，多图切换、右键移除、点开看大图 |
| BOOTH | 备注里贴 `booth.pm` 商品链接，自动抓商品名和首图；无链接自动跳过 |
| 迁移 | 整库导出（单文件 zip 或文件夹）+ 从备份导入合并，按 id 去重、路径重写 |
| 套装 | 空套装 / 选中带入、加入移出、排序、整套拖 Unity、按类目导出文件夹 |
| 堆叠 | 同类目多选右键堆叠，按库目录持久保留；可合并为一张 ZIP 合集卡并还原 |
| 取用 | `webContents.startDrag` 原生拖拽，可直接落到 Unity Project 面板 |

## 快速开始

要求 Node.js 20 或 22（推荐 22）：

```bash
npm ci
npm start
```

造一个带样例数据的本地库：

```bash
npm run seed-demo
# Linux/macOS
AV_LIB_ROOT=./_demo-library npm start
# PowerShell
$env:AV_LIB_ROOT="./_demo-library"; npm start
```

Windows 绿色版打包：

```bash
npm run pack:win-icon
```

完整构建、图标、代码签名和手机端 APK 构建见：

- [docs/BUILD.md](docs/BUILD.md)
- [docs/MOBILE.md](docs/MOBILE.md)
- [docs/TOOLS.md](docs/TOOLS.md)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## 数据格式

```text
<库根>/
├── index.json
├── orig/<id>/       # 原件副本
└── prev/<id>/       # 用户示意图
```

桌面端配置在 `%APPDATA%\AvatarVault\config.json`，只记录库路径和堆叠分组。手机端数据在应用私有目录 `files/vault`。程序只在你主动抓取 BOOTH 商品时访问 `booth.pm` 和 `booth.pximg.net`。

不要把真实素材库（`index.json`、`orig/`、`prev/`、`exports/`）提交到仓库；`.gitignore` 已默认忽略这些路径。

## 测试

```bash
npm test                    # 0.3.0 数据层 / 缩略图 / 日志 / 备份兼容回归
npm run test:ingest
npm run test:portable
npm run test:mobile-import
npm run test:bundle
npm run test:stack
node scripts/test-booth.js  # 默认不联网
```

## 开发方式

本项目在 AI 编程助手参与下完成。维护者负责提出需求、确定验收标准、审阅代码、运行测试并决定是否发布；AI 编程助手参与架构设计、代码实现、回归测试和文档整理。欢迎把 AI 生成的代码当作普通贡献来 review：先看兼容性和用户数据安全，再跑测试。

## 贡献、安全与许可证

- [CONTRIBUTING.md](CONTRIBUTING.md)
- [SECURITY.md](SECURITY.md)
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

本项目使用 [MIT License](LICENSE)。

AvatarVault 是独立的第三方工具，与 VRChat、Unity Technologies、BOOTH / Pixiv 没有隶属或官方授权关系；相关名称和商标归各自权利人所有。使用 BOOTH 抓取功能时请遵守 BOOTH 的服务条款。
