# TOOLS.md — 工具链清单

> 这里只列“用到什么、怎么装”，不把二进制工具打进源码包。  
> `package.json` / `package-lock.json` 已经锁定 npm 依赖，下面的系统工具需要单独准备。

## 桌面端

| 工具 | 版本 / 说明 | 用途 |
|---|---|---|
| Node.js | 20 或 22 LTS（推荐 22） | 跑主进程、测试、打包脚本 |
| npm | 10+ | 安装依赖 |
| Electron | `^32.2.6`（见 `package.json`） | 桌面运行时 |
| @electron/packager | `^18.3.6` | 生成 Windows 绿色版目录 |
| Electron Builder | `^25.1.8` | 可选，打 NSIS 安装包 |
| Windows 10/11 x64 | 最终打包建议在 Windows 上做 | `rcedit` 写 exe 图标/版本信息 |

```bash
npm ci
npm start
npm run pack:win-icon
```

国内下载 Electron 慢时可以设镜像：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm ci
```

## UI 验证（可选，不是运行时依赖）

- Playwright（Python 或 Node 版均可）
- Chromium / Chrome

只用于无头加载 `src/index.html`，检查布局、滚动、三档显示方式。  
项目本身不需要 Playwright；不要把它加进 `package.json` 的运行依赖。

## 手机端构建

| 工具 | 说明 |
|---|---|
| JDK 17 | 编译 Java |
| Android SDK build-tools | `aapt2` / `d8` / `zipalign` / `apksigner` |
| `android-all.jar` | `javac` / `d8` 的 classpath |
| Python 3 | `build-apk.sh` 往 APK 里写 `classes.dex` |

`mobile/build-apk.sh` 默认从 `$HOME/andtools` 找 SDK：

```bash
export ANDROID_SDK="$HOME/andtools"
# 或显式传：ANDROID_SDK=/path/to/android-sdk bash mobile/build-apk.sh
```

目录里需要有 `android-*`、`jdk-17*`、`android-all.jar`。换机器时改 `ANDROID_SDK`，或把 SDK 放到脚本能找到的位置。签名密钥和密码通过 `AV_KEYSTORE_PATH` / `AV_KEYSTORE_PASS` 环境变量提供，不要提交到仓库。

## 打包 / 校验

- `zip` / `unzip`：打 PC 包、源码包、发布包；`unzip -t` 做完整性检查。
- 7-Zip / Windows 资源管理器：用户侧解压；不是开发必需。

## 不需要放进源码包的东西

- `node_modules/`：`npm ci` 恢复。
- `dist/`、`release/`：打包产物。
- `_demo-library/`：`npm run seed-demo` 可重新生成。
- Electron / Chromium / Android SDK 二进制：平台相关、体积大，写清单即可。

## 网络

- 程序运行只需要访问 BOOTH：`https://booth.pm` 和 `https://booth.pximg.net`。
- 构建依赖下载走 npm / Electron 镜像；不把运行时数据上传到任何服务器。
