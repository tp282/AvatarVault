'use strict';
// 合并 ZIP 卡回归：不依赖 Electron，直接测 lib/bundle.js + store。
const assert = require('assert');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { listZipNames } = require('../lib/zip');
const store = require('../lib/store');
const bundle = require('../lib/bundle');

async function mkItem(root, index, id, name, category, body) {
  const dir = path.join(root, 'orig', id);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, name.replace(/[\\/:*?"<>|]/g, '_'));
  await fsp.writeFile(file, body, 'utf8');
  const entry = {
    id,
    name,
    category,
    kind: 'file',
    storedPath: `orig/${id}/${path.basename(file)}`,
    sizeBytes: Buffer.byteLength(body),
    addedAt: Date.now(),
    stats: { assetCount: 2, materials: 1, textures: 3, prefabs: 0, vramMB: 12.5 },
    customThumbs: [],
  };
  index.items.push(entry);
  return entry;
}

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'av-bundle-'));
  try {
    const index = store.EMPTY_INDEX();
    const a = await mkItem(root, index, 'a1', '系列A 上衣', 'cloth', 'A');
    const b = await mkItem(root, index, 'b1', '系列A 裙子', 'cloth', 'B');

    // 不同类目拒绝
    const c = await mkItem(root, index, 'c1', '系列B 道具', 'prop', 'C');
    const mixed = await bundle.createBundle(root, index, { itemIds: ['a1', 'c1'] });
    assert.strictEqual(mixed.ok, false);
    assert.match(mixed.message, /同一类目/);

    // 单张拒绝
    const one = await bundle.createBundle(root, index, { itemIds: ['a1'] });
    assert.strictEqual(one.ok, false);

    // 正常合并
    const made = await bundle.createBundle(root, index, { itemIds: ['a1', 'b1'] });
    assert.strictEqual(made.ok, true);
    assert.strictEqual(made.memberCount, 2);
    const bundleEntry = index.items.find((it) => it.id === made.bundleId);
    assert(bundleEntry, '合并卡应写入 index');
    assert.strictEqual(bundleEntry.category, 'cloth');
    assert.strictEqual(bundleEntry.kind, 'zip');
    assert.strictEqual(bundleEntry.stats.vramMB, 25);
    assert.strictEqual(bundleEntry.stats.assetCount, 4);
    assert.deepStrictEqual(bundleEntry.bundle.memberIds.sort(), ['a1', 'b1']);
    assert.strictEqual(a.bundledInto, made.bundleId);
    assert.strictEqual(b.bundledInto, made.bundleId);
    assert.strictEqual(path.isAbsolute(bundleEntry.storedPath), false);

    const zipPath = path.join(root, bundleEntry.storedPath);
    await fsp.access(zipPath);
    const names = await listZipNames(zipPath);
    assert(names.some((n) => n.includes('01_系列A 上衣')), names.join('\n'));
    assert(names.some((n) => n.includes('02_系列A 裙子')), names.join('\n'));
    assert(names.some((n) => n.includes('合集说明.txt')), names.join('\n'));

    // 还原
    const restored = await bundle.restoreBundle(root, index, made.bundleId);
    assert.strictEqual(restored.ok, true);
    assert.strictEqual(restored.restored, 2);
    assert.strictEqual(index.items.some((it) => it.id === made.bundleId), false);
    assert.strictEqual(a.bundledInto, undefined);
    assert.strictEqual(b.bundledInto, undefined);
    await assert.rejects(fsp.access(zipPath));

    console.log('test-bundle: PASS');
    console.log(`  合并卡：${made.bundleId} / ${made.memberCount} 个成员 / ${bundleEntry.sizeBytes} 字节`);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('test-bundle: FAIL');
  console.error(err);
  process.exit(1);
});
