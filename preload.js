'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

let dropHandler = null;
let dragStateHandler = null;

function emitDragState(v) {
  if (dragStateHandler) { try { dragStateHandler(v); } catch (_) { /* ignore */ } }
}

// 外部文件拖入窗口：Electron 32 起 File.path 已移除，必须用 webUtils
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (!e.dataTransfer) return;
  try { e.dataTransfer.dropEffect = 'copy'; } catch (_) { /* ignore */ }
  emitDragState(true);
}, true);

window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  e.stopPropagation();
  emitDragState(true);
}, true);

window.addEventListener('dragleave', (e) => {
  // 只在整个窗口真正离开时收起提示
  if (e.clientX <= 0 || e.clientY <= 0 ||
      e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) {
    emitDragState(false);
  }
}, true);

window.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  emitDragState(false);
  const paths = [];
  const files = (e.dataTransfer && e.dataTransfer.files) || [];
  for (const f of files) {
    try {
      const p = webUtils.getPathForFile(f);
      if (p) paths.push(p);
    } catch (_) { /* ignore */ }
  }
  if (!paths.length) return;
  // 忽略从素材库自己拖出来的文件（避免重复入库）
  if (paths.every((p) => /\\orig\\|\/orig\//.test(p))) return;
  if (dropHandler) { try { dropHandler(paths); } catch (_) { /* ignore */ } }
}, true);

const api = {
  loadState: () => ipcRenderer.invoke('state:get'),
  chooseRoot: () => ipcRenderer.invoke('library:chooseRoot'),
  initRoot: (mode) => ipcRenderer.invoke('library:initRoot', mode),
  revealLibrary: () => ipcRenderer.invoke('library:reveal'),
  pickFiles: () => ipcRenderer.invoke('ingest:pickFiles'),
  pickFolder: () => ipcRenderer.invoke('ingest:pickFolder'),
  ingest: (paths) => ipcRenderer.invoke('ingest:paths', paths),
  startDrag: (id) => ipcRenderer.invoke('drag:start', id),
  addCategory: (name) => ipcRenderer.invoke('cat:add', name),
  renameCategory: (key, name) => ipcRenderer.invoke('cat:rename', key, name),
  deleteCategory: (key) => ipcRenderer.invoke('cat:delete', key),
  orderCategories: (keys) => ipcRenderer.invoke('cat:order', keys),
  updateItem: (id, patch) => ipcRenderer.invoke('item:update', id, patch),
  batchUpdateItems: (ids, patch) => ipcRenderer.invoke('item:batchUpdate', ids, patch),
  batchDeleteItems: (ids) => ipcRenderer.invoke('item:batchDelete', ids),
  fetchBooth: (id, force) => ipcRenderer.invoke('item:fetchBooth', id, !!force),
  refreshStats: (id) => ipcRenderer.invoke('item:refreshStats', id),
  deleteItem: (id) => ipcRenderer.invoke('item:delete', id),
  revealItem: (id) => ipcRenderer.invoke('item:reveal', id),
  pickThumbImage: (id) => ipcRenderer.invoke('item:pickThumbImage', id),
  pasteThumb: (id) => ipcRenderer.invoke('item:pasteThumb', id),
  removeThumb: (id, file) => ipcRenderer.invoke('item:removeThumb', id, file),
  exportLibrary: () => ipcRenderer.invoke('library:export'),
  importLibrary: () => ipcRenderer.invoke('library:import'),
  onLibraryProgress: (cb) => ipcRenderer.on('library:progress', (_e, d) => cb(d)),
  createBundle: (payload) => ipcRenderer.invoke('bundle:create', payload),
  restoreBundle: (id) => ipcRenderer.invoke('bundle:restore', id),
  createStack: (payload) => ipcRenderer.invoke('stack:create', payload),
  dissolveStack: (id) => ipcRenderer.invoke('stack:dissolve', id),
  saveCollection: (payload) => ipcRenderer.invoke('collection:save', payload),
  deleteCollection: (id) => ipcRenderer.invoke('collection:delete', id),
  addToCollection: (payload) => ipcRenderer.invoke('collection:add', payload),
  removeFromCollection: (payload) => ipcRenderer.invoke('collection:remove', payload),
  moveCollectionItem: (payload) => ipcRenderer.invoke('collection:move', payload),
  dragCollection: (id) => ipcRenderer.invoke('collection:drag', id),
  exportCollection: (id, mode) => ipcRenderer.invoke('collection:export', id, mode),
  onIngestProgress: (cb) => ipcRenderer.on('ingest:progress', (_e, d) => cb(d)),
  onExportProgress: (cb) => ipcRenderer.on('export:progress', (_e, d) => cb(d)),
  onDrop: (cb) => { dropHandler = cb; },
  onDragState: (cb) => { dragStateHandler = cb; },
  platform: process.platform,
};

contextBridge.exposeInMainWorld('avApi', api);
