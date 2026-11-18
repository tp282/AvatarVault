'use strict';
// 临时堆叠的持久化形态：把若干同类目素材打成一个 zip，变成一张“合集卡”。
// 原素材不删除，只在 index.json 里标记 bundledInto；右键还原时恢复。
const fsp = require('fs/promises');
const path = require('path');
const { writeStoreZip } = require('./zipwrite');
const { saveIndex, removeEntryFiles } = require('./store');

const MAX_ZIP_BYTES = 3.9 * 1024 * 1024 * 1024;

function pad2(n) { return String(n).padStart(2, '0'); }

function safeName(s, max = 60) {
  return String(s || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max) || '未命名';
}

function isBundle(entry) {
  return !!(entry && entry.bundle && Array.isArray(entry.bundle.memberIds));
}

function bundleId() {
  return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** 只接受库内相对 storedPath 或旧库绝对路径；返回可读的绝对路径。 */
function resolveStored(root, entry) {
  const p = String((entry && entry.storedPath) || '');
  if (!p) return '';
  if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || path.isAbsolute(p)) return p;
  return path.join(root, p);
}

function sumStat(members, key) {
  return members.reduce((n, it) => n + (Number(it.stats && it.stats[key]) || 0), 0);
}

async function copyFirstThumb(root, id, first) {
  const name = (first.customThumbs || []).find(Boolean);
  if (!name) return '';
  const src = path.join(root, 'prev', first.id, path.basename(name));
  const dstDir = path.join(root, 'prev', id);
  const dstName = path.basename(name);
  try {
    await fsp.mkdir(dstDir, { recursive: true });
    await fsp.copyFile(src, path.join(dstDir, dstName));
    return dstName;
  } catch (_) {
    return '';
  }
}

/**
 * 把选中的条目合并成一个 zip 素材卡。
 * @param {string} root 库根
 * @param {object} index 已加载的索引
 * @param {{itemIds:string[], name?:string}} opts
 */
async function createBundle(root, index, opts = {}) {
  const ids = [...new Set((opts.itemIds || []).filter((x) => typeof x === 'string'))];
  if (ids.length < 2) return { ok: false, message: '至少选择 2 个素材才能合并' };

  const members = ids.map((id) => (index.items || []).find((it) => it.id === id)).filter(Boolean);
  if (members.length !== ids.length) return { ok: false, message: '有素材已经不存在，请重新选择' };
  if (members.some(isBundle)) return { ok: false, message: '合并卡不能再参与二次合并' };
  if (members.some((it) => it.refOnly)) return { ok: false, message: '文件夹引用不能合并，请先入库为副本' };

  const categories = new Set(members.map((it) => it.category || 'other'));
  if (categories.size !== 1) return { ok: false, message: '只能合并同一类目的素材' };

  const files = [];
  let sourceSize = 0;
  for (const it of members) {
    const abs = resolveStored(root, it);
    if (!abs) return { ok: false, message: `「${it.name}」没有库内原件` };
    try {
      const st = await fsp.stat(abs);
      if (!st.isFile()) return { ok: false, message: `「${it.name}」不是单个文件，不能合并` };
      files.push({ item: it, abs, size: st.size });
      sourceSize += st.size;
    } catch (_) {
      return { ok: false, message: `「${it.name}」原件缺失，不能合并` };
    }
  }
  if (sourceSize > MAX_ZIP_BYTES) return { ok: false, message: '合并内容超过 4GB，不能打成 zip' };

  const id = bundleId();
  const dir = path.join(root, 'orig', id);
  await fsp.mkdir(dir, { recursive: true });

  const firstName = members[0].name || '未命名';
  const defaultName = `${firstName} 等 ${members.length} 项`;
  const name = String(opts.name || defaultName).trim().slice(0, 80) || defaultName;
  const zipName = `${safeName(name, 36)}.zip`;
  const zipPath = path.join(dir, zipName);

  const used = new Set();
  const entries = [];
  files.forEach((f, i) => {
    const ext = path.extname(f.abs);
    let base = `${pad2(i + 1)}_${safeName(f.item.name, 48)}${ext}`;
    while (used.has(base.toLowerCase())) base = `${pad2(i + 1)}_${safeName(f.item.name, 48)}_${i + 1}${ext}`;
    used.add(base.toLowerCase());
    entries.push({ name: base, absPath: f.abs, size: f.size });
  });

  const manifestPath = path.join(dir, '.合集说明.txt');
  const manifest = [
    'AvatarVault 合并卡',
    '==================',
    `名称：${name}`,
    `类目：${members[0].category || 'other'}`,
    `成员：${members.length} 个`,
    `原文件总大小：${sourceSize} 字节`,
    '',
    ...members.map((it, i) => `${pad2(i + 1)}. ${it.name}（${it.id}）`),
  ].join('\r\n');
  await fsp.writeFile(manifestPath, manifest, 'utf8');
  entries.push({ name: '合集说明.txt', absPath: manifestPath, size: Buffer.byteLength(manifest) });

  try {
    await writeStoreZip(zipPath, entries);
  } catch (err) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, message: '合并失败：' + (err && err.message ? err.message : 'zip 写入失败') };
  } finally {
    await fsp.rm(manifestPath, { force: true }).catch(() => {});
  }

  const zipStat = await fsp.stat(zipPath);
  const thumb = await copyFirstThumb(root, id, members[0]);
  const stats = {
    assetCount: sumStat(members, 'assetCount'),
    materials: sumStat(members, 'materials'),
    textures: sumStat(members, 'textures'),
    prefabs: sumStat(members, 'prefabs'),
    vramMB: Math.round(sumStat(members, 'vramMB') * 10) / 10,
  };
  const tags = [...new Set(members.flatMap((it) => Array.isArray(it.tags) ? it.tags : []))].slice(0, 20);

  const entry = {
    id,
    name,
    category: members[0].category || 'other',
    categorySource: 'manual',
    kind: 'zip',
    storedPath: path.relative(root, zipPath).replace(/\\/g, '/'),
    originPath: '',
    sizeBytes: zipStat.size,
    addedAt: Date.now(),
    stats,
    statsRepaired: true,
    tags,
    notes: `由 ${members.length} 个同类目素材合并；右键「还原原卡」可撤销合并。`,
    customThumbs: thumb ? [thumb] : [],
    bundle: {
      version: 1,
      memberIds: members.map((it) => it.id),
      memberNames: members.map((it) => it.name),
      sourceSizeBytes: sourceSize,
      createdAt: Date.now(),
    },
  };

  for (const it of members) it.bundledInto = id;
  index.items.unshift(entry);
  if (!opts.noPersist) await saveIndex(root, index);
  return { ok: true, bundleId: id, name, memberCount: members.length, stats, sizeBytes: zipStat.size };
}

/**
 * 还原合并卡：删除合并卡和 zip，恢复原素材显示。
 * 不删除原素材文件与条目。
 */
async function restoreBundle(root, index, id, opts = {}) {
  const entry = (index.items || []).find((it) => it.id === id);
  if (!entry || !isBundle(entry)) return { ok: false, message: '这个条目不是合并卡' };

  const memberIds = entry.bundle.memberIds || [];
  for (const it of index.items) {
    if (it.bundledInto === id) delete it.bundledInto;
  }
  index.items = index.items.filter((it) => it.id !== id);
  for (const c of index.collections || []) {
    c.itemIds = (c.itemIds || []).filter((x) => x !== id);
  }
  if (!opts.noPersist) await saveIndex(root, index);
  await removeEntryFiles(root, entry);
  return { ok: true, id, restored: memberIds.length, memberIds };
}

module.exports = { createBundle, restoreBundle, isBundle, resolveStored };
