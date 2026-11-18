'use strict';

/* ================= 基础工具 ================= */
const $ = (sel) => document.querySelector(sel);

const DEFAULT_CATS = [
  { key: 'base', name: '素体' },
  { key: 'cloth', name: '服装' },
  { key: 'makeup', name: '妆容' },
  { key: 'prop', name: '道具' },
  { key: 'material', name: '着色球' },
  { key: 'other', name: '未分类' },
];
function cats() {
  const l = ((state.index && state.index.categories) || []).filter((c) => c && c.key);
  return l.length ? l : DEFAULT_CATS;
}
function catKeys() { return cats().map((c) => c.key); }
function catLabel(k) {
  const c = cats().find((x) => x.key === k);
  return c ? c.name : '未分类';
}

function fmtSize(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
function fmtMB(n) { return (Math.round(n * 10) / 10) + ' MB'; }

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 1900);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

async function readRange(rel, offset, len) {
  const b64 = AV.readChunk(rel, offset, len);
  if (!b64) return new Uint8Array(0);
  return b64ToBytes(b64);
}

/* ================= 类目识别（与电脑端同一套规则） ================= */
const RULES = [
  { key: 'base', words: ['素体', 'body', 'base_body', 'basemodel', 'base model', 'avatar', 'armature',
    'humanoid', 'head mesh', 'face mesh', '__body', 'body_mesh', 'hybrid', 'headmesh'] },
  { key: 'cloth', words: ['服装', '衣', 'clothes', 'cloth', 'outfit', 'costume', 'dress', 'skirt', 'shirt',
    'hoodie', 'jacket', 'pants', 'trousers', 'sock', 'shoe', 'boot', 'hair', 'ponytail', 'sweater', 'coat'] },
  { key: 'makeup', words: ['妆容', 'makeup', 'make_up', 'face_tex', 'facetex', 'decal', 'tattoo', 'eyebrow',
    'eyelash', 'eyeshadow', 'lip', 'blush', 'face_texture', 'eye_texture'] },
  { key: 'prop', words: ['道具', 'prop', 'weapon', 'accessory', 'gimmick', 'hat', 'glasses', 'earring', 'ring',
    'sword', 'gun', 'tail', 'wing', 'halo', 'bag', 'pin', 'ornament'] },
  { key: 'material', words: ['material', '材质', '着色球', '.mat', '.shader', 'matcap', 'poiyomi', 'liltoon',
    'shader preset'] },
];

function classify(pathnames, fallbackName) {
  const blob = (pathnames.join('\n') + '\n' + (fallbackName || '')).toLowerCase();
  if (!blob.trim()) return 'other';
  const scores = {};
  for (const rule of RULES) {
    let score = 0;
    for (const w of rule.words) {
      let idx = 0;
      let hits = 0;
      const needle = w.toLowerCase();
      while ((idx = blob.indexOf(needle, idx)) !== -1 && hits < 40) { score++; hits++; idx += needle.length; }
    }
    scores[rule.key] = score;
  }
  const matCount = pathnames.filter((p) => p.toLowerCase().endsWith('.mat')).length;
  if (pathnames.length && matCount / pathnames.length > 0.6) scores.material += 8;
  let best = 'other';
  let bestScore = 0;
  for (const k in scores) if (scores[k] > bestScore) { bestScore = scores[k]; best = k; }
  return bestScore >= 2 ? best : 'other';
}

/* ================= 包解析 ================= */
const IMG_EXT = ['png', 'jpg', 'jpeg', 'tga', 'psd', 'exr', 'tif', 'tiff', 'webp'];

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

function statsFromNames(names) {
  const stats = { assetCount: 0, materials: 0, fbx: 0, textures: 0, prefabs: 0, animations: 0, vramMB: 0 };
  for (const n of names) {
    const e = extOf(n);
    if (e === 'mat') stats.materials++;
    else if (e === 'fbx') stats.fbx++;
    else if (e === 'prefab') stats.prefabs++;
    else if (e === 'anim') stats.animations++;
    else if (IMG_EXT.includes(e)) stats.textures++;
  }
  stats.assetCount = names.length;
  return stats;
}

/* ---- zip：读中央目录 ---- */
async function inspectZip(rel, size) {
  const tailLen = Math.min(size, 66000);
  const tail = await readRange(rel, size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const cdCount = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (!cdCount || !cdSize || cdOffset > size) return null;
  const cd = await readRange(rel, cdOffset, cdSize);
  const names = [];
  let p = 0;
  const dv2 = () => new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  for (let i = 0; i < cdCount && p + 46 <= cd.length; i++) {
    const v = dv2();
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const name = new TextDecoder('utf-8').decode(cd.subarray(p + 46, p + 46 + nameLen));
    if (!/\/$/.test(name) && !/^__MACOSX\//.test(name) && name !== '.DS_Store') names.push(name);
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!names.length) return null;
  return { names, stats: statsFromNames(names) };
}

/* ---- .unitypackage：流式 gunzip + tar 扫描 ---- */
async function inspectUnityPackage(rel, size, onProgress) {
  if (typeof DecompressionStream === 'undefined') return null;
  let pos = 0;
  const src = new ReadableStream({
    async pull(ctrl) {
      if (pos >= size) { ctrl.close(); return; }
      const want = Math.min(262144, size - pos);
      const bytes = await readRange(rel, pos, want);
      if (!bytes.length) { ctrl.close(); return; }
      pos += want;
      if (onProgress) onProgress(pos / size);
      ctrl.enqueue(bytes);
    },
  });
  const reader = src.pipeThrough(new DecompressionStream('gzip')).getReader();

  let buf = new Uint8Array(0);
  async function fill(n) {
    while (buf.length < n) {
      const { done, value } = await reader.read();
      if (done) return false;
      const joined = new Uint8Array(buf.length + value.length);
      joined.set(buf, 0);
      joined.set(value, buf.length);
      buf = joined;
    }
    return true;
  }
  const dec = new TextDecoder('utf-8');
  const dirs = new Map(); // dir -> { path:'', assetSize:0 }
  const texBytes = { v: 0 };

  while (true) {
    if (!(await fill(512))) break;
    let name = dec.decode(buf.subarray(0, 100)).replace(/\0.*$/, '').trim();
    if (!name) break; // 结束块
    const sizeRaw = dec.decode(buf.subarray(124, 136)).replace(/\0.*$/, '').trim();
    const sizeField = parseInt(sizeRaw, 8) || 0;
    const need = 512 + sizeField + ((512 - (sizeField % 512)) % 512);
    if (!(await fill(need))) break;
    const data = buf.subarray(512, 512 + sizeField);
    buf = buf.slice(need);

    const base = name.replace(/^\.\//, '');
    const seg = base.split('/');
    const dir = seg.length > 1 ? seg[0] : '';
    let rec = dirs.get(dir);
    if (!rec) { rec = { path: '', assetSize: 0 }; dirs.set(dir, rec); }

    const bn = base.split('/').pop();
    if (bn === 'pathname') {
      rec.path = dec.decode(data).trim().replace(/\r/g, '');
    } else if (bn === 'asset') {
      rec.assetSize = sizeField;
      if (IMG_EXT.includes(extOf(rec.path))) texBytes.v += sizeField;
    }
  }

  const paths = [];
  for (const rec of dirs.values()) if (rec.path) paths.push(rec.path);
  if (!paths.length) return null;
  const stats = statsFromNames(paths);
  stats.assetCount = dirs.size;
  stats.vramMB = Math.round((texBytes.v / 1048576) * 10) / 10;
  return { names: paths, stats };
}

/* ---------- 自绘确认框（WebView 默认不支持 confirm） ---------- */
function ask(msg, okLabel, danger) {
  return new Promise((resolve) => {
    const modal = $('#modal');
    $('#modalText').textContent = msg;
    const ok = $('#modalOk');
    ok.textContent = okLabel || '确定';
    ok.className = 'btn ' + (danger ? 'danger' : 'primary');
    modal.classList.remove('hidden');
    const done = (v) => {
      modal.classList.add('hidden');
      ok.onclick = null;
      $('#modalCancel').onclick = null;
      modal.onclick = null;
      resolve(v);
    };
    ok.onclick = () => done(true);
    $('#modalCancel').onclick = () => done(false);
    modal.onclick = (e) => { if (e.target === modal) done(false); };
  });
}

/* ================= 状态 ================= */
const state = {
  index: { version: 1, items: [], collections: [] },
  filter: 'all',
  q: '',
  thumbCache: new Map(),
  current: null,
};

function saveIndex() {
  AV.saveIndex(JSON.stringify(state.index, null, 2));
}

function cleanName(name) {
  return String(name || '').replace(/\.(unitypackage|zip|rar|7z)$/i, '').trim() || '未命名';
}

/* ================= 入库 ================= */
window.onAssetsPicked = async function (list) {
  if (!list || !list.length) return;
  for (const meta of list) {
    toast('识别中…');
    let parsed = null;
    const ext = extOf(meta.name);
    const size = meta.size || 0;
    try {
      if (ext === 'zip') parsed = await inspectZip(meta.relPath, size);
      else if (ext === 'unitypackage') parsed = await inspectUnityPackage(meta.relPath, size);
    } catch (e) {
      parsed = null;
    }
    const stats = parsed ? parsed.stats : { assetCount: 0, materials: 0, fbx: 0, textures: 0, prefabs: 0, animations: 0, vramMB: 0 };
    const category = parsed ? classify(parsed.names, cleanName(meta.name)) : 'other';
    const entry = {
      id: meta.id,
      hash: '',
      name: cleanName(meta.name),
      category,
      kind: ext || 'file',
      refOnly: false,
      originPath: '',
      storedPath: meta.relPath,
      sizeBytes: size,
      stats,
      thumbs: [],
      customThumbs: [],
      tags: [],
      favorite: false,
      notes: '',
      addedAt: Date.now(),
      lastUsed: 0,
      categorySource: 'auto',
    };
    state.index.items.unshift(entry);
    saveIndex();
  }
  render();
  toast('已入库 ' + list.length);
};

window.onImageSaved = function (itemId, fname) {
  const item = state.index.items.find((x) => x.id === itemId);
  if (!item) return;
  item.customThumbs = item.customThumbs || [];
  item.customThumbs.unshift(fname);
  state.thumbCache.delete(itemId + '/' + fname);
  saveIndex();
  render();
  if (state.current && state.current.id === itemId) openSheet(item);
  toast('已加示意图');
};

/* ================= 渲染 ================= */
function counts() {
  const c = { all: state.index.items.length };
  const keys = catKeys();
  for (const k of keys) c[k] = 0;
  for (const it of state.index.items) {
    const k = keys.includes(it.category) ? it.category : 'other';
    c[k] = (c[k] || 0) + 1;
  }
  return c;
}

function renderChips() {
  const c = counts();
  const keys = catKeys();
  if (state.filter !== 'all' && !keys.includes(state.filter)) state.filter = 'all';
  $('#chips').innerHTML =
    `<div class="chip ${state.filter === 'all' ? 'on' : ''}" data-k="all">全部<b>${c.all}</b></div>` +
    cats().map((cc) =>
      `<div class="chip ${state.filter === cc.key ? 'on' : ''}" data-k="${cc.key}" data-name="${escapeHtml(cc.name)}">${escapeHtml(cc.name)}<b>${c[cc.key] || 0}</b></div>`
    ).join('') +
    `<div class="chip chip-add" data-k="__add">＋ 类目</div>`;
}

function visibleItems() {
  const q = state.q.trim().toLowerCase();
  return state.index.items.filter((it) => {
    if (state.filter !== 'all' && (it.category || 'other') !== state.filter) return false;
    if (!q) return true;
    const hay = [it.name, (it.tags || []).join(' '), it.notes || '', catLabel(it.category)].join(' ').toLowerCase();
    return hay.includes(q);
  });
}

function thumbFor(item, file) {
  const key = item.id + '/' + file;
  if (state.thumbCache.has(key)) return state.thumbCache.get(key);
  const data = AV.imageData('prev/' + item.id + '/' + file);
  state.thumbCache.set(key, data || '');
  return data || '';
}

function render() {
  renderChips();
  const list = visibleItems();
  const grid = $('#grid');
  $('#empty').classList.toggle('hidden', list.length > 0);
  grid.innerHTML = list.map((it) => {
    const f = (it.customThumbs || [])[0];
    const data = f ? thumbFor(it, f) : '';
    const cover = data
      ? `<img src="${data}" alt="">`
      : `<div class="ph">无示意图</div>`;
    const s = it.stats || {};
    return `<div class="card" data-id="${it.id}">
      <div class="cover">${cover}
        <div class="cat">${escapeHtml(catLabel(it.category))}</div>
        ${it.favorite ? '<div class="fav">★</div>' : ''}
      </div>
      <div class="meta">
        <p class="name">${escapeHtml(it.name)}</p>
        <div class="sub">${s.assetCount || 0} 资产 · ${fmtSize(it.sizeBytes)}</div>
      </div>
    </div>`;
  }).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

$('#grid').addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  const item = state.index.items.find((x) => x.id === card.dataset.id);
  if (item) openSheet(item);
});

/* ================= 详情面板 ================= */
function openSheet(item) {
  state.current = item;
  const s = item.stats || {};
  const files = item.customThumbs || [];
  const big = files.length ? thumbFor(item, files[0]) : '';
  $('#sheetBody').innerHTML = `
    <h2>${escapeHtml(item.name)}</h2>
    <div class="big">${big ? `<img src="${big}" alt="">` : '<div class="ph">还没有示意图</div>'}</div>
    <div class="thumbs">
      ${files.map((f) => `<div class="thumb" data-f="${f}"><img src="${thumbFor(item, f) || ''}" alt="">
        <button class="thumb-x" data-del="${f}" aria-label="移除">×</button></div>`).join('')}
      <div class="thumb add" id="addImg">＋</div>
    </div>
    <div class="row">
      <select id="catSel">
        ${cats().map((cc) => `<option value="${cc.key}" ${item.category === cc.key ? 'selected' : ''}>${escapeHtml(cc.name)}</option>`).join('')}
      </select>
    </div>
    <div class="row">
      <input id="tagsInput" type="text" placeholder="标签，用逗号分隔，例如：JK, 日系" value="${escapeHtml((item.tags || []).join(', '))}">
    </div>
    <div class="stats">
      <div class="stat"><span>资产文件</span><b>${s.assetCount || 0} 个</b></div>
      <div class="stat"><span>材质球</span><b>${s.materials || 0}</b></div>
      <div class="stat"><span>贴图</span><b>${s.textures || 0}</b></div>
      <div class="stat"><span>Prefab</span><b>${s.prefabs || 0}</b></div>
      <div class="stat"><span>预估显存</span><b>${s.vramMB ? fmtMB(s.vramMB) : '—'}</b></div>
      <div class="stat"><span>文件体积</span><b>${fmtSize(item.sizeBytes)}</b></div>
    </div>
    <textarea id="notes" placeholder="备注：出处、作者、注意事项…">${escapeHtml(item.notes || '')}</textarea>
    <div class="btnrow" style="margin-top:12px">
      <button class="btn" id="btnFav">${item.favorite ? '★ 已收藏' : '☆ 收藏'}</button>
      <button class="btn danger" id="btnDel">删除</button>
    </div>
    <div class="btnrow">
      <button class="btn primary" id="btnClose">收起</button>
    </div>
  `;
  $('#sheet').classList.remove('hidden');

  $('#addImg').onclick = () => AV.pickImage(item.id);
  $('#catSel').onchange = (e) => { item.category = e.target.value; item.categorySource = 'user'; saveIndex(); render(); renderChips(); };
  $('#tagsInput').onchange = (e) => {
    item.tags = e.target.value.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
    saveIndex();
  };
  $('#notes').onchange = (e) => { item.notes = e.target.value; saveIndex(); };
  $('#btnFav').onclick = (e) => {
    item.favorite = !item.favorite;
    e.target.textContent = item.favorite ? '★ 已收藏' : '☆ 收藏';
    saveIndex(); render();
  };
  $('#btnClose').onclick = closeSheet;
  $('#btnDel').onclick = async () => {
    const go = await ask('删除「' + item.name + '」？\n原件和示意图一起删。', '删除', true);
    if (!go) return;
    AV.removeItem(item.id);
    state.index.items = state.index.items.filter((x) => x.id !== item.id);
    saveIndex(); closeSheet(); render();
    toast('已删除');
  };
  // 点小叉：删掉这一张示意图
  $('#sheetBody').querySelectorAll('.thumb-x').forEach((btn) => {
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      const f = btn.dataset.del;
      const go = await ask('移除这张示意图？\n原件不动。', '移除', true);
      if (!go) return;
      const ok = AV.deleteImage(item.id, f);
      if (!ok) { toast('移除失败'); return; }
      item.customThumbs = (item.customThumbs || []).filter((x) => x !== f);
      state.thumbCache.delete(item.id + '/' + f);
      saveIndex();
      render();
      if (state.current && state.current.id === item.id) openSheet(item); else closeSheet();
      toast('已移除');
    };
  });

  // 点缩略图看大图
  $('#sheetBody').querySelectorAll('.thumb[data-f]').forEach((el) => {
    el.onclick = () => {
      const data = thumbFor(item, el.dataset.f);
      if (!data) return;
      $('#viewerImg').src = data;
      $('#viewer').classList.remove('hidden');
    };
  });
}

function closeSheet() {
  $('#sheet').classList.add('hidden');
  state.current = null;
}

$('#sheet').addEventListener('click', (e) => {
  if (e.target.id === 'sheet') closeSheet();
});
$('#viewer').addEventListener('click', () => $('#viewer').classList.add('hidden'));

/* ================= 交互 ================= */
$('#chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  if (chip.dataset.k === '__add') { addCategory(); return; }
  state.filter = chip.dataset.k;
  render();
});

/* ================= 类目增删改（与电脑端一致） ================= */
function askInput(title, value) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:99;display:flex;align-items:center;justify-content:center;background:rgba(4,8,11,.78)';
    wrap.innerHTML = `<div style="width:78%;max-width:340px;background:#111821;border:1px solid #253541;border-radius:14px;padding:16px">
      <div style="font-size:13px;color:#cfdae0;margin-bottom:10px">${escapeHtml(title)}</div>
      <input id="mInput" maxlength="12" value="${escapeHtml(value || '')}" style="width:100%;box-sizing:border-box;background:#0b1117;border:1px solid #24323d;border-radius:10px;color:#dbe6ea;font-size:15px;padding:10px">
      <div style="display:flex;gap:10px;margin-top:14px">
        <button id="mCancel" style="flex:1;background:#1b2630;border:1px solid #253541;color:#cfdae0;border-radius:10px;padding:11px;font-size:14px">取消</button>
        <button id="mOk" style="flex:1;background:#2c9c96;border:0;color:#04191a;border-radius:10px;padding:11px;font-size:14px">确定</button>
      </div></div>`;
    document.body.appendChild(wrap);
    const inp = wrap.querySelector('#mInput');
    inp.focus();
    const done = (v) => { wrap.remove(); resolve(v); };
    wrap.querySelector('#mOk').onclick = () => done(inp.value.trim());
    wrap.querySelector('#mCancel').onclick = () => done(null);
    inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') done(inp.value.trim()); });
  });
}

function pickMenu(title, actions) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:98;display:flex;align-items:flex-end;background:rgba(4,8,11,.7)';
    wrap.innerHTML = `<div style="width:100%;background:#111821;border-radius:16px 16px 0 0;padding:14px 14px 22px">
      <div style="font-size:12.5px;color:#7f98a3;margin:2px 0 10px 4px">${escapeHtml(title)}</div>
      ${actions.map((a, i) => `<button data-i="${i}" style="display:block;width:100%;text-align:left;background:#16202a;border:0;color:${a.danger ? '#ff9d9d' : '#cfdae0'};font-size:15px;padding:14px;border-radius:10px;margin-bottom:8px">${escapeHtml(a.label)}</button>`).join('')}
      <button data-i="-1" style="display:block;width:100%;background:transparent;border:0;color:#7f98a3;font-size:14px;padding:12px">取消</button></div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener('click', (ev) => {
      const b = ev.target.closest('button');
      if (!b) { return; }
      const i = Number(b.dataset.i);
      wrap.remove();
      resolve(i < 0 ? null : actions[i]);
    });
  });
}

async function addCategory() {
  const nm = await askInput('新建类目', '');
  if (!nm) return;
  if (nm.length > 12) return AV.toastMsg('类目名最长 12 个字');
  if (cats().some((c) => c.name === nm)) return AV.toastMsg('已有同名类目');
  const key = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
  state.index.categories = cats().concat([{ key, name: nm }]);
  saveIndex();
  renderChips();
  AV.toastMsg('已新建类目');
}
function moveCategory(key, dir) {
  const keys = cats().map((c) => c.key);
  const i = keys.indexOf(key);
  const to = i + dir;
  if (i < 0 || to < 0 || to >= keys.length) return;
  const next = keys.slice();
  next.splice(i, 1);
  next.splice(to, 0, key);
  state.index.categories = next.map((k) => cats().find((c) => c.key === k)).filter(Boolean);
  saveIndex();
  renderChips();
  render();
  AV.toastMsg('顺序已更新');
}
async function renameCategory(k) {
  const cur = catLabel(k);
  const nm = await askInput('重命名类目', cur);
  if (!nm || nm === cur) return;
  if (nm.length > 12) return AV.toastMsg('类目名最长 12 个字');
  if (cats().some((c) => c.name === nm && c.key !== k)) return AV.toastMsg('已有同名类目');
  state.index.categories = cats().map((c) => (c.key === k ? { key: c.key, name: nm } : c));
  saveIndex();
  renderChips();
  render();
  AV.toastMsg('类目已改名');
}
async function deleteCategory(k, name) {
  if (k === 'other') return AV.toastMsg('「未分类」不能删');
  const n = state.index.items.filter((it) => it.category === k).length;
  const ok = await ask(
    n ? `删除类目「${name}」？\n${n} 个素材会移到「未分类」，文件不动。` : `删除类目「${name}」？`,
    '删除', true
  );
  if (!ok) return;
  for (const it of state.index.items) if (it.category === k) it.category = 'other';
  state.index.categories = cats().filter((c) => c.key !== k);
  if (state.filter === k) state.filter = 'all';
  saveIndex();
  renderChips();
  render();
  AV.toastMsg(n ? `已删除，${n} 个移到未分类` : '类目已删除');
}
/* 长按类目 → 改名 / 删除 */
(function bindCatLongPress() {
  const chips = $('#chips');
  let timer = null, target = null, moved = false;
  const open = async () => {
    const k = target && target.dataset.k;
    if (!k || k === 'all' || k === '__add') return;
    const name = catLabel(k);
    const keys = cats().map((c) => c.key);
    const idx = keys.indexOf(k);
    const acts = [];
    if (idx > 0) acts.push({ label: '上移', key: 'up' });
    if (idx >= 0 && idx < keys.length - 1) acts.push({ label: '下移', key: 'down' });
    acts.push({ label: '重命名', key: 'r' });
    acts.push({ label: '删除这个类目', key: 'd', danger: k !== 'other' });
    const a = await pickMenu(name, acts);
    if (!a) return;
    if (a.key === 'up') moveCategory(k, -1);
    if (a.key === 'down') moveCategory(k, 1);
    if (a.key === 'r') renameCategory(k);
    if (a.key === 'd') deleteCategory(k, name);
  };
  chips.addEventListener('touchstart', (e) => {
    const c = e.target.closest('.chip'); if (!c) return;
    target = c; moved = false;
    clearTimeout(timer);
    timer = setTimeout(() => { if (!moved) open(); }, 480);
  }, { passive: true });
  chips.addEventListener('touchmove', () => { moved = true; clearTimeout(timer); }, { passive: true });
  chips.addEventListener('touchend', () => clearTimeout(timer));
  chips.addEventListener('contextmenu', (e) => { const c = e.target.closest('.chip'); if (!c) return; e.preventDefault(); target = c; open(); });
})();

let qTimer = null;
$('#q').addEventListener('input', (e) => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => { state.q = e.target.value; render(); }, 120);
});

$('#btnAdd').onclick = () => AV.pickAssets();

$('#btnExport').onclick = async () => {
  if (!state.index.items.length) { toast('库是空的'); return; }
  const n = state.index.items.length;
  const go = await ask('打包 ' + n + ' 个素材（含示意图）？\n传电脑后「导入备份」。', '打包');
  if (!go) return;
  AV.exportVault();
};

window.onAndroidBack = function () {
  if (!$('#viewer').classList.contains('hidden')) { $('#viewer').classList.add('hidden'); return true; }
  if (!$('#sheet').classList.contains('hidden')) { closeSheet(); return true; }
  AV.moveToBack();
  return true;
};

/* ================= 启动 ================= */
(function boot() {
  try {
    const raw = AV.index();
    const parsed = JSON.parse(raw || '{}');
    state.index = {
      version: parsed.version || 1,
      items: Array.isArray(parsed.items) ? parsed.items : [],
      collections: Array.isArray(parsed.collections) ? parsed.collections : [],
      categories: Array.isArray(parsed.categories) && parsed.categories.length
        ? parsed.categories.map((c) => ({ key: String(c.key), name: String(c.name || '') }))
        : cats(),
    };
  } catch (e) {
    state.index = { version: 1, items: [], collections: [], categories: cats() };
  }
  for (const it of state.index.items) {
    it.customThumbs = it.customThumbs || [];
    it.tags = it.tags || [];
    it.stats = it.stats || { assetCount: 0, materials: 0, fbx: 0, textures: 0, prefabs: 0, animations: 0, vramMB: 0 };
  }
  render();
})();
