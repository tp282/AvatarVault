# AvatarVault 架构与开发笔记

> 目的：记录模块、数据格式、IPC、两端构建、已知限制和版本历史，方便新贡献者继续开发。
> 配套：`README.md`（快速开始）、`docs/BUILD.md`（桌面构建）、`docs/MOBILE.md`（手机端构建）、`SECURITY.md`。
> 最后更新：0.3.0（PC）/ 0.2.8（手机）

---

## 0.3.0 性能改造（先读这一节）

0.3.0 不改变对外库格式，仍然是 `index.json + orig/<id>/ + prev/<id>/`；新增的是 PC 端运行时能力：

| 模块 | 作用 |
|---|---|
| `lib/vault.js` | 主进程常驻索引；每次修改只追加 `.avatarvault/journal.ndjson`，8 秒空闲/30 秒兜底合并成原子快照 `index.json`，并保留 `index.json.bak`；启动时按 `meta.lastSeq` 重放日志。 |
| `lib/thumbs.js` | 用 sharp 生成 micro 32 / grid320 / grid640 / detail1280 四档 WebP；原图不动；缓存放 `userData/thumb-cache`，默认上限 4GB；sharp 不可用时退回 Electron nativeImage。 |
| `lib/worker-pool.js` + `workers/heavy.js` | 入库解析/统计放到后台线程，最多 2 个并发，避免大包卡 UI。 |
| `src/virtual-grid.js` | 虚拟滚动：把卡片行/展开的堆叠打包成可计算高度的块，只挂可视区上下约 2 行的节点。 |
| `avthumb://` 协议 | 主进程按需生成/返回缩略图，带 ETag；`?v=orig` 返回原图，灯箱用原图。 |

IPC 也从“每次操作回整包 state”改成增量：`item:update` 返回 `{item}`，`item:batchUpdate` 返回 `{items}`，
`item:delete` 返回 `{removedId,collections}`，`cat:*` 返回 `{categories,patches}`，`collection:*` 返回 `{collections}`，
`stack:*` 返回 `{stacks}`。渲染层用 `applyResponse()` 合并到本地 state；`state:get` 仍只在启动/换库时全量拉一次。

批量交互：Shift 连选、Ctrl+A、Delete/Backspace、右键批量改类目/加标签/删除；服务端对应
`item:batchUpdate` / `item:batchDelete`。

兼容：`portable.importLibrary` 仍是原来的“按 id 去重、复制 orig/prev、重写相对路径、补 stats、合并类目/套装”；
0.3.0 的整库导出不会包含 `.avatarvault`，旧版程序也能读新备份。

---

## 一、这是什么

VRChat 改模素材库：把 `.unitypackage` / `.zip` 素材收进一个本地库，分类、看缩略图、打标签，
再**从库里直接拖进 Unity 的 Project 窗口**（Windows 上是 `CF_HDROP` 原生拖出，Unity 认）。

两端共用同一套库格式（`index.json + orig/ + prev/`），可以指向同一个库目录：

| 端 | 目录 | 栈 | 体积 |
|---|---|---|---|
| PC 正式版 | 根目录 `main.js` + `src/` + `lib/` | Electron 32 | 解压约 290MB |
| 手机端 | `mobile/` | 原生 Java + 系统 WebView | 37KB |

---

## 二、目录结构

```
AvatarVault/
├── main.js                 # Electron 主进程：窗口、IPC、库目录、导入导出、拖出
├── preload.js              # 暴露给渲染进程的 api（window.avApi）
├── src/{index.html,renderer.js,style.css}   # PC 界面
├── lib/
│   ├── store.js            # index.json 读写、类目规范化、条目结构（DEFAULT_CATEGORIES 在这）
│   ├── ingest.js           # 入库：hash → id、解析包、提预览图、分类
│   ├── classify.js         # 类目识别规则（两端同一套 RULES）
│   ├── unitypackage.js     # .unitypackage 流式解析（gunzip + tar）
│   ├── zip.js / zipwrite.js# zip 读/写
│   ├── tar.js / png.js     # tar 解析、PNG 处理
│   ├── portable.js         # 整库导出/导入（导入时合并类目、去重、重写路径）
│   ├── bundle.js           # 堆叠合并成 ZIP 合集卡 / 还原原卡（PC 端）
│   └── stacks.js           # 堆叠分组校验（程序配置持久化，不写 index.json）
├── scripts/
│   ├── pack.js             # 打 dist（注意 .gitignore 之外的 ignore 列表，漏了会把 build/ 打进去）
│   ├── make-ico.js / make-assets.js / pngwrite.js
│   ├── seed-demo.js        # 造样例库
│   ├── test-ingest.js / test-portable.js   # 自检脚本
│   └── test-bundle.js / test-stacks.js      # 合并卡 / 堆叠分组自检
├── mobile/
│   ├── AndroidManifest.xml # com.avatarvault.mobile, minSdk 24, target 33
│   ├── build-apk.sh        # 无 Gradle 构建：aapt2 + javac + d8 + zipalign + apksigner
│   ├── java/com/avatarvault/mobile/MainActivity.java
│   └── assets/app/{index.html,app.js,style.css}
├── assets/                 # 图标
├── build/                  # 本地构建与签名文件（.gitignore 排除密钥）
├── docs/BUILD.md           # Windows 桌面版构建
└── docs/ARCHITECTURE.md    # 本文
```

---

## 三、数据格式（两端必须一致）

`<库根>/index.json`：

```json
{
  "version": 1,
  "categories": [ { "key": "base", "name": "素体" }, ... ],
  "items": [ {
    "id": "a1b2c3d4e5f6",          // 文件 SHA-256 前 12 位，用于去重
    "name": "赛博外套 pack",
    "category": "cloth",           // 必须是 categories 里存在的 key
    "kind": "unitypackage",
    "refOnly": false,
    "originPath": "",              // 文件夹引用时的原路径
    "storedPath": "orig/<id>/xxx.unitypackage",
    "sizeBytes": 12345,
    "stats": { "assetCount": 3, "materials": 1, "fbx": 0, "textures": 1,
               "prefabs": 0, "animations": 0, "vramMB": 0.2 },
    "thumbs": [],                  // 包内自带预览图（**已按用户要求不显示**，字段保留）
    "customThumbs": ["custom_1.jpg"],  // 用户自己加的示意图，文件名，文件在 prev/<id>/
    "tags": ["JK"], "favorite": false, "notes": "",
    "addedAt": 1700000000000, "lastUsed": 0, "categorySource": "auto|manual|user",
    "bundledInto": "b...",        // 仅合并卡的原卡：指向合集卡 id；PC 端普通视图隐藏
    "bundle": {                   // 仅合集卡：成员 id/名称、原文件总大小、创建时间
      "version": 1, "memberIds": ["..."], "memberNames": ["..."],
      "sourceSizeBytes": 12345, "createdAt": 1700000000000
    }
  } ],
  "collections": [ { "id": "c...", "name": "套装名", "description": "用途/搭配说明",
                     "itemIds": ["..."], "createdAt": 1700000000000, "updatedAt": 1700000000000 } ]
}
```

目录：`orig/<id>/` 原件副本，`prev/<id>/` 只有用户示意图（`custom_<ts>.<ext>`）。

**套装模型（0.2.6 起）**：`itemIds` 的数组顺序就是套装顺序；`description` 随导出清单一起写；旧库只有 `id/name/itemIds` 也能直接加载。

**BOOTH 字段（0.2.6 起）**：`notes` 里的 `booth.pm/.../items/<id>` 由 `item:fetchBooth` 读取；
写入 `boothUrl`、`boothItemId`、`boothTitle`、`boothShop`、`boothCategory`、`boothThumb`、`boothImageUrl`。
首图存 `prev/<id>/booth_<itemId>.<ext>` 并放在 `customThumbs` 最前；`nameSource` 为 `auto/manual`，
`manual` 时商品名不覆盖用户改过的名称。抓取只允许 https://booth.pm 和 https://booth.pximg.net。

**堆叠 / 合并卡（0.2.8 起，PC only）**：
- 堆叠分组保存在程序配置 `%APPDATA%\AvatarVault\config.json` 的 `stacks`（按库根分键），
  不写 `index.json`；关闭/重启后仍在，点「解散堆叠」才清除。`expanded` 不持久，重启后默认折叠。
- 缓存里的失效分组（成员被删、改类目、已合并成合集卡）会在加载/渲染时丢弃。
- 创建条件：至少 2 张、同一 `category`、不是合并卡；跨类目禁用右键。
- 合并：`lib/bundle.js` 把成员原件写成一个 zip（`orig/<bundleId>/<name>.zip`，含 `合集说明.txt`），
  新建一条 `kind:"zip"` 的普通条目，带 `bundle` 元数据；成员原件与条目保留，只写 `bundledInto`。
- `bundle` 卡显存/材质/贴图/资产数按成员 `stats` 求和，`statsRepaired:true`；封面复制第一个成员的示意图。
- 合并卡右键 / 详情删除都走 `restoreBundle`：删除合并 zip 卡、清掉成员的 `bundledInto`，原卡恢复；
  原素材文件和条目不会被删除。`item:delete` 检测到 `bundle` 时也会自动还原，避免隐藏原卡变孤儿。
- 原卡只在「全部资产 / 类目」视图隐藏；进入套装视图时按套装成员照常显示。套装成员关系不改。
- 手机端不认识 `bundle` / `bundledInto`，PC 备份导到手机会看到原卡和合并卡两张；这是已知限制。

**路径字段（0.2.6 起）**：
- `storedPath` 统一存**相对库根**的路径，如 `orig/<id>/<file>`；整个库目录可以整体搬走/换盘。
- 旧库首次启动会把库内的绝对路径自动迁移成相对路径；路径失效时按 `orig/<id>/` 里的实际文件兜底。
- `originPath` 只对 `refOnly` 文件夹引用有意义（记录外部原目录），普通素材入库/导入时清空。

**类目模型（0.2.5 起）**：`categories` 是数据，不是常量。
- 新建：≤12 字，不许重名；key 形如 `u<base36>`。
- 删除：该类目下素材全部改成 `other`，文件不动；`other`（未分类）不可删。
- 排序：`categories` 数组顺序即显示顺序；`store.normalizeCategories()` 会把 `other` 强制排到最后。
- 导入合并（`lib/portable.js`）：备份里存在、本地没有的类目**自动补上**（重名则加「 2」后缀），
  素材保留原 `category` key，不会掉进未分类。这就是「手机新建类目 → 电脑导入」不丢的实现。
- 手机备份导入：`.unitypackage` / `.zip` 会由 PC 端重新解析，覆盖手机端的 `stats`
  （手机端 `.zip` 的 `vramMB` 恒为 0，`.unitypackage` 用的是压缩 asset 字节数）。
  补算成功后条目写 `statsRepaired: true`；旧库缺失统计的条目在详情页选中时自动补算，
  重复导入同一备份时也会补算已存在但统计缺失的条目。
- 导入兼容：zip 根目录 / 套 1~3 层文件夹、ZIP64（大库）、`./` 前缀；解压时按 Windows
  规则清洗非法文件名（`? * " < > |` 等），并把示意图文件名映射到清洗后的名字。

**分类规则**：`lib/classify.js` 的 RULES 关键词打分，`.mat` 占比 > 0.6 加 8 分，
最高分 ≥ 2 才归类，否则 `other`。key 固定为 `base/cloth/makeup/prop/material/other`，
自定义类目只能靠用户手动指定（自动分类永远落在上述六个里）。

---

## 四、构建

### 4.1 PC 正式版（Electron）

见 `docs/BUILD.md`。要点：

```bash
npm install            # 国内设 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm run pack:win       # 打 dist/AvatarVault-win32-x64
```

绿色版 zip = `dist/AvatarVault-win32-x64` 整个目录 + `使用说明.txt` + `手机端/`（最新 APK 与说明）。
`scripts/pack.js` 打包后会自动补上这两样；根目录散落的旧 APK 会被 ignore 列表挡在包外。

### 4.2 手机端（无 Gradle）

```bash
# JDK 17
curl -L "https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse?project=jdk" -o jdk.tgz && tar xzf jdk.tgz -C /tmp/andtools
# build-tools r34
curl -L -o bt.zip https://dl.google.com/android/repository/build-tools_r34-linux.zip && unzip -q bt.zip -d /tmp/andtools/android-14
# android.jar 替代品（platform-33 官方包 404，用 Robolectric 的 android-all）
curl -L -o /tmp/andtools/android-all.jar https://repo1.maven.org/maven2/org/robolectric/android-all/13-robolectric-9030017/android-all-13-robolectric-9030017.jar

bash mobile/build-apk.sh        # 产物 build/apk/AvatarVault-Mobile-<VER>.apk
```

脚本里 `JDK=...`、`BT=/tmp/andtools/android-14`、`AJAR=/tmp/andtools/android-all.jar`，
版本号在脚本顶部 `VER=` 和 `AndroidManifest.xml` 的 `versionCode/versionName` **两处都要改**
（aapt2 命令行传的 `--version-code` 会被 manifest 里的值覆盖，实测无效）。

签名文件由构建者自行准备，通过 `AV_KEYSTORE_PATH` / `AV_KEYSTORE_PASS` 环境变量传给 `mobile/build-apk.sh`，不要提交到仓库。**换签名 = 无法覆盖升级**，正式发布前请备份自己的 keystore。

手机端与 JS 的桥叫 `AV`（`MainActivity` 里的 `addJavascriptInterface`），
方法：`index/saveIndex/readChunk/imageData/fileSize/pickAssets/pickImage/deleteImage/removeItem/exportVault/moveToBack/toastMsg`。
注意 Android WebView **默认不实现 `window.confirm`**，全部改用自绘 `ask()`。

---

## 五、界面/交互约定（用户已确认的，别改回去）

- 示意图：每张右上角红色「×」，删前确认「移除这张示意图？\n原件不动。」
- 删素材：「删除「name」？\n原件和示意图一起删。」
- 删类目：素材移到「未分类」，文件不动；菜单里 `other` 不给删。
- 提示语一律短句（用户明确嫌啰嗦）：识别中… / 已入库 N / 已加示意图 / 已移除 / 库是空的 / 打包 N 个素材…
- **不显示 .unitypackage 自带的预览图**（`thumbs` 字段保留但不渲染），也没有开关。
- 库目录必须用户自己选（首次启动引导页），不要把库放进 exe 目录。
- 导入只增不覆盖：按 id 去重，已存在跳过。
- 布局：`.workspace`、`.center`、`.detail` 都要有 `min-height:0`，否则详情栏会把整行撑高、
  被窗口裁掉，并让网格失去滚动。素材区 `#grid` 和详情栏各自 `overflow-y:auto`。
- 显示方式：顶部 `#viewSwitch` 三档（大图/紧凑/列表），存 `localStorage` 的 `av:view`；
  列表模式必须把 `#grid` 的 display 切成 flex，不能只靠 class。

---

## 六、自检手段（没有 Windows 也能验证大半）

```bash
# 入库/导出逻辑
node scripts/test-ingest.js
node scripts/test-portable.js

# PC 界面（Linux 无头截图）
AV_LIB_ROOT=/tmp/demo xvfb-run -a electron .   # 需自己加 AV_SHOT 支持或用 capturePage

# 手机界面：Electron 里注入 mock 的 window.AV 跑真实 app.js
# 做法：生成 test.html，把 <script src="app.js"> 改成 mock.js + 绝对路径的 app.js，
# 再 new BrowserWindow 载入 → executeJavaScript 模拟点击/拖放 → capturePage 存 png
```

已验证过的关键结论：手机格式的库喂给桌面 `portable.importLibrary()`，分类/示意图/原件全保留、
`storedPath` 自动改写成新库的相对路径；手机新建类目 `ux9:配件` 导入后 `catAdded:["配件"]`，
素材 `category` 仍是 `ux9`。手机端 `stats.vramMB=0` 的 `.zip` 导入后会按 PC 解析器重算，
`scripts/test-mobile-import.js` 覆盖这条回归。

---

## 七、版本历史

| 版本 | 内容 |
|---|---|
| 0.2.1~0.2.3 | 桌面版雏形：五类目、缩略墙、搜索、套装、拖到 Unity、整库导出/导入、首次启动选库目录 |
| 0.2.3~0.2.6（手机） | 安卓端：WebView + AV 桥、自绘确认框、示意图单张删除、文案精简、导出 zip |
| 0.2.4（桌面） | 回灌手机端体验：示意图「×」、精简文案；出绿色版（109MB）+ 源码包 |
| 0.2.5 | 类目可增删（两端），导入时自动合并类目 |
| 0.2.6 | 类目可排序（拖动 + 上移/下移；手机长按菜单）；打包清理：PC 包只附最新手机端 APK，旧包不再混入 |
| 0.2.7（PC） | 堆叠（同类目多选右键、点击展开/收起）；合并为 ZIP 合集卡（原卡隐藏可还原）；PC-only |
| 0.2.8（PC） | 堆叠改为按库目录持久保存（程序配置，不写 index.json）；解散才消失 |

---

## 八、已知限制 / 待办

- PC 版打包在 Linux 上不能写 exe 图标/版本信息（要 `rcedit`，只能在 Windows 跑）。
- 单文件 NSIS 便携 exe 方案已放弃（用户明确不要）。
- 未签名：首次运行会被 SmartScreen 拦，属正常。
- 堆叠分组只存在程序配置，不随库备份/换电脑迁移；合并卡仅 PC 端，手机端不识别 `bundledInto` / `bundle`，双向导备份可能显示原卡+合并卡。
