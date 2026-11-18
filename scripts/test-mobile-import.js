'use strict';
// 回归：手机备份里的 .zip 素材 stats.vramMB=0，PC 导入后要按原件重算
const fs = require('fs');
const path = require('path');
const os = require('os');
const { encodePNG } = require('./pngwrite');
const { writeStoreZip } = require('../lib/zipwrite');
const { importLibrary } = require('../lib/portable');
const { loadIndex } = require('../lib/store');

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'avmobile-'));
  const src = path.join(work, 'src');
  const target = path.join(work, 'target');
  const orig = path.join(src, 'orig', 'm1');
  fs.mkdirSync(orig, { recursive: true });
  fs.mkdirSync(target, { recursive: true });

  const pngPath = path.join(work, 'tex.png');
  fs.writeFileSync(pngPath, encodePNG(256, 256, () => [220, 120, 150, 255]));
  const matPath = path.join(work, 'body.mat');
  const prefabPath = path.join(work, 'body.prefab');
  fs.writeFileSync(matPath, '%YAML 1.1\n');
  fs.writeFileSync(prefabPath, '%YAML 1.1\n');
  const pack = path.join(orig, 'pack.zip');
  await writeStoreZip(pack, [
    { name: 'Assets/tex.png', absPath: pngPath, size: fs.statSync(pngPath).size },
    { name: 'Assets/body.mat', absPath: matPath, size: fs.statSync(matPath).size },
    { name: 'Assets/body.prefab', absPath: prefabPath, size: fs.statSync(prefabPath).size },
  ]);

  const index = {
    version: 1,
    items: [{
      id: 'm1', hash: '', name: '手机 zip 素材', category: 'cloth', kind: 'zip',
      refOnly: false, originPath: '', storedPath: 'orig/m1/pack.zip', sizeBytes: 1,
      // 模拟手机端：只按文件名计数，.zip 的显存恒为 0
      stats: { assetCount: 3, materials: 1, fbx: 0, textures: 1, prefabs: 1, animations: 0, vramMB: 0 },
      thumbs: [], customThumbs: [], tags: [], favorite: false, notes: '',
      addedAt: Date.now(), lastUsed: 0, categorySource: 'auto',
    }],
    collections: [],
    categories: [{ key: 'cloth', name: '服装' }, { key: 'other', name: '未分类' }],
  };
  fs.writeFileSync(path.join(src, 'index.json'), JSON.stringify(index, null, 2));

  const res = await importLibrary(target, src, {});
  const out = await loadIndex(target);
  const item = out.items[0];
  const ok = res.added.length === 1 && item && item.stats && item.stats.vramMB > 0 && item.statsRepaired === true;
  console.log(JSON.stringify({
    added: res.added.length,
    failed: res.failed,
    vramMB: item && item.stats && item.stats.vramMB,
    statsRepaired: item && item.statsRepaired,
  }, null, 2));
  console.log('test-mobile-import:', ok ? '通过' : '失败');
  if (!ok) process.exit(1);
  console.log('工作目录:', work);
})().catch((e) => { console.error(e); process.exit(1); });
