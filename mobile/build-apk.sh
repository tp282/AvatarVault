#!/bin/bash
# 构建 AvatarVault 手机端 APK（无需 Gradle，直接调 aapt2 / javac / d8 / apksigner）
set -e

SDK=${ANDROID_SDK:-$HOME/andtools}
BT=$(ls -d "$SDK"/android-* | head -1)
JDK=$(ls -d "$SDK"/jdk-17* | head -1)
AJAR=$SDK/android-all.jar
PROJ=$(cd "$(dirname "$0")/.." && pwd)
OUT=${OUT_DIR:-$PROJ/build/apk}
KEYSTORE=${AV_KEYSTORE_PATH:-$PROJ/build/avatarvault.keystore}
KS_ALIAS=${AV_KEYSTORE_ALIAS:-avatarvault}
VER=${AV_VERSION:-0.2.8}
VER_CODE=${AV_VERSION_CODE:-6}

export PATH=$JDK/bin:$PATH

rm -rf "$OUT" && mkdir -p "$OUT/compiled" "$OUT/classes" "$OUT/dex" "$OUT/gen"

echo "== 1/6 编译资源 =="
"$BT/aapt2" compile --dir "$PROJ/mobile/res" -o "$OUT/compiled/res.zip"

echo "== 2/6 链接资源 + manifest =="
"$BT/aapt2" link \
  -o "$OUT/base.apk" \
  -I "$AJAR" \
  --manifest "$PROJ/mobile/AndroidManifest.xml" \
  -A "$PROJ/mobile/assets" \
  --java "$OUT/gen" \
  --min-sdk-version 24 \
  --target-sdk-version 33 \
  --version-code "$VER_CODE" --version-name "$VER" \
  "$OUT/compiled/res.zip"

echo "== 3/6 编译 Java =="
find "$PROJ/mobile/java" -name "*.java" > "$OUT/sources.txt"
javac -source 8 -target 8 -encoding UTF-8 \
  -classpath "$AJAR" -d "$OUT/classes" @"$OUT/sources.txt" 2>&1 | grep -v "^warning: \[options\]" || true

echo "== 4/6 dex =="
"$BT/d8" --release --min-api 24 --lib "$AJAR" --output "$OUT/dex" $(find "$OUT/classes" -name "*.class")

echo "== 5/6 组装 APK =="
cp "$OUT/base.apk" "$OUT/unsigned.apk"
python3 - "$OUT/unsigned.apk" "$OUT/dex/classes.dex" <<'PY'
import sys, zipfile
apk, dex = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(apk, 'a', zipfile.ZIP_DEFLATED) as z:
    z.write(dex, 'classes.dex')
print('classes.dex 已写入')
PY

"$BT/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

echo "== 6/6 签名 =="
if [ -z "${AV_KEYSTORE_PASS:-}" ]; then
  echo "缺少 AV_KEYSTORE_PASS。请先导出签名密码，或设置 AV_KEYSTORE_PATH 指向自己的 keystore。" >&2
  exit 1
fi
if [ ! -f "$KEYSTORE" ]; then
  mkdir -p "$(dirname "$KEYSTORE")"
  keytool -genkeypair -keystore "$KEYSTORE" -alias "$KS_ALIAS" -keyalg RSA -keysize 2048 \
    -validity 10000 -storepass "$AV_KEYSTORE_PASS" -keypass "$AV_KEYSTORE_PASS" \
    -dname "${AV_KEYSTORE_DNAME:-CN=AvatarVault, OU=Mobile, O=AvatarVault, C=CN}" >/dev/null 2>&1
  echo "已生成本地开发密钥：$KEYSTORE（请备份，正式发布不要更换）"
fi
# apksigner 用 env: 读取密码，避免密码出现在进程命令行
export AV_KEYSTORE_PASS
"$BT/apksigner" sign --ks "$KEYSTORE" --ks-key-alias "$KS_ALIAS" \
  --ks-pass "env:AV_KEYSTORE_PASS" --key-pass "env:AV_KEYSTORE_PASS" \
  --out "$OUT/AvatarVault-Mobile-${VER}.apk" "$OUT/aligned.apk"
"$BT/apksigner" verify --print-certs "$OUT/AvatarVault-Mobile-${VER}.apk" | head -3

ls -lh "$OUT/AvatarVault-Mobile-${VER}.apk"
