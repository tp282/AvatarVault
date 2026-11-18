# 安全策略

## 报告漏洞

请不要在公开 issue 中发布可利用细节、用户素材、密钥或个人信息。优先使用 GitHub 的 **Security Advisories / Private vulnerability reporting**；如果仓库尚未开启该功能，请通过维护者公开资料中的私密联系方式联系，并在主题中注明 `AvatarVault security`。

报告时请尽量提供：

- 受影响版本和操作系统；
- 复现步骤、最小样例和影响范围；
- 是否涉及路径穿越、任意文件读写、备份导入、BOOTH 抓取或 WebView 注入。

## 范围

重点关注：

- 备份导入 / ZIP 解压的路径穿越和文件名清洗；
- `storedPath` / `originPath` 的路径重写与文件访问边界；
- Electron `contextIsolation` / `nodeIntegration` / 外部链接白名单；
- 手机端 WebView 的 `addJavascriptInterface` 暴露面；
- 任意 URL 抓取、命令注入和恶意包解析导致的资源耗尽。

## 密钥与签名

**仓库不包含任何签名密钥。** `build/*.keystore`、`*.jks`、`*.p12`、`*.pem`、`*.key` 和 `.env*` 已在 `.gitignore` 中排除。

手机端构建使用环境变量：

```bash
export AV_KEYSTORE_PATH=/absolute/path/to/avatarvault.keystore
export AV_KEYSTORE_PASS='your-local-password'
export AV_KEYSTORE_ALIAS=avatarvault
bash mobile/build-apk.sh
```

不要把 keystore 或密码写进脚本、文档、CI 日志或 issue。签名密钥一旦泄露，别人可以用同一个包名签出可覆盖安装的 APK；届时只能更换新密钥，老用户需要卸载重装。

## 用户数据

`index.json`、`orig/`、`prev/`、`exports/`、`.avatarvault/` 和缩略图缓存都可能包含用户素材、备注、示意图、BOOTH 链接等私人数据。提交 PR 或分享复现包前，请先确认这些内容没有被打进仓库或附件。
