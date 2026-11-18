# 第三方声明

AvatarVault 以 MIT License 发布。运行时和构建依赖由各自的许可证授权，下面只列主要的直接依赖；完整依赖树见 `package-lock.json`。

| 依赖 | 用途 | 许可证 |
|---|---|---|
| [Electron](https://www.electronjs.org/) | 桌面运行时 | MIT |
| [sharp](https://github.com/lovell/sharp) | WebP 缩略图生成 | Apache-2.0 |
| [@electron/packager](https://github.com/electron/packager) | Windows 绿色版打包 | MIT |
| [electron-builder](https://www.electron.build/) | 可选安装包构建 | MIT |
| [libvips](https://libvips.github.io/libvips/)（sharp 预编译包内置） | 图像处理底层库 | LGPL-2.1-or-later |

发布二进制时请随包保留 Electron / Chromium 的 `LICENSE` 与 `LICENSES.chromium.html`；`scripts/pack.js` 默认会把它们带进 `dist`。如果你替换图标、字体、示例素材或新增依赖，请自行确认授权并更新本文件。

VRChat、Unity、BOOTH、Pixiv 是其各自权利人的商标或产品名称。本项目与它们没有隶属或官方授权关系。
