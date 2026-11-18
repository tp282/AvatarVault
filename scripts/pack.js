'use strict';
// 打包脚本：跨平台可用；在 Windows 上会自动写入图标和版本信息
// 用法：node scripts/pack.js [--with-icon] [--asar]
const path = require('path');
const fs = require('fs');
const packager = require('@electron/packager');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const withIcon = args.includes('--with-icon') || process.platform === 'win32';
const asar = args.includes('--asar');

/** 按文件名里的版本号排序，返回最新的手机端 APK */
function findLatestApk() {
  const dirs = [
    path.join(ROOT, '手机端'),
    ROOT,
    path.join(ROOT, 'build', 'apk'),
    path.join(ROOT, 'mobile', 'build', 'apk'),
  ];
  const list = [];
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { continue; }
    for (const n of names) {
      if (/^AvatarVault-Mobile-[^/]*\.apk$/i.test(n)) list.push(path.join(dir, n));
    }
  }
  const ver = (p) => {
    const m = path.basename(p).match(/(\d+)\.(\d+)\.(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
  };
  list.sort((a, b) => {
    const va = ver(a); const vb = ver(b);
    return (va[0] - vb[0]) || (va[1] - vb[1]) || (va[2] - vb[2]);
  });
  return list[list.length - 1] || null;
}

/** 打包后补装：使用说明放到 exe 同层，手机端 APK 放进「手机端」文件夹 */
function copyExtras(appPath) {
  const apk = findLatestApk();
  if (apk) {
    const dstDir = path.join(appPath, '手机端');
    fs.mkdirSync(dstDir, { recursive: true });
    fs.copyFileSync(apk, path.join(dstDir, path.basename(apk)));
    console.log('附带手机端 APK：', path.basename(apk));
    const readme = path.join(ROOT, '手机端说明.txt');
    if (fs.existsSync(readme)) fs.copyFileSync(readme, path.join(dstDir, '手机端说明.txt'));
  }
  const guide = path.join(ROOT, '使用说明.txt');
  if (fs.existsSync(guide)) fs.copyFileSync(guide, path.join(appPath, '使用说明.txt'));
}

const ignore = [
  /^\/dist/,
  /^\/release/,
  /^\/build/,
  /\.exe$/,
  /\.zip$/,
  /^\/手机端-/,
  /^\/手机端\//,
  /^\/AvatarVault-Mobile-[^/]*\.apk/,
  /\.apk$/i,
  /^\/手机端说明\.txt/,
  /^\/界面预览/,
  /^\/mobile/,
  /^\/scripts/,
  /^\/\.git/,
  /^\/\.sessions/,
  /\.zip$/,
  /^\/界面预览\.png/,
  /^\/使用说明\.txt/,
  /^\/README\.md/,
  /^\/BUILD\.md/,
  /^\/_demo-library/,
  /^\/package-lock\.json$/,
];

(async () => {
  const out = path.join(ROOT, 'dist');
  const opts = {
    dir: ROOT,
    name: 'AvatarVault',
    platform: 'win32',
    arch: 'x64',
    out,
    overwrite: true,
    ignore,
    asar,
    prune: true,
    appVersion: require(path.join(ROOT, 'package.json')).version,
  };

  if (withIcon) {
    const ico = path.join(ROOT, 'assets', 'icon.ico');
    if (fs.existsSync(ico)) {
      opts.icon = ico;
      opts.win32metadata = {
        CompanyName: 'AvatarVault',
        ProductName: 'AvatarVault',
        FileDescription: 'VRChat 改模素材库',
        InternalName: 'AvatarVault',
        OriginalFilename: 'AvatarVault.exe',
      };
    } else {
      console.warn('没找到 assets/icon.ico，跳过图标写入（先跑 node scripts/make-ico.js）');
    }
  }

  const appPaths = await packager(opts);
  for (const p of appPaths) copyExtras(p);
  // 目标平台是 Windows，Linux 的 sharp/libvips 预编译包不需要，直接裁掉
  if (opts.platform === 'win32') {
    for (const p of appPaths) {
      const imgRoot = path.join(p, 'resources', 'app', 'node_modules', '@img');
      for (const name of ['sharp-linux-x64', 'sharp-libvips-linux-x64', 'sharp-linux-arm64', 'sharp-libvips-linux-arm64']) {
        try { fs.rmSync(path.join(imgRoot, name), { recursive: true, force: true }); } catch (_) {}
      }
    }
  }
  console.log('打包完成：', appPaths.join('\n'));
  console.log('\n提示：在 Windows 上打包才能写入 .exe 的图标与版本信息（需要 rcedit）。');
  console.log('打包产物未签名，首次运行会被 SmartScreen 拦；签名见 docs/BUILD.md。');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
