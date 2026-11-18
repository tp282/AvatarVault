'use strict';
// 0.3.0 回归：内存索引/日志重放、四档缩略图、worker 入库、整库往返、旧版备份兼容
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const assert = require('assert');

const store = require('../lib/store');
const { Vault } = require('../lib/vault');
const { createPool } = require('../lib/worker-pool');
const thumbs = require('../lib/thumbs');
const portable = require('../lib/portable');
const { extractZipAll, listZipNames } = require('../lib/zip');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'av030-'));
const userData = path.join(work, 'userdata');

async function blank(dir) {
  await fsp.mkdir(path.join(dir, 'orig'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'prev'), { recursive: true });
  return dir;
}

(async () => {
  assert(thumbs.hasSharp(), '测试环境需要 sharp');
  const srcDir = path.join(work, 'src');
  await fsp.mkdir(srcDir, { recursive: true });
  const sharp = require('sharp');
  for (let i = 0; i < 3; i++) {
    await sharp({ create: { width: 640 + i * 40, height: 640, channels: 4, background: { r: 20 + i * 40, g: 180, b: 200, alpha: 1 } } })
      .png().toFile(path.join(srcDir, `sample-${i}.png`));
  }

  const root = await blank(path.join(work, 'lib'));
  const v1 = new Vault({ snapshotDebounceMs: 999999, snapshotMaxMs: 999999 });
  await v1.open(root);
  const pool = createPool(2);

  for (let i = 0; i < 3; i++) {
    const entry = await pool.run('ingest', { root, srcPath: path.join(srcDir, `sample-${i}.png`) });
    v1.index.items.unshift(entry);
    v1.record([{ op: 'item:set', item: entry }]);
  }
  assert.equal(v1.index.items.length, 3);
  assert(v1.index.items.every((it) => !path.isAbsolute(it.storedPath)), '入库应写相对路径');
  console.log('✓ worker 入库 / 相对路径');

  // 自定义示意图：模拟用户加图
  const first = v1.index.items[0];
  await fsp.cp(path.join(srcDir, 'sample-0.png'), path.join(root, 'prev', first.id, 'custom_1.png'));
  first.customThumbs = ['custom_1.png'];
  v1.record([{ op: 'item:set', item: first }]);

  for (const v of ['micro', 'grid320', 'grid640', 'detail']) {
    const r = await thumbs.ensureVariant(path.join(root, 'prev', first.id, 'custom_1.png'), {
      root, userData, id: first.id, name: 'custom_1.png',
    }, v);
    const st = await fsp.stat(r.file);
    assert(st.size > 0, `${v} 缩略图应生成`);
  }
  console.log('✓ 四档 WebP 缩略图');

  // 日志重放：v1 未 flush，v2 打开同一库应能读到最后一次改名
  first.name = '日志里的名字';
  v1.record([{ op: 'item:set', item: first }]);
  await new Promise((r) => setTimeout(r, 60));
  const v2 = new Vault({ snapshotDebounceMs: 999999, snapshotMaxMs: 999999 });
  await v2.open(root);
  assert.equal(v2.index.items[0].name, '日志里的名字', '日志应被重放');
  console.log('✓ 追加日志重放');

  await v1.flush();
  const v3 = new Vault();
  await v3.open(root);
  assert.equal(v3.index.items[0].name, '日志里的名字', '快照应保留改名');
  assert(fs.existsSync(path.join(root, '.avatarvault', 'meta.json')), 'meta.json 应存在');
  assert(!fs.existsSync(path.join(root, '.avatarvault', 'journal.ndjson')), '快照后日志应被清掉');
  console.log('✓ 快照 / meta / 日志截断');
  await v3.close();

  // 整库 zip 往返
  const exp = await portable.exportLibrary(root, path.join(work, 'backup'), { asZip: true, index: v1.index });
  assert(exp.ok && exp.isZip, '应导出 zip');
  const names = await listZipNames(exp.dest);
  assert(!names.some((n) => n.startsWith('.avatarvault/')), '备份不应包含 .avatarvault');
  const unpack = path.join(work, 'unpack');
  await fsp.mkdir(unpack, { recursive: true });
  await extractZipAll(exp.dest, unpack);
  const target = await blank(path.join(work, 'target'));
  const v4 = new Vault();
  await v4.open(target);
  const imp = await portable.importLibrary(target, unpack, { index: v4.index });
  await v4.replace(v4.index);
  assert.equal(imp.added.length, 3, '整库往返应导入 3 条');
  assert(v4.index.items.every((it) => fs.existsSync(path.join(target, it.storedPath))), '导入后相对路径应存在');
  console.log('✓ 整库导出 → 导入往返');

  // 旧版备份：绝对 storedPath、无 stats、自定义示意图、旧 collections
  const oldSrc = path.join(work, 'old-src');
  const oldId = 'old123456';
  await fsp.mkdir(path.join(oldSrc, 'orig', oldId), { recursive: true });
  await fsp.mkdir(path.join(oldSrc, 'prev', oldId), { recursive: true });
  await fsp.cp(path.join(srcDir, 'sample-1.png'), path.join(oldSrc, 'orig', oldId, '旧素材.png'));
  await fsp.cp(path.join(srcDir, 'sample-0.png'), path.join(oldSrc, 'prev', oldId, 'old_thumb.png'));
  await fsp.writeFile(path.join(oldSrc, 'index.json'), JSON.stringify({
    version: 1,
    items: [{
      id: oldId,
      name: '旧版素材',
      category: 'other',
      kind: 'file',
      storedPath: path.join(oldSrc, 'orig', oldId, '旧素材.png'), // 旧版可能存绝对路径
      originPath: '',
      customThumbs: ['old_thumb.png'],
      thumbs: [],
      addedAt: Date.now(),
    }],
    collections: [{ id: 'cold', name: '旧套装', description: '', itemIds: [oldId] }],
    categories: [{ key: 'uold', name: '旧类目' }],
  }, null, 2));

  const oldTarget = await blank(path.join(work, 'old-target'));
  const v5 = new Vault();
  await v5.open(oldTarget);
  const oldImp = await portable.importLibrary(oldTarget, oldSrc, { index: v5.index });
  await v5.replace(v5.index);
  assert.equal(oldImp.added.length, 1, '旧备份应导入');
  const oldEntry = v5.index.items[0];
  assert.equal(oldEntry.storedPath, `orig/${oldId}/旧素材.png`, '绝对路径应重写为相对路径');
  assert(fs.existsSync(path.join(oldTarget, oldEntry.storedPath)), '旧备份原件应复制进来');
  assert(oldEntry.customThumbs.includes('old_thumb.png'), '旧示意图应保留');
  assert(v5.index.collections.some((c) => c.name === '旧套装'), '旧套装应合并');
  assert(v5.index.categories.some((c) => c.name === '旧类目'), '旧类目应合并');
  console.log('✓ 0.2.8 旧备份兼容（绝对路径 / 无 stats / 旧示意图 / 类目 / 套装）');

  await v1.close();
  await v2.close();
  await v4.close();
  await v5.close();
  await pool.close();
  console.log('\n0.3.0 回归全部通过');
  console.log('工作目录:', work);
})().catch(async (err) => {
  console.error(err);
  process.exitCode = 1;
});
