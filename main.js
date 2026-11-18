'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeImage, clipboard, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { Readable } = require('stream');

const store = require('./lib/store');
const { ingestPath, inspectStored, cleanName } = require('./lib/ingest');
const portable = require('./lib/portable');
const booth = require('./lib/booth');
const collection = require('./lib/collection');
const bundleLib = require('./lib/bundle');
const stackLib = require('./lib/stacks');
const { extractZipAll, listZipNames } = require('./lib/zip');
const { Vault } = require('./lib/vault');
const thumbs = require('./lib/thumbs');
const { createPool } = require('./lib/worker-pool');

// 自定义图片协议必须在 app ready 之前注册权限
protocol.registerSchemesAsPrivileged([{
  scheme: 'avthumb',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
}]);

const CONFIG_FILE = () => path.join(app.getPath('userData'), 'config.json');
let win = null;
let config = { root: '', stacks: {} };
let needsSetup = false;
const vault = new Vault({
  snapshotDebounceMs: 8000,
  snapshotMaxMs: 30000,
  onError: (e) => console.error('[vault]', e),
});
const pool = createPool(2);

function defaultRoot() {
  return path.join(app.getPath('documents'), 'AvatarVault');
}

async function ensureRoot(root) {
  await fsp.mkdir(root, { recursive: true });
  await fsp.mkdir(path.join(root, 'orig'), { recursive: true });
  await fsp.mkdir(path.join(root, 'prev'), { recursive: true });
}

async function loadConfig() {
  const cfg = await store.loadJSON(CONFIG_FILE(), null);
  const cfgStacks = cfg && cfg.stacks && typeof cfg.stacks === 'object' && !Array.isArray(cfg.stacks)
    ? cfg.stacks : {};
  const explicit = process.env.AV_LIB_ROOT || (cfg && cfg.root);
  if (explicit) {
    config = { root: explicit, stacks: cfgStacks };
    try { await fsp.access(config.root); } catch (_) { /* 目录不在就建 */ }
    await ensureRoot(config.root);
    needsSetup = false;
  } else {
    config = { root: '', stacks: cfgStacks };
    needsSetup = true;
  }
}

function stacksKey(root) {
  return String(root || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

function stacksForRoot(root, items) {
  return stackLib.normalizeStacks((config.stacks || {})[stacksKey(root)], items);
}

async function saveStacksForRoot(root, list) {
  if (!config.root) return;
  config.stacks = config.stacks || {};
  const key = stacksKey(root);
  if (list && list.length) config.stacks[key] = list;
  else delete config.stacks[key];
  await saveConfig();
}

/** 删卡/改类目/合并后，收掉配置里当前库失效的堆叠；没有变化就不写 config。 */
async function pruneConfigStacks(index) {
  if (!config.root) return;
  const key = stacksKey(config.root);
  const before = JSON.stringify((config.stacks || {})[key] || []);
  const list = stacksForRoot(config.root, index.items);
  if (JSON.stringify(list) === before) return;
  await saveStacksForRoot(config.root, list);
}

async function saveConfig() {
  await store.saveJSONAtomic(CONFIG_FILE(), config);
}

const baseName = (f) => String(f || '').split(/[\\/]/).pop();

function thumbAbs(entry, file) {
  return path.join(config.root, 'prev', entry.id, baseName(file));
}

function thumbUrl(id, file, variant = 'grid640') {
  return `avthumb://${encodeURIComponent(String(id))}/${encodeURIComponent(baseName(file))}?v=${encodeURIComponent(variant)}`;
}

/** 条目原件路径：新库是相对库根的 orig/<id>/<file>，旧库可能是绝对路径。 */
function absStored(entry) {
  const p = String((entry && entry.storedPath) || '');
  if (!p) return '';
  if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || path.isAbsolute(p)) return p;
  return path.join(config.root, p);
}

// 老库迁移：绝对路径 → 相对路径，清掉普通条目的 originPath，补示意图文件名
async function migrateIndex() {
  if (!vault.root) return;
  const index = vault.index;
  let changed = await store.normalizePaths(vault.root, index);
  for (const it of index.items) {
    for (const key of ['thumbs', 'customThumbs']) {
      const arr = it[key];
      if (!Array.isArray(arr) || !arr.length) continue;
      const kept = [];
      for (const f of arr) {
        const name = baseName(f);
        if (!name) continue;
        try {
          await fsp.access(path.join(vault.root, 'prev', it.id, name));
          kept.push(name);
        } catch (_) { /* 文件已丢失，丢弃 */ }
      }
      if (kept.length !== arr.length || kept.some((n, i) => n !== arr[i])) changed = true;
      it[key] = kept;
    }
  }
  if (changed) await vault.replace(index);
}

function view(entry) {
  // 只用用户自己加的示意图；包内自带的 preview.png 一律不展示
  const files = (entry.customThumbs || []).map(baseName).filter(Boolean);
  return {
    ...entry,
    thumbFiles: files,
    thumbUrls: files.map((f) => thumbUrl(entry.id, f, 'detail')),
    dragIconUrl: files[0] ? thumbUrl(entry.id, files[0], 'grid640') : '',
    exists: true,
  };
}

function libraryExtras() {
  return {
    categories: vault.index.categories,
    collections: vault.index.collections,
    stacks: stacksForRoot(config.root, vault.index.items),
  };
}

async function statePayload() {
  if (!config.root) {
    return {
      root: '', items: [], collections: [], stacks: [],
      categories: store.DEFAULT_CATEGORIES.map((c) => ({ ...c })),
      needSetup: true,
      defaultRoot: defaultRoot(),
    };
  }
  return {
    root: config.root,
    items: vault.index.items.map(view),
    collections: vault.index.collections,
    stacks: stacksForRoot(config.root, vault.index.items),
    categories: vault.index.categories,
    needSetup: needsSetup,
    defaultRoot: defaultRoot(),
  };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#0e1014',
    title: 'AvatarVault · 改模素材库',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.on('closed', () => { win = null; });

  // 开发用：AV_SHOT=/path/to.png 时渲染完成即截图退出（用于无头环境自检）
  if (process.env.AV_SHOT) {
    win.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        try {
          if (process.env.AV_SHOT_JS) {
            const out = await win.webContents.executeJavaScript(process.env.AV_SHOT_JS);
            if (out !== undefined) console.log('[shot js]', JSON.stringify(out));
            await new Promise((r) => setTimeout(r, 900));
          }
          const img = await win.webContents.capturePage();
          await fsp.writeFile(process.env.AV_SHOT, img.toPNG());
          console.log('screenshot saved:', process.env.AV_SHOT);
        } catch (e) {
          console.error('screenshot failed', e);
        }
        app.quit();
      }, 2200);
    });
  }
}

/* ---------------- 自定义图片协议 ---------------- */

async function fileResponse(file, mime, request) {
  const st = await fsp.stat(file);
  const etag = `"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': mime || thumbs.mimeFor(file),
    'Cache-Control': 'no-cache',
    'ETag': etag,
    'Access-Control-Allow-Origin': '*',
  };
  const inm = request && request.headers && request.headers.get ? request.headers.get('if-none-match') : '';
  if (inm === etag) return new Response(null, { status: 304, headers });
  if (st.size <= 2 * 1024 * 1024) {
    const buf = await fsp.readFile(file);
    return new Response(buf, { headers: { ...headers, 'Content-Length': String(st.size) } });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), {
    headers: { ...headers, 'Content-Length': String(st.size) },
  });
}

async function handleThumbRequest(request) {
  try {
    if (!config.root) return new Response('no library', { status: 404 });
    const u = new URL(request.url);
    const id = decodeURIComponent(u.hostname || '');
    const file = decodeURIComponent((u.pathname || '').replace(/^\/+/, ''));
    if (!id || !file || id.includes('..') || file.includes('..')) {
      return new Response('bad request', { status: 400 });
    }
    const src = path.join(config.root, 'prev', id, path.basename(file));
    try { await fsp.access(src); } catch (_) { return new Response('missing', { status: 404 }); }
    const variant = u.searchParams.get('v') || 'grid640';
    if (variant === 'orig') return await fileResponse(src, thumbs.mimeFor(src), request);
    try {
      const out = await thumbs.ensureVariant(src, {
        root: config.root,
        userData: app.getPath('userData'),
        id,
        name: file,
      }, variant);
      return await fileResponse(out.file, out.mime, request);
    } catch (err) {
      console.error('[thumb] generate failed', err);
      return await fileResponse(src, thumbs.mimeFor(src), request);
    }
  } catch (err) {
    return new Response('error', { status: 500 });
  }
}

/* ---------------- app 生命周期 ---------------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

if (gotLock) app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  protocol.handle('avthumb', handleThumbRequest);
  await loadConfig();
  try {
    await vault.open(config.root);
    try { await migrateIndex(); } catch (e) { console.error('migrateIndex failed', e); }
    if (config.root) {
      thumbs.trimCache(app.getPath('userData')).catch(() => {});
      thumbs.warmup(config.root, app.getPath('userData'), vault.index.items, 80);
    }
  } catch (e) {
    console.error('vault open failed', e);
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  Promise.resolve()
    .then(() => vault.flush())
    .catch((err) => console.error('[quit flush]', err))
    .finally(() => pool.close().catch(() => {}).finally(() => app.quit()));
});

/* ---------------- IPC ---------------- */

ipcMain.handle('state:get', async () => statePayload());

async function switchRoot(root) {
  await vault.flush();
  config.root = root;
  needsSetup = false;
  await ensureRoot(root);
  await saveConfig();
  await vault.open(config.root);
  await migrateIndex();
  if (config.root) thumbs.warmup(config.root, app.getPath('userData'), vault.index.items, 80);
  return statePayload();
}

ipcMain.handle('library:chooseRoot', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择素材库目录',
    defaultPath: config.root || defaultRoot(),
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '用这个目录',
  });
  if (r.canceled || !r.filePaths[0]) return { changed: false };
  return { changed: true, state: await switchRoot(r.filePaths[0]) };
});

ipcMain.handle('library:setup', async (_e, chosenPath) => {
  const root = (chosenPath && String(chosenPath).trim()) || defaultRoot();
  return { ok: true, state: await switchRoot(root) };
});

ipcMain.handle('library:initRoot', async (_e, mode) => {
  let target = config.root || defaultRoot();
  if (mode === 'pick') {
    const r = await dialog.showOpenDialog(win, {
      title: '选择素材库目录（原件和示意图都会存这里）',
      defaultPath: config.root,
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '就用这个目录',
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    target = r.filePaths[0];
  }
  return { ok: true, state: await switchRoot(target) };
});

ipcMain.handle('library:reveal', async () => {
  await shell.openPath(config.root);
  return true;
});

ipcMain.handle('ingest:pickFiles', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择要入库的素材',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '素材包', extensions: ['unitypackage', 'zip', 'rar', '7z', 'fbx', 'prefab', 'png', 'jpg'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  });
  if (r.canceled) return [];
  return r.filePaths;
});

ipcMain.handle('ingest:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择要入库的文件夹（会扫描子目录）',
    properties: ['openDirectory'],
  });
  if (r.canceled) return [];
  return r.filePaths;
});

ipcMain.handle('ingest:paths', async (event, paths) => {
  if (!vault.root) return { added: [], duplicated: [], failed: ['请先设置素材库'], notices: [], addedItems: [] };
  const sender = event.sender;
  const index = vault.index;
  const added = [];
  const addedItems = [];
  const duplicated = [];
  const failed = [];
  const notices = [];
  const total = paths.length;

  for (let i = 0; i < total; i++) {
    const p = paths[i];
    const report = (extra) => {
      if (sender.isDestroyed()) return;
      sender.send('ingest:progress', { index: i + 1, total, path: p, ...extra });
    };
    try {
      // 拖进来的是备份 zip？先问是不是要导入整库
      if (/\.zip$/i.test(p) && await isBackupZip(p)) {
        const ask = await dialog.showMessageBox(win, {
          type: 'question',
          title: '这是备份包',
          message: `「${path.basename(p)}」是 AvatarVault 备份包`,
          detail: '要把它导入当前库（合并，不覆盖），还是当普通素材收进库？',
          buttons: ['导入备份', '当普通素材', '跳过'],
          defaultId: 0,
          cancelId: 2,
        });
        if (ask.response === 2) { continue; }
        if (ask.response === 0) {
          const res = await runImport(sender, p);
          notices.push(`备份导入：新增 ${res.added.length}，跳过 ${res.skipped.length}，失败 ${res.failed.length}`);
          if (res.addedItems) addedItems.push(...res.addedItems);
          added.push(...res.added);
          continue;
        }
      }

      report({ phase: 'start' });
      const entry = await pool.run('ingest', { root: vault.root, srcPath: p }, {
        onProgress: (pr) => report(pr),
        onNotice: (n) => notices.push(n),
      });
      const existed = index.items.find((it) => it.id === entry.id);
      if (existed) {
        duplicated.push(existed.name);
        report({ phase: 'dup', name: existed.name });
        continue;
      }
      index.items.unshift(entry);
      vault.record([{ op: 'item:set', item: entry }]);
      added.push(entry.name);
      addedItems.push(view(entry));
      notifyThumb(entry);
      report({ phase: 'done', name: entry.name });
    } catch (err) {
      failed.push(`${path.basename(p)}：${err.message}`);
      report({ phase: 'error', message: err.message });
    }
  }

  return { added, duplicated, failed, notices, addedItems, ...libraryExtras() };
});

function notifyThumb(entry) {
  const file = (entry.customThumbs || [])[0];
  if (!file) return;
  thumbs.prefetch(path.join(vault.root, 'prev', entry.id, baseName(file)), {
    root: vault.root,
    userData: app.getPath('userData'),
    id: entry.id,
    name: file,
  });
}

ipcMain.handle('drag:start', async (event, id) => {
  const entry = vault.findItem(id);
  if (!entry) return { ok: false, message: '条目不存在' };
  if (entry.refOnly) {
    await shell.openPath(entry.originPath);
    return { ok: false, message: '这是文件夹引用，已为您打开所在文件夹' };
  }
  try { await fsp.access(absStored(entry)); } catch (_) {
    return { ok: false, message: '原件已丢失，请检查素材库目录' };
  }
  let icon;
  const thumb = (entry.customThumbs && entry.customThumbs[0]) || (entry.thumbs && entry.thumbs[0]);
  if (thumb) {
    try {
      const img = nativeImage.createFromPath(thumbAbs(entry, thumb));
      if (!img.isEmpty()) icon = img.resize({ width: 96, height: 96 });
    } catch (_) { /* ignore */ }
  }
  if (!icon) {
    try {
      const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'drag-icon.png'));
      if (!img.isEmpty()) icon = img;
    } catch (_) { /* ignore */ }
  }
  event.sender.startDrag({ file: absStored(entry), icon });

  entry.lastUsed = Date.now();
  vault.record([{ op: 'item:set', item: entry }]);
  return { ok: true };
});

ipcMain.handle('item:update', async (_e, id, patch) => {
  const entry = vault.findItem(id);
  if (!entry) return { ok: false };
  const allowed = ['name', 'category', 'tags', 'favorite', 'notes', 'categorySource'];
  let categoryChanged = false;
  for (const k of allowed) if (k in (patch || {})) {
    entry[k] = patch[k];
    if (k === 'name') entry.nameSource = 'manual';
    if (k === 'category') categoryChanged = true;
  }
  vault.record([{ op: 'item:set', item: entry }]);
  if (categoryChanged) await pruneConfigStacks(vault.index);
  return { ok: true, item: view(entry) };
});

ipcMain.handle('item:batchUpdate', async (_e, ids, patch) => {
  const allowed = ['name', 'category', 'tags', 'favorite', 'notes', 'categorySource'];
  const safe = {};
  for (const k of allowed) if (k in (patch || {})) safe[k] = patch[k];
  const addTags = Array.isArray(patch && patch.addTags) ? patch.addTags.map(String).filter(Boolean) : null;
  const items = [];
  let categoryChanged = false;
  for (const id of Array.isArray(ids) ? ids : []) {
    const entry = vault.findItem(id);
    if (!entry) continue;
    Object.assign(entry, safe);
    if (addTags) entry.tags = [...new Set([...(entry.tags || []), ...addTags])].slice(0, 20);
    if ('name' in safe) entry.nameSource = 'manual';
    if ('category' in safe) categoryChanged = true;
    vault.record([{ op: 'item:set', item: entry }]);
    items.push(view(entry));
  }
  if (categoryChanged) await pruneConfigStacks(vault.index);
  return { ok: true, items, ...libraryExtras() };
});

/** BOOTH 自动命名：旧条目没有 nameSource 时，用文件名推断当前名字是否还是自动名。 */
function autoNameFor(entry) {
  const p = entry.refOnly ? entry.originPath : absStored(entry);
  return p ? cleanName(path.basename(p)) : '';
}

ipcMain.handle('item:fetchBooth', async (_e, id, force) => {
  if (!vault.root) return { ok: false, message: '请先设置素材库目录' };
  const entry = vault.findItem(id);
  if (!entry) return { ok: false, message: '条目不存在' };

  const link = booth.extractBoothLink(entry.notes);
  if (!link) return { ok: true, skipped: true };

  // 同一个商品已经抓过，不重复打扰；手动按钮可以 force 刷新
  if (!force && entry.boothItemId === link.itemId && entry.boothTitle) {
    return { ok: true, skipped: true, cached: true };
  }

  let info;
  try {
    info = await booth.fetchItem(link.itemId);
  } catch (err) {
    return { ok: false, message: err && err.message ? err.message : 'BOOTH 商品信息读取失败' };
  }

  entry.boothItemId = info.id;
  entry.boothUrl = link.url;
  entry.boothTitle = info.name;
  entry.boothShop = info.shop || '';
  entry.boothCategory = info.category ? info.category.name : '';
  entry.boothFetchedAt = Date.now();

  const canRename = entry.nameSource === 'auto'
    || (!entry.nameSource && (!entry.name || entry.name === '未命名资产' || entry.name === autoNameFor(entry)));
  if (canRename) {
    entry.name = info.name;
    entry.nameSource = 'auto';
  }

  let imageUpdated = false;
  let imageError = '';
  const imageUrl = info.images && info.images[0];
  if (!imageUrl) {
    imageError = '商品页没有图片';
  } else {
    try {
      const dir = path.join(vault.root, 'prev', entry.id);
      const oldThumb = String(entry.boothThumb || '');
      const dl = await booth.downloadImage(imageUrl, dir, `booth_${link.itemId}`);
      const oldPath = oldThumb ? path.join(dir, baseName(oldThumb)) : '';
      entry.customThumbs = (entry.customThumbs || []).filter((f) => f !== oldThumb && f !== dl.fileName);
      entry.customThumbs = [dl.fileName, ...entry.customThumbs];
      entry.boothThumb = dl.fileName;
      entry.boothImageUrl = imageUrl;
      imageUpdated = true;
      if (oldThumb && oldThumb !== dl.fileName && oldPath) {
        try { await fsp.rm(oldPath, { force: true }); } catch (_) { /* ignore */ }
      }
      thumbs.prefetch(path.join(dir, dl.fileName), {
        root: vault.root, userData: app.getPath('userData'), id: entry.id, name: dl.fileName,
      });
    } catch (err) {
      imageError = err && err.message ? err.message : '商品缩略图下载失败';
    }
  }

  vault.record([{ op: 'item:set', item: entry }]);
  return {
    ok: true,
    skipped: false,
    changed: true,
    title: info.name,
    imageUpdated,
    imageError,
    item: view(entry),
  };
});

ipcMain.handle('item:refreshStats', async (_e, id) => {
  const entry = vault.findItem(id);
  if (!entry) return { ok: false, message: '条目不存在' };
  if (entry.refOnly) return { ok: false, message: '文件夹引用没有可统计的原件' };
  try {
    const inspected = await pool.run('inspect', { root: vault.root, entry: JSON.parse(JSON.stringify(entry)) });
    if (inspected && inspected.stats) entry.stats = inspected.stats;
    entry.statsRepaired = true;
    vault.record([{ op: 'item:set', item: entry }]);
    return { ok: true, item: view(entry) };
  } catch (err) {
    return { ok: false, message: '统计失败：' + (err && err.message ? err.message : '原件读取失败') };
  }
});

async function deleteOne(id) {
  const entry = vault.findItem(id);
  if (!entry) return { ok: false, removedId: id };
  if (bundleLib.isBundle(entry)) {
    const r = await bundleLib.restoreBundle(vault.root, vault.index, id, { noPersist: true });
    if (!r.ok) return r;
    const memberEntries = (r.memberIds || []).map((x) => vault.findItem(x)).filter(Boolean);
    vault.record([
      { op: 'item:delete', id },
      ...memberEntries.map((it) => ({ op: 'item:set', item: it })),
      { op: 'collections:set', value: vault.index.collections },
    ]);
    return {
      ok: true, restoredBundle: true, removedId: id,
      items: memberEntries.map(view), collections: vault.index.collections,
    };
  }
  vault.index.items = vault.index.items.filter((it) => it.id !== id);
  for (const c of vault.index.collections) c.itemIds = c.itemIds.filter((x) => x !== id);
  vault.record([{ op: 'item:delete', id }]);
  await store.removeEntryFiles(vault.root, entry);
  await pruneConfigStacks(vault.index);
  return { ok: true, removedId: id, collections: vault.index.collections };
}

ipcMain.handle('item:delete', async (_e, id) => {
  return deleteOne(id);
});

ipcMain.handle('item:batchDelete', async (_e, ids) => {
  const removed = [];
  const restored = [];
  const collections = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const r = await deleteOne(id);
    if (r.ok) {
      removed.push(r.removedId);
      if (r.restoredBundle) restored.push(...(r.items || []));
      if (r.collections) collections.splice(0, collections.length, ...r.collections);
    }
  }
  return { ok: true, removed, restored, collections, ...libraryExtras() };
});

ipcMain.handle('item:reveal', async (_e, id) => {
  const entry = vault.findItem(id);
  if (!entry) return false;
  if (entry.refOnly) await shell.openPath(entry.originPath);
  else await shell.showItemInFolder(absStored(entry));
  return true;
});

ipcMain.handle('cat:add', async (_e, name) => {
  const nm = String(name || '').trim();
  if (!nm) return { ok: false, message: '类目名不能为空' };
  if (nm.length > 12) return { ok: false, message: '类目名最长 12 个字' };
  if (vault.index.categories.some((c) => c.name === nm)) return { ok: false, message: '已有同名类目' };
  const key = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
  vault.index.categories.push({ key, name: nm });
  vault.index.categories = store.normalizeCategories(vault.index.categories);
  vault.record([{ op: 'categories:set', value: vault.index.categories }]);
  return { ok: true, key, categories: vault.index.categories };
});

ipcMain.handle('cat:rename', async (_e, key, name) => {
  const nm = String(name || '').trim();
  if (!nm) return { ok: false, message: '类目名不能为空' };
  if (nm.length > 12) return { ok: false, message: '类目名最长 12 个字' };
  if (vault.index.categories.some((c) => c.name === nm && c.key !== key)) {
    return { ok: false, message: '已有同名类目' };
  }
  const c = vault.index.categories.find((x) => x.key === key);
  if (!c) return { ok: false, message: '类目不存在' };
  c.name = nm;
  vault.index.categories = store.normalizeCategories(vault.index.categories);
  vault.record([{ op: 'categories:set', value: vault.index.categories }]);
  return { ok: true, categories: vault.index.categories };
});

ipcMain.handle('cat:order', async (_e, keys) => {
  const want = Array.isArray(keys) ? keys.map(String) : [];
  const byKey = new Map(vault.index.categories.map((c) => [c.key, c]));
  const ordered = [];
  for (const k of want) {
    const c = byKey.get(k);
    if (c) { ordered.push(c); byKey.delete(k); }
  }
  for (const c of byKey.values()) ordered.push(c);
  vault.index.categories = store.normalizeCategories(ordered);
  vault.record([{ op: 'categories:set', value: vault.index.categories }]);
  return { ok: true, categories: vault.index.categories };
});

ipcMain.handle('cat:delete', async (_e, key) => {
  if (key === 'other') return { ok: false, message: '「未分类」不能删' };
  let moved = 0;
  const patches = [];
  for (const it of vault.index.items) {
    if (it.category === key) { it.category = 'other'; moved += 1; patches.push({ id: it.id, category: 'other' }); }
  }
  vault.index.categories = store.normalizeCategories(vault.index.categories.filter((c) => c.key !== key));
  vault.record([{ op: 'cat:delete', key }]);
  await pruneConfigStacks(vault.index);
  return { ok: true, moved, categories: vault.index.categories, patches };
});

ipcMain.handle('bundle:create', async (_e, payload) => {
  if (!vault.root) return { ok: false, message: '请先设置素材库目录' };
  const itemIds = (payload && payload.itemIds) || [];
  const r = await bundleLib.createBundle(vault.root, vault.index, { itemIds, name: payload && payload.name, noPersist: true });
  if (!r.ok) return r;
  // 合并成功的堆叠不再存在；原卡隐藏后也不应该再作为堆叠成员。
  const current = stacksForRoot(vault.root, vault.index.items);
  const merged = new Set(itemIds);
  await saveStacksForRoot(vault.root, current.filter((s) => !s.itemIds.some((id) => merged.has(id))));
  const bundle = vault.findItem(r.bundleId);
  const members = itemIds.map((id) => vault.findItem(id)).filter(Boolean);
  vault.record([
    ...(bundle ? [{ op: 'item:set', item: bundle }] : []),
    ...members.map((it) => ({ op: 'item:set', item: it })),
  ]);
  return {
    ok: true, bundleId: r.bundleId, memberCount: r.memberCount,
    bundleItem: bundle ? view(bundle) : null,
    items: members.map(view),
    ...libraryExtras(),
  };
});

ipcMain.handle('stack:create', async (_e, payload) => {
  if (!vault.root) return { ok: false, message: '请先设置素材库目录' };
  const current = stacksForRoot(vault.root, vault.index.items);
  const r = stackLib.createStack({ ...vault.index, stacks: current }, payload && payload.itemIds);
  if (!r.ok) return r;
  await saveStacksForRoot(vault.root, current.concat([r.stack]));
  return { ok: true, id: r.stack.id, stacks: stacksForRoot(vault.root, vault.index.items) };
});

ipcMain.handle('stack:dissolve', async (_e, id) => {
  if (!vault.root) return { ok: false, message: '请先设置素材库目录' };
  const current = stacksForRoot(vault.root, vault.index.items);
  const r = stackLib.dissolveStack(current, id);
  if (!r.ok) return r;
  await saveStacksForRoot(vault.root, r.list);
  return { ok: true, dissolved: r.dissolved, stacks: stacksForRoot(vault.root, vault.index.items) };
});

ipcMain.handle('bundle:restore', async (_e, id) => {
  const r = await bundleLib.restoreBundle(vault.root, vault.index, id, { noPersist: true });
  if (!r.ok) return r;
  const memberEntries = (r.memberIds || []).map((x) => vault.findItem(x)).filter(Boolean);
  vault.record([
    { op: 'item:delete', id },
    ...memberEntries.map((it) => ({ op: 'item:set', item: it })),
    { op: 'collections:set', value: vault.index.collections },
  ]);
  return {
    ok: true, restored: r.restored, memberIds: r.memberIds,
    items: memberEntries.map(view), collections: vault.index.collections, ...libraryExtras(),
  };
});

ipcMain.handle('collection:save', async (_e, payload) => {
  const { id, name, description, itemIds } = payload || {};
  const validIds = Array.isArray(itemIds)
    ? itemIds.filter((x) => vault.index.items.some((it) => it.id === x))
    : null;
  let newId = id;
  let saved = null;
  if (id) {
    const c = vault.index.collections.find((x) => x.id === id);
    if (c) {
      if (name !== undefined) c.name = String(name || '').trim() || c.name;
      if (description !== undefined) c.description = String(description || '');
      if (validIds) c.itemIds = validIds;
      c.updatedAt = Date.now();
      saved = c;
    }
  } else {
    newId = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
    while (vault.index.collections.some((x) => x.id === newId)) newId = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
    saved = {
      id: newId,
      name: String(name || '').trim() || '未命名套装',
      description: String(description || ''),
      itemIds: validIds || [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    vault.index.collections.push(saved);
  }
  if (saved) vault.record([{ op: 'collection:save', collection: saved }]);
  return { ok: true, id: newId, collections: vault.index.collections };
});

ipcMain.handle('collection:delete', async (_e, id) => {
  vault.index.collections = vault.index.collections.filter((c) => c.id !== id);
  vault.record([{ op: 'collection:delete', id }]);
  return { ok: true, collections: vault.index.collections };
});

ipcMain.handle('collection:add', async (_e, payload) => {
  const { id, itemIds } = payload || {};
  const c = vault.index.collections.find((x) => x.id === id);
  if (!c) return { ok: false, message: '套装不存在' };
  const valid = (Array.isArray(itemIds) ? itemIds : []).filter((x) => vault.findItem(x));
  let added = 0;
  for (const itemId of valid) if (!c.itemIds.includes(itemId)) { c.itemIds.push(itemId); added += 1; }
  if (added) c.updatedAt = Date.now();
  vault.record([{ op: 'collection:add', id, itemIds: valid }]);
  return { ok: true, added, collections: vault.index.collections };
});

ipcMain.handle('collection:remove', async (_e, payload) => {
  const { id, itemIds } = payload || {};
  const c = vault.index.collections.find((x) => x.id === id);
  if (!c) return { ok: false, message: '套装不存在' };
  const before = c.itemIds.length;
  const remove = new Set(Array.isArray(itemIds) ? itemIds : []);
  c.itemIds = c.itemIds.filter((x) => !remove.has(x));
  if (c.itemIds.length !== before) c.updatedAt = Date.now();
  vault.record([{ op: 'collection:remove', id, itemIds: [...remove] }]);
  return { ok: true, removed: before - c.itemIds.length, collections: vault.index.collections };
});

ipcMain.handle('collection:move', async (_e, payload) => {
  const { id, itemId, delta } = payload || {};
  const c = vault.index.collections.find((x) => x.id === id);
  if (!c) return { ok: false, message: '套装不存在' };
  const i = c.itemIds.indexOf(itemId);
  if (i < 0) return { ok: false, message: '该资产不在套装里' };
  const j = i + (Number(delta) < 0 ? -1 : 1);
  if (j < 0 || j >= c.itemIds.length) return { ok: true, moved: false, collections: vault.index.collections };
  c.itemIds.splice(i, 1);
  c.itemIds.splice(j, 0, itemId);
  c.updatedAt = Date.now();
  vault.record([{ op: 'collection:move', id, itemId, delta }]);
  return { ok: true, moved: true, collections: vault.index.collections };
});

ipcMain.handle('collection:export', async (event, id, mode) => {
  const c = vault.index.collections.find((x) => x.id === id);
  if (!c) return { ok: false, message: '套装不存在' };
  const r = await collection.exportCollection(vault.root, vault.index, c, {
    mode: mode === 'zip' ? 'zip' : 'folder',
    onProgress: (p) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('export:progress', { index: p.done, total: p.total, name: p.name || '' });
      }
    },
  });
  if (r.ok) {
    if (r.isZip) shell.showItemInFolder(r.path);
    else await shell.openPath(r.path);
  }
  return r;
});

ipcMain.handle('collection:drag', async (event, id) => {
  const c = vault.index.collections.find((x) => x.id === id);
  if (!c) return { ok: false, message: '套装不存在' };
  const items = c.itemIds.map((itemId) => vault.findItem(itemId)).filter(Boolean);
  const files = [];
  for (const it of items) {
    if (it.refOnly) continue;
    const p = absStored(it);
    try { await fsp.access(p); files.push(p); } catch (_) { /* 丢失的跳过 */ }
  }
  if (!files.length) return { ok: false, message: '这个套装里没有可拖出的原件' };

  let icon;
  const first = items.find((it) => !it.refOnly && it.customThumbs && it.customThumbs[0]);
  if (first) {
    try {
      const img = nativeImage.createFromPath(thumbAbs(first, first.customThumbs[0]));
      if (!img.isEmpty()) icon = img.resize({ width: 96, height: 96 });
    } catch (_) { /* ignore */ }
  }
  if (!icon) {
    try {
      const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'drag-icon.png'));
      if (!img.isEmpty()) icon = img;
    } catch (_) { /* ignore */ }
  }
  if (files.length === 1) event.sender.startDrag({ file: files[0], icon });
  else event.sender.startDrag({ files, icon });
  return { ok: true, count: files.length, skipped: items.length - files.length };
});

/* ---------------- 示意图（导入 / 粘贴） ---------------- */

ipcMain.handle('item:saveThumb', async (_e, id, source) => {
  const entry = vault.findItem(id);
  if (!entry) return { ok: false, message: '条目不存在' };

  const dir = path.join(vault.root, 'prev', id);
  await fsp.mkdir(dir, { recursive: true });
  const stampName = `custom_${Date.now()}`;

  let fileName = null;
  if (typeof source === 'string') {
    const ext = (path.extname(source) || '.png').toLowerCase();
    fileName = stampName + ext;
    await fsp.copyFile(source, path.join(dir, fileName));
  } else if (source && source.base64) {
    const ext = source.ext || '.png';
    fileName = stampName + ext;
    await fsp.writeFile(path.join(dir, fileName), Buffer.from(source.base64, 'base64'));
  } else {
    return { ok: false, message: '没有可用的图片' };
  }

  entry.customThumbs = [fileName, ...(entry.customThumbs || [])];
  vault.record([{ op: 'item:set', item: entry }]);
  thumbs.prefetch(path.join(dir, fileName), { root: vault.root, userData: app.getPath('userData'), id, name: fileName });
  return { ok: true, item: view(entry) };
});

ipcMain.handle('item:pickThumbImage', async (_e, id) => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择一张示意图',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false };
  const entry = vault.findItem(id);
  if (!entry) return { ok: false, message: '条目不存在' };
  const dir = path.join(vault.root, 'prev', id);
  await fsp.mkdir(dir, { recursive: true });
  for (const f of r.filePaths.slice(0, 8)) {
    const ext = (path.extname(f) || '.png').toLowerCase();
    const fileName = `custom_${Date.now()}_${Math.random().toString(36).slice(2, 5)}${ext}`;
    await fsp.copyFile(f, path.join(dir, fileName));
    entry.customThumbs = [fileName, ...(entry.customThumbs || [])];
    thumbs.prefetch(path.join(dir, fileName), { root: vault.root, userData: app.getPath('userData'), id, name: fileName });
  }
  vault.record([{ op: 'item:set', item: entry }]);
  return { ok: true, item: view(entry) };
});

ipcMain.handle('item:pasteThumb', async (_e, id) => {
  const img = clipboard.readImage();
  if (img.isEmpty()) return { ok: false, message: '剪贴板里没有图片' };
  const entry = vault.findItem(id);
  if (!entry) return { ok: false, message: '先选中一个资产' };

  const dir = path.join(vault.root, 'prev', id);
  await fsp.mkdir(dir, { recursive: true });
  const fileName = `custom_${Date.now()}.png`;
  await fsp.writeFile(path.join(dir, fileName), img.toPNG());
  entry.customThumbs = [fileName, ...(entry.customThumbs || [])];
  vault.record([{ op: 'item:set', item: entry }]);
  thumbs.prefetch(path.join(dir, fileName), { root: vault.root, userData: app.getPath('userData'), id, name: fileName });
  return { ok: true, item: view(entry) };
});

ipcMain.handle('item:removeThumb', async (_e, id, fileName) => {
  const entry = vault.findItem(id);
  if (!entry) return { ok: false };
  entry.customThumbs = (entry.customThumbs || []).filter((f) => f !== fileName);
  for (const arr of ['thumbs', 'customThumbs']) {
    if (!(entry[arr] || []).includes(fileName)) {
      try { await fsp.rm(path.join(vault.root, 'prev', id, fileName), { force: true }); } catch (_) { /* ignore */ }
    }
  }
  vault.record([{ op: 'item:set', item: entry }]);
  return { ok: true, item: view(entry) };
});

/* ---------------- 整库导出 / 导入 ---------------- */

ipcMain.handle('library:export', async (event) => {
  const sender = event.sender;
  const pick = await dialog.showMessageBox(win, {
    type: 'question',
    title: '导出整库',
    message: '把整个素材库搬到别的电脑？',
    detail: '含原件、示意图、索引。对方用「导入备份」合并即可。',
    buttons: ['打包成单个 zip', '导出为文件夹', '取消'],
    defaultId: 0,
    cancelId: 2,
  });
  if (pick.response === 2) return { ok: false };
  const r = await dialog.showOpenDialog(win, {
    title: '选择导出位置',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return { ok: false };

  await vault.flush();
  const res = await portable.exportLibrary(vault.root, r.filePaths[0], {
    asZip: pick.response === 0,
    index: vault.index,
    onProgress: (p) => {
      if (!sender.isDestroyed()) sender.send('library:progress', { ...p, phase: 'export' });
    },
  });
  if (res.dest) await shell.showItemInFolder(res.dest);
  return { ...res };
});

/** 判断一个 zip 是不是 AvatarVault 备份（根目录或套一层文件夹后有 index.json） */
function normZipName(n) {
  return String(n || '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
}

async function fileExists(p) {
  try { await fsp.access(p); return true; } catch (_) { return false; }
}

/** 备份可能多套了一层文件夹（手机文件管理器/压缩工具常见），向下找 index.json。 */
async function findBackupDir(dir, depth = 0) {
  if (await fileExists(path.join(dir, 'index.json'))) return dir;
  if (depth >= 3) return null;
  let list = [];
  try { list = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return null; }
  for (const e of list) {
    if (!e.isDirectory()) continue;
    const found = await findBackupDir(path.join(dir, e.name), depth + 1);
    if (found) return found;
  }
  return null;
}

async function isBackupZip(filePath) {
  const names = (await listZipNames(filePath)).map(normZipName);
  return names.some((n) => /(^|\/)index\.json$/.test(n));
}

/** 真正的导入流程：picked 可以是 zip 或备份文件夹 */
async function runImport(sender, picked) {
  let srcDir = picked;
  let tmp = null;
  let nameMap = null;
  const st = await fsp.stat(picked);
  if (!st.isDirectory()) {
    tmp = path.join(app.getPath('temp'), 'av-import-' + Date.now());
    await fsp.mkdir(tmp, { recursive: true });
    nameMap = new Map();
    if (!sender.isDestroyed()) sender.send('library:progress', { phase: 'unzip', done: 0, total: 1 });
    await extractZipAll(picked, tmp, (p) => {
      if (!sender.isDestroyed()) {
        sender.send('library:progress', { phase: 'unzip', ...p, done: p.index, total: p.total });
      }
    }, nameMap);
    srcDir = await findBackupDir(tmp);
    if (!srcDir) throw new Error('zip 里没有 index.json，不是 AvatarVault 备份');
  } else {
    srcDir = await findBackupDir(picked);
    if (!srcDir) throw new Error('这个文件夹里没有 index.json，不是 AvatarVault 备份');
  }

  try {
    const res = await portable.importLibrary(vault.root, srcDir, {
      index: vault.index,
      nameMap,
      onProgress: (p) => {
        if (!sender.isDestroyed()) sender.send('library:progress', { ...p, phase: 'import' });
      },
    });
    await vault.replace(vault.index);
    const addedItems = (res.addedIds || []).map((id) => vault.findItem(id)).filter(Boolean).map(view);
    return {
      ok: true,
      added: res.added,
      addedIds: res.addedIds,
      addedItems,
      skipped: res.skipped,
      failed: res.failed,
      notices: res.notices,
      catAdded: res.catAdded,
      total: res.total,
      ...libraryExtras(),
    };
  } finally {
    if (tmp) { try { await fsp.rm(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ } }
  }
}

ipcMain.handle('library:import', async (event) => {
  const sender = event.sender;

  // Windows 的打开对话框不能同时选文件和文件夹，先问清楚再开对应对话框
  const ask = await dialog.showMessageBox(win, {
    type: 'question',
    title: '从备份导入',
    message: '备份是什么形式？',
    detail: 'zip 备份选第一项，文件夹备份选第二项。也能直接拖 zip 进窗口。',
    buttons: ['zip 文件', '备份文件夹', '取消'],
    defaultId: 0,
    cancelId: 2,
  });
  if (ask.response === 2) return { ok: false, canceled: true };

  const opts = ask.response === 0
    ? {
        title: '选择备份 zip',
        properties: ['openFile'],
        filters: [
          { name: 'AvatarVault 备份', extensions: ['zip'] },
          { name: '全部文件', extensions: ['*'] },
        ],
      }
    : { title: '选择备份文件夹', properties: ['openDirectory'] };

  const r = await dialog.showOpenDialog(win, opts);
  if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };

  const picked = r.filePaths[0];
  try {
    const isDir = (await fsp.stat(picked)).isDirectory();
    if (!isDir) {
      if (!/\.zip$/i.test(picked)) {
        return { ok: false, message: '只能导入 zip 备份或备份文件夹' };
      }
      if (!(await isBackupZip(picked))) {
        return { ok: false, message: '这个 zip 里没有 index.json，不是 AvatarVault 备份' };
      }
    }
    return await runImport(sender, picked);
  } catch (err) {
    return { ok: false, message: '导入失败：' + err.message };
  }
});

function sanitize(s) {
  return String(s).replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || 'collection';
}
