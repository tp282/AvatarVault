'use strict';
// 整库搬迁：导出成文件夹/单文件 zip，再从备份导入合并
const fsp = require('fs/promises');
const path = require('path');
const { loadIndex, saveIndex, loadJSON, normalizePaths } = require('./store');
const { writeStoreZip } = require('./zipwrite');
const { inspectStored } = require('./ingest');

const EXPORT_MANIFEST = 'avatarvault-backup.json';

async function listFiles(dir, base = dir, out = []) {
  let list;
  try { list = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of list) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await listFiles(full, base, out);
    else out.push({ absPath: full, name: path.relative(base, full).replace(/\\/g, '/') });
  }
  return out;
}

async function dirSize(files) {
  let total = 0;
  for (const f of files) {
    try { total += (await fsp.stat(f.absPath)).size; } catch (_) { /* ignore */ }
  }
  return total;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * 导出整库
 * @param {string} root 当前库
 * @param {string} parentDir 导出到哪个目录下
 * @param {{asZip:boolean, onProgress?:Function}} opts
 */
async function exportLibrary(root, parentDir, opts = {}) {
  const name = `AvatarVault库_${stamp()}`;
  const dest = path.join(parentDir, name);
  await fsp.mkdir(dest, { recursive: true });

  // 复制 index.json / orig / prev
  const index = opts.index ? opts.index : await loadIndex(root);
  if (!opts.index) await normalizePaths(root, index);
  await fsp.writeFile(path.join(dest, 'index.json'), JSON.stringify(index, null, 2), 'utf8');

  for (const sub of ['orig', 'prev']) {
    const src = path.join(root, sub);
    let list = [];
    try { list = await fsp.readdir(src, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of list) {
      if (!e.isDirectory()) continue;
      await fsp.cp(path.join(src, e.name), path.join(dest, sub, e.name), { recursive: true, force: true });
    }
  }

  const files = await listFiles(dest);
  const sizeBytes = await dirSize(files);
  const entryCount = index.items.length;

  if (opts.asZip) {
    const zipPath = dest + '.zip';
    if (sizeBytes > 3.9 * 1024 * 1024 * 1024) {
      return { ok: true, dest, isZip: false, sizeBytes, entryCount, note: '总体积超过 4GB，已改为文件夹导出' };
    }
    await writeStoreZip(zipPath, files, opts.onProgress);
    await fsp.rm(dest, { recursive: true, force: true });
    const zst = await fsp.stat(zipPath);
    return { ok: true, dest: zipPath, isZip: true, sizeBytes: zst.size, entryCount };
  }
  return { ok: true, dest, isZip: false, sizeBytes, entryCount };
}

function normThumb(f) {
  if (!f) return '';
  return String(f).split(/[\\/]/).pop();
}

/**
 * 从备份目录导入合并进当前库
 */
function needsStatsRepair(entry) {
  if (!entry || entry.refOnly || entry.statsRepaired) return false;
  const ext = path.extname(String(entry.storedPath || '')).toLowerCase();
  const isPackage = ext === '.unitypackage' || ext === '.zip';
  const vram = entry.stats && Number(entry.stats.vramMB);
  return isPackage || !entry.stats || !Number.isFinite(vram) || vram <= 0;
}

async function importLibrary(root, srcDir, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const nameMap = opts.nameMap;
  const srcIndex = await loadJSON(path.join(srcDir, 'index.json'), null);
  if (!srcIndex || !Array.isArray(srcIndex.items)) {
    throw new Error('这个目录不是 AvatarVault 备份（缺少 index.json）');
  }

  // 解压时文件名可能被 Windows 清洗过，示意图文件名要跟着映射
  const mapThumb = (id, f, sub) => {
    const base = normThumb(f);
    if (!base) return '';
    if (!nameMap) return base;
    const key = `${sub}/${id}/${base}`;
    const mapped = nameMap.get ? nameMap.get(key) : nameMap[key];
    return mapped ? path.basename(mapped) : base;
  };

  const index = opts.index ? opts.index : await loadIndex(root);
  const added = [];
  const addedIds = [];
  const skipped = [];
  const failed = [];
  const notices = [];

  let i = 0;
  for (const raw of srcIndex.items) {
    i++;
    onProgress({ phase: 'entry', index: i, total: srcIndex.items.length, name: raw.name });
    try {
      const id = raw.id;
      const existing = index.items.find((x) => x.id === id);
      if (existing) {
        // 同一个手机备份重复导入时，已存在条目不覆盖，但顺手把缺失/为 0 的统计补上。
        if (needsStatsRepair(existing)) {
          try {
            const inspected = await inspectStored(root, existing);
            if (inspected && inspected.stats) {
              existing.stats = inspected.stats;
              existing.statsRepaired = true;
            }
          } catch (_) { /* 原件不可读就保持原样 */ }
        }
        skipped.push(raw.name);
        continue;
      }

      // 复制原件目录
      const srcOrig = path.join(srcDir, 'orig', id);
      const dstOrig = path.join(root, 'orig', id);
      let copied = false;
      try {
        await fsp.access(srcOrig);
        await fsp.cp(srcOrig, dstOrig, { recursive: true, force: true });
        copied = true;
      } catch (_) { /* 没有原件 */ }

      // 复制预览图目录
      const srcPrev = path.join(srcDir, 'prev', id);
      try {
        await fsp.access(srcPrev);
        await fsp.cp(srcPrev, path.join(root, 'prev', id), { recursive: true, force: true });
      } catch (_) { /* 没有预览 */ }

      const entry = { ...raw };
      entry.thumbs = (entry.thumbs || []).map((f) => mapThumb(id, f, 'prev')).filter(Boolean);
      entry.customThumbs = (entry.customThumbs || []).map((f) => mapThumb(id, f, 'prev')).filter(Boolean);
      if (entry.boothThumb) entry.boothThumb = mapThumb(id, entry.boothThumb, 'prev');

      if (!raw.refOnly && copied) {
        const base = path.basename(String(raw.storedPath || '') || (entry.thumbs[0] || 'file'));
        // 找 orig/<id> 里真正的文件名
        let real = base;
        try {
          const names = await fsp.readdir(dstOrig);
          if (names.length) real = names[0];
        } catch (_) { /* ignore */ }
        entry.storedPath = path.relative(root, path.join(dstOrig, real)).replace(/\\/g, '/');
        entry.originPath = '';

        // 手机端解析能力有限：.zip 的 stats.vramMB 恒为 0，.unitypackage 用的是
        // 压缩 asset 字节数；旧包还可能完全没有 stats。导入后在 PC 上对原件
        // 重新只读解析一次，包类文件一律以 PC 结果为准。
        if (needsStatsRepair(entry)) {
          try {
            const inspected = await inspectStored(root, entry);
            if (inspected && inspected.stats) {
              entry.stats = inspected.stats;
              entry.statsRepaired = true;
            }
          } catch (_) { /* 原件解析失败就保留原 stats，不影响导入 */ }
        }
      } else if (raw.refOnly) {
        entry.storedPath = '';
        entry.missingRef = true;
        notices.push(`「${raw.name}」是文件夹引用，换机器后需重新指定路径`);
      } else {
        entry.storedPath = '';
        entry.originPath = '';
        entry.missingRef = true;
      }

      index.items.unshift(entry);
      added.push(raw.name);
      addedIds.push(entry.id);
    } catch (err) {
      failed.push(`${raw.name}：${err.message}`);
    }
  }

  // 合并套装
  for (const c of srcIndex.collections || []) {
    const existing = index.collections.find((x) => x.name === c.name);
    if (existing) {
      for (const id of c.itemIds || []) if (!existing.itemIds.includes(id)) existing.itemIds.push(id);
      if (!existing.description && c.description) existing.description = c.description;
      existing.updatedAt = Date.now();
    } else {
      index.collections.push({
        id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        name: c.name,
        description: c.description || '',
        itemIds: [...(c.itemIds || [])],
        createdAt: Number(c.createdAt) || Date.now(),
        updatedAt: Number(c.updatedAt) || Date.now(),
      });
    }
  }

  // 合并类目：备份里有、本机没有的自动补上（手机端新建的类目不会变成未分类）
  const catAdded = [];
  for (const c of Array.isArray(srcIndex.categories) ? srcIndex.categories : []) {
    if (!c || !c.key) continue;
    const key = String(c.key);
    if (index.categories.some((x) => x.key === key)) continue;
    let name = String(c.name || '').trim().slice(0, 12) || '未命名类目';
    if (index.categories.some((x) => x.name === name)) {
      let n = 2;
      while (index.categories.some((x) => x.name === `${name} ${n}`)) n += 1;
      name = `${name} ${n}`;
    }
    index.categories.push({ key, name });
    catAdded.push(name);
  }
  if (catAdded.length) notices.push(`新增 ${catAdded.length} 个类目：${catAdded.join('、')}`);

  if (!opts.index) await saveIndex(root, index);
  return { added, addedIds, skipped, failed, notices, catAdded, total: srcIndex.items.length, index };
}

module.exports = { exportLibrary, importLibrary, EXPORT_MANIFEST };
