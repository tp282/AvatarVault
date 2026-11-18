# 手机端构建

手机端是一个原生 Java + 系统 WebView 的轻量 App，不依赖 Gradle。它和桌面端共用 `index.json + orig/ + prev/` 库格式。

## 依赖

- JDK 17
- Android SDK build-tools：`aapt2` / `d8` / `zipalign` / `apksigner`
- Robolectric `android-all.jar`（作为 `javac` / `d8` 的 classpath）
- Python 3（把 `classes.dex` 写进 APK）

`mobile/build-apk.sh` 默认从 `$HOME/andtools` 查找 SDK：

```bash
export ANDROID_SDK="$HOME/andtools"
# 目录结构示例：
#   $ANDROID_SDK/android-14/{aapt2,d8,zipalign,apksigner}
#   $ANDROID_SDK/jdk-17*/bin/{java,javac,keytool}
#   $ANDROID_SDK/android-all.jar
```

## 签名密钥

**不要把 keystore 或密码提交到仓库。** 本地构建时用环境变量：

```bash
export AV_KEYSTORE_PATH="$HOME/.android/avatarvault-release.keystore"
export AV_KEYSTORE_PASS='your-local-password'
export AV_KEYSTORE_ALIAS=avatarvault
bash mobile/build-apk.sh
```

如果 keystore 不存在，脚本会在 `AV_KEYSTORE_PATH` 指定的位置生成一把新的本地开发密钥（需要 `AV_KEYSTORE_PASS`）。正式发布请自己备份这把密钥：换签名后旧版 APK 无法覆盖升级。

版本号需要同时改两处：

- `mobile/build-apk.sh` 顶部 `VER=`（或通过 `AV_VERSION` 覆盖）
- `mobile/AndroidManifest.xml` 的 `versionCode` / `versionName`

`aapt2` 命令行传的 `--version-code` 会被 manifest 里的值覆盖。

## 构建命令

```bash
bash mobile/build-apk.sh
# 产物：build/apk/AvatarVault-Mobile-<VER>.apk
```

`build/apk/` 已在 `.gitignore` 中排除。

## WebView 桥

手机端与 JS 的桥叫 `AV`（`MainActivity` 里的 `addJavascriptInterface`），方法包括：

`index / saveIndex / readChunk / imageData / fileSize / pickAssets / pickImage / deleteImage / removeItem / exportVault / moveToBack / toastMsg`

注意 Android WebView **默认不实现 `window.confirm`**，所有确认框使用自绘的 `ask()`。

## 数据位置

- 库在应用私有目录 `files/vault`。
- 卸载 App 会删除 `files/vault`；重要素材先「导出给电脑」。
- 手机端不联网、不上传数据；`.zip` 的 `stats.vramMB` 恒为 0，导入桌面端后会重新计算。
