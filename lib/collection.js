'use strict';
const fsp = require('fs/promises');
const path = require('path');
const { writeStoreZip } = require('./zipwrite');

function safeName(s, max = 48) {
  return String(s || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max) || '未命名';
}

function pad2(n) { return String(n).padStart(2, '0'); }

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function resolveStored(root, entry) {
  const p = String((entry && entry.storedPath) || '');
  if (!p) return '';
  if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || path.isAbsolute(p)) return p;
  return path.join(root, p);
}

function categoryLabel(index, key) {
  const c = (index.categories || []).find((x) => x.key === key);
  return c ? c.name : (key || '未分类');
}

function categoryRank(index, key) {
  const i = (index.categories || []).findIndex((x) => x.key === key);
  return i < 0 ? 99 : i;
}

function buildRows(index, c) {
  const rows = [];
  for (const id of c.itemIds || []) {
    const item = (index.items || []).find((x) => x.id === id);
    if (item) rows.push(item);
  }
  return rows;
}

async function exportCollection(root, index, collection, { mode = 'folder', onProgress } = {}) {
  const c = collection;
  const rows = buildRows(index, c);
  const normal = [];
  const refs = [];
  const missing = [];
  let sizeBytes = 0;

  for (const item of rows) {
    if (item.refOnly) { refs.push(item); continue; }
    const abs = resolveStored(root, item);
    try {
      await fsp.access(abs);
      const st = await fsp.stat(abs);
      normal.push({ item, abs, size: st.size });
      sizeBytes += st.size;
    } catch (_) {
      missing.push(item);
    }
  }

  if (!normal.length) {
    return { ok: false, message: '这个套装里没有可导出的原件（可能只有文件夹引用或原件已丢失）' };
  }
  if (mode === 'zip' && sizeBytes > 3.9 * 1024 * 1024 * 1024) {
    return { ok: false, message: '套装超过 4GB，请改用“导出文件夹”' };
  }

  const rootName = safeName(c.name) || '套装';
  const ts = stamp();
  const base = path.join(root, 'exports', `${rootName}_${ts}`);

  const rowNo = new Map(rows.map((it, i) => [it.id, i + 1]));
  const fileEntries = [];
  const usedNames = new Set();
  for (const row of normal) {
    const item = row.item;
    const no = rowNo.get(item.id) || 1;
    const cat = `${pad2(categoryRank(index, item.category) + 1)}_${safeName(categoryLabel(index, item.category), 24)}`;
    const ext = path.extname(row.abs);
    let baseName = `${pad2(no)}_${safeName(item.name, 40)}${ext}`;
    const key = `${cat}/${baseName}`;
    if (usedNames.has(key)) baseName = `${pad2(no)}_${safeName(item.name, 40)}_${no}${ext}`;
    usedNames.add(`${cat}/${baseName}`);
    fileEntries.push({ src: row.abs, name: `${rootName}/${cat}/${baseName}`, size: row.size, item, no, cat });
  }

  const manifest = [];
  manifest.push('AvatarVault 套装清单');
  manifest.push('====================');
  manifest.push(`套装：${c.name || '未命名套装'}`);
  manifest.push(`说明：${c.description || '—'}`);
  manifest.push(`导出时间：${new Date().toLocaleString('zh-CN')}`);
  manifest.push(`成员：${rows.length} 个（可导出 ${normal.length}，文件夹引用 ${refs.length}，原件缺失 ${missing.length}）`);
  manifest.push('');
  for (const item of rows) {
    const no = rowNo.get(item.id);
    const fe = fileEntries.find((e) => e.item.id === item.id);
    if (fe) {
      manifest.push(`${pad2(no)}. [${categoryLabel(index, item.category)}] ${item.name}`);
      manifest.push(`    文件：${fe.name.replace(`${rootName}/`, '')}`);
      manifest.push(`    大小：${fmtSize(fe.size)}`);
      if (item.tags && item.tags.length) manifest.push(`    标签：${item.tags.join('、')}`);
      if (item.notes) manifest.push(`    备注：${String(item.notes).replace(/\r?\n/g, ' ')}`);
    } else if (item.refOnly) {
      manifest.push(`${pad2(no)}. [文件夹引用·未复制] ${item.name}`);
      manifest.push(`    原路径：${item.originPath || '—'}`);
    } else {
      manifest.push(`${pad2(no)}. [原件缺失·未复制] ${item.name}`);
    }
  }
  manifest.push('');
  const manifestText = manifest.join('\r\n');

  if (mode === 'zip') {
    const zipPath = base + '.zip';
    const tmpManifest = path.join(root, 'exports', `.${rootName}_${ts}_清单.txt`);
    await fsp.mkdir(path.dirname(tmpManifest), { recursive: true });
    await fsp.writeFile(tmpManifest, manifestText, 'utf8');
    const entries = fileEntries.map((e) => ({ name: e.name, absPath: e.src, size: e.size }));
    entries.push({ name: `${rootName}/套装清单.txt`, absPath: tmpManifest, size: Buffer.byteLength(manifestText) });
    try {
      await writeStoreZip(zipPath, entries, (p) => { if (onProgress) onProgress(p); });
      const zst = await fsp.stat(zipPath);
      return { ok: true, path: zipPath, isZip: true, count: normal.length, skippedRef: refs.length, missing: missing.length, sizeBytes: zst.size };
    } finally {
      await fsp.rm(tmpManifest, { force: true }).catch(() => {});
    }
  }

  await fsp.mkdir(base, { recursive: true });
  for (const e of fileEntries) {
    const rel = e.name.slice(rootName.length + 1);
    const target = path.join(base, rel);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(e.src, target);
  }
  await fsp.writeFile(path.join(base, '套装清单.txt'), manifestText, 'utf8');
  if (onProgress) onProgress({ done: normal.length, total: normal.length, name: c.name });
  return { ok: true, path: base, isZip: false, count: normal.length, skippedRef: refs.length, missing: missing.length, sizeBytes };
}

module.exports = { exportCollection, buildRows, resolveStored };
