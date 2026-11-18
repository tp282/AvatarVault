'use strict';
const fsp = require('fs/promises');
const path = require('path');

const DEFAULT_CATEGORIES = [
  { key: 'base', name: '素体' },
  { key: 'cloth', name: '服装' },
  { key: 'makeup', name: '妆容' },
  { key: 'prop', name: '道具' },
  { key: 'material', name: '着色球' },
  { key: 'other', name: '未分类' },
];

function normalizeCategories(list) {
  const out = [];
  const seen = new Set();
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || !c.key) continue;
    const key = String(c.key);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, name: String(c.name || key) });
  }
  const i = out.findIndex((c) => c.key === 'other');
  if (i >= 0) out.push(out.splice(i, 1)[0]);
  else out.push({ key: 'other', name: '未分类' });
  return out;
}

function isAbsPath(p) {
  const s = String(p || '');
  return /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('\\\\') || s.startsWith('/') || path.isAbsolute(s);
}

/** 把库内绝对路径转成相对库根的路径（统一用 /）。 */
function relFromRoot(root, p) {
  const r = String(root || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const q = String(p || '').replace(/\\/g, '/');
  if (!r || !q) return '';
  if (q.toLowerCase().startsWith(r.toLowerCase() + '/')) return q.slice(r.length + 1);
  return '';
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch (_) { return false; }
}

async function firstFileName(dir) {
  try {
    const list = await fsp.readdir(dir, { withFileTypes: true });
    const f = list.find((e) => e.isFile());
    return f ? f.name : '';
  } catch (_) { return ''; }
}

/**
 * 旧库迁移：storedPath 从绝对路径改成相对路径；普通条目清掉无用的 originPath；
 * 库目录被搬走后，按 orig/<id>/ 里的实际文件兜底。
 * 返回是否有改动。
 */
async function normalizePaths(root, index) {
  let changed = false;
  for (const it of index.items || []) {
    if (!it) continue;

    if (it.refOnly) {
      if (it.storedPath) { it.storedPath = ''; changed = true; }
      const op = String(it.originPath || '');
      const ok = op ? await exists(op) : false;
      if (!ok && !it.missingRef) { it.missingRef = true; changed = true; }
      if (ok && it.missingRef) { delete it.missingRef; changed = true; }
      continue;
    }

    const sp = String(it.storedPath || '');
    let rel = '';

    // 已经是相对路径，且文件确实存在
    if (sp && !isAbsPath(sp)) {
      if (await exists(path.join(root, sp))) rel = sp.replace(/\\/g, '/');
    }

    // 绝对路径：在库根下面才转相对
    if (!rel && sp && isAbsPath(sp)) {
      const r = relFromRoot(root, sp);
      if (r && await exists(sp)) rel = r.replace(/\\/g, '/');
    }

    // 路径失效（换机器/搬目录/被清洗过文件名）：按 id 找实际原件
    if (!rel) {
      const name = await firstFileName(path.join(root, 'orig', String(it.id || '')));
      if (name) rel = `orig/${it.id}/${name}`;
    }

    if (rel !== sp) { it.storedPath = rel; changed = true; }
    if (rel) {
      if (it.missingRef) { delete it.missingRef; changed = true; }
    } else if (!it.missingRef) {
      it.missingRef = true; changed = true;
    }

    // originPath 只对文件夹引用有意义；普通素材保留它等于泄露临时目录
    if (it.originPath) { it.originPath = ''; changed = true; }
  }
  return changed;
}


function normalizeCollections(list) {
  const out = [];
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || !c.id) continue;
    out.push({
      id: String(c.id),
      name: String(c.name || '未命名套装'),
      description: String(c.description || ''),
      itemIds: Array.isArray(c.itemIds) ? [...new Set(c.itemIds.filter((x) => typeof x === 'string'))] : [],
      createdAt: Number(c.createdAt) || Date.now(),
      updatedAt: Number(c.updatedAt) || Date.now(),
    });
  }
  return out;
}

const EMPTY_INDEX = () => ({
  version: 1, items: [], collections: [], categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
});

async function loadJSON(file, fallback) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

async function saveJSONAtomic(file, data) {
  const tmp = file + '.tmp';
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

function normalizeIndex(data) {
  if (!data || !Array.isArray(data.items)) return EMPTY_INDEX();
  return {
    version: data.version || 1,
    items: data.items.filter((it) => it && it.id),
    collections: normalizeCollections(data.collections),
    categories: normalizeCategories(
      Array.isArray(data.categories) && data.categories.length ? data.categories : DEFAULT_CATEGORIES,
    ),
  };
}

async function loadIndex(root) {
  const file = path.join(root, 'index.json');
  const data = await loadJSON(file, null);
  return normalizeIndex(data);
}

async function saveIndex(root, index) {
  await saveJSONAtomic(path.join(root, 'index.json'), index);
}

function upsertEntry(index, entry) {
  const i = index.items.findIndex((it) => it.id === entry.id);
  if (i >= 0) return { index, duplicated: true, entry: index.items[i] };
  index.items.unshift(entry);
  return { index, duplicated: false, entry };
}

async function removeEntryFiles(root, entry) {
  const short = entry.id;
  for (const dir of [path.join(root, 'orig', short), path.join(root, 'prev', short)]) {
    try { await fsp.rm(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}

module.exports = {
  DEFAULT_CATEGORIES,
  normalizeCategories, normalizeCollections, normalizeIndex, normalizePaths, loadIndex, saveIndex, saveJSONAtomic, loadJSON, upsertEntry, removeEntryFiles, EMPTY_INDEX };
