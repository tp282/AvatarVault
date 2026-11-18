'use strict';
// 验证 整库导出 → 导入到新库 的往返
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exportLibrary, importLibrary } = require('../lib/portable');
const { loadIndex } = require('../lib/store');

(async () => {
  const src = process.argv[2] || path.join(os.tmpdir(), 'avdemo');
  if (!fs.existsSync(path.join(src, 'index.json'))) {
    if (process.argv[2]) {
      console.error(`样例库不存在：${src}\\n请先运行 npm run seed-demo，或传一个已有库目录。`);
      process.exit(1);
    }
    console.log('未找到默认样例库，先用 seed-demo 生成……');
    require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'seed-demo.js'), src], { stdio: 'inherit' });
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'avport-'));
  const target = path.join(work, 'newlib');
  fs.mkdirSync(target, { recursive: true });

  const exp = await exportLibrary(src, work, { asZip: true });
  console.log('导出:', { dest: exp.dest, isZip: exp.isZip, entries: exp.entryCount, MB: (exp.sizeBytes / 1048576).toFixed(2) });

  // 解压
  const { extractZipAll } = require('../lib/zip');
  const unpack = path.join(work, 'unpack');
  fs.mkdirSync(unpack, { recursive: true });
  await extractZipAll(exp.dest, unpack);

  const res = await importLibrary(target, unpack, {});
  console.log('导入:', { added: res.added.length, skipped: res.skipped.length, failed: res.failed.length });

  const idx = await loadIndex(target);
  console.log('目标库条目:', idx.items.length, '套装:', idx.collections.length);
  for (const it of idx.items.slice(0, 4)) {
    const abs = path.isAbsolute(it.storedPath || '') ? it.storedPath : path.join(target, it.storedPath || '');
    console.log(' -', it.name, '|', it.category, '| storedPath 存在:',
      it.refOnly ? '(引用)' : fs.existsSync(abs),
      '| thumbs:', (it.thumbs || []).length, '| custom:', (it.customThumbs || []).length);
    if (!it.refOnly) {
      const rel = path.relative(target, abs);
      if (rel.startsWith('..')) console.log('   !! 路径没有重写', it.storedPath);
    }
  }
  console.log('\n工作目录:', work);
})();
