'use strict';

const api = window.avApi;

const CATEGORY_LABEL = {
  base: '素体', cloth: '服装', makeup: '妆容', prop: '道具', material: '着色球', other: '未分类',
};
const CATEGORY_ORDER = ['base', 'cloth', 'makeup', 'prop', 'material', 'other'];
const DEFAULT_CATS = CATEGORY_ORDER.map((k) => ({ key: k, name: CATEGORY_LABEL[k] }));
function catList() {
  const l = (state.categories || []).filter((c) => c && c.key);
  return l.length ? l : DEFAULT_CATS;
}
function catLabel(key) {
  const c = catList().find((x) => x.key === key);
  return c ? c.name : (CATEGORY_LABEL[key] || '未分类');
}
function catRank(key) {
  const i = catList().findIndex((x) => x.key === key);
  return i < 0 ? 999 : i;
}
const KIND_LABEL = {
  unitypackage: 'Unity 包', zip: '压缩包', folder: '文件夹引用', file: '单文件',
};

const state = {
  root: '',
  items: [],
  collections: [],
  categories: [],
};

const VIEWS = ['comfortable', 'compact', 'list'];
const savedView = (() => {
  try { return localStorage.getItem('av:view'); } catch (_) { return null; }
})();

const ui = {
  cat: 'all',
  favOnly: false,
  query: '',
  collectionId: null,
  selection: new Set(),
  stacks: [],
  activeId: null,
  previewIdx: 0,
  previewFor: null,
  view: VIEWS.includes(savedView) ? savedView : 'comfortable',
  anchorId: null,
};

const $ = (sel) => document.querySelector(sel);

function thumbURL(id, file, variant) {
  return `avthumb://${encodeURIComponent(String(id))}/${encodeURIComponent(String(file).split(/[\\/]/).pop())}?v=${encodeURIComponent(variant)}`;
}

let gridApi = null;
function ensureGrid() {
  if (gridApi) return gridApi;
  const container = $('#grid');
  const inner = $('#gridInner');
  if (!container || !inner || !window.AVGrid) return null;
  gridApi = new AVGrid.VirtualGrid({
    container,
    inner,
    renderItem: (it) => makeItemCard(it, currentCollection()),
    renderStackCard: makeStackCard,
    renderStackHeader: makeStackHeader,
  });
  return gridApi;
}

/* ---------- 渲染 ---------- */

function fmtCount(n) {
  if (n === undefined || n === null) return '—';
  return n.toLocaleString('zh-CN');
}

function fmtSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  const mb = bytes / 1048576;
  if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
  if (mb >= 1) return mb.toFixed(mb >= 100 ? 0 : 1) + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
}

function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function isBundleItem(item) {
  return !!(item && item.bundle && Array.isArray(item.bundle.memberIds));
}

/** 合并卡的原卡只在普通/类目视图隐藏；进入套装视图时按套装成员照常显示。 */
function isHiddenOriginal(item) {
  return !!(item && item.bundledInto) && !ui.collectionId;
}

function applyStacksFromPayload(list) {
  const expanded = new Map(ui.stacks.map((s) => [s.id, !!s.expanded]));
  ui.stacks = (Array.isArray(list) ? list : []).map((s) => ({
    id: String(s.id),
    itemIds: Array.isArray(s.itemIds) ? [...s.itemIds] : [],
    category: s.category || 'other',
    createdAt: Number(s.createdAt) || Date.now(),
    expanded: !!expanded.get(String(s.id)),
  }));
}

function matches(item) {
  if (ui.favOnly && !item.favorite) return false;
  if (ui.collectionId) {
    const c = state.collections.find((x) => x.id === ui.collectionId);
    if (!c || !c.itemIds.includes(item.id)) return false;
  }
  if (ui.cat !== 'all' && item.category !== ui.cat) return false;
  const q = ui.query.trim().toLowerCase();
  if (!q) return true;
  const memberNames = item.bundle && Array.isArray(item.bundle.memberNames) ? item.bundle.memberNames : [];
  const hay = [item.name, item.category, catLabel(item.category), (item.tags || []).join(' '), item.notes || '', memberNames.join(' ')]
    .join(' ').toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

function currentCollection() {
  return state.collections.find((c) => c.id === ui.collectionId) || null;
}

function visibleItems() {
  const list = state.items.filter((it) => !isHiddenOriginal(it)).filter(matches);
  const c = currentCollection();
  if (c) {
    const order = new Map((c.itemIds || []).map((id, i) => [id, i]));
    list.sort((a, b) => (order.has(a.id) ? order.get(a.id) : 1e9) - (order.has(b.id) ? order.get(b.id) : 1e9));
    return list;
  }
  list.sort((a, b) => {
    const ca = catRank(a.category);
    const cb = catRank(b.category);
    if (ca !== cb) return ca - cb;
    return (b.addedAt || 0) - (a.addedAt || 0);
  });
  return list;
}

/** 当前筛选下真正可见的资产数（不含被合并隐藏的原卡）。 */
function totalVisibleCount() {
  return state.items.filter((it) => !isHiddenOriginal(it)).length;
}

/** 把堆叠插回卡片序列：折叠时用一个堆叠卡占位，展开时在占位处铺开成员。 */
function buildGridUnits(items) {
  const byId = new Map(items.map((it) => [it.id, it]));
  const used = new Set();
  const units = [];
  for (const it of items) {
    if (used.has(it.id)) continue;
    const stack = !ui.collectionId ? ui.stacks.find((s) => s.itemIds.includes(it.id)) : null;
    if (!stack) {
      units.push({ kind: 'item', item: it });
      used.add(it.id);
      continue;
    }
    const members = stack.itemIds.map((id) => byId.get(id)).filter(Boolean);
    if (members.length < 2) {
      units.push({ kind: 'item', item: it });
      used.add(it.id);
      continue;
    }
    units.push({ kind: 'stack', stack, items: members });
    for (const m of members) used.add(m.id);
  }
  return units;
}

/** 删除/合并/改类目后，把失效的堆叠从当前界面清掉；持久状态由主进程负责。 */
function pruneStacks() {
  const byId = new Map(state.items.map((it) => [it.id, it]));
  const used = new Set();
  const usedIds = new Set();
  const next = [];
  for (const stack of ui.stacks) {
    if (!stack || !stack.id || usedIds.has(stack.id)) continue;
    const members = stack.itemIds.map((id) => byId.get(id)).filter(Boolean);
    if (members.length < 2 || members.length !== stack.itemIds.length) continue;
    if (members.some((it) => isBundleItem(it) || it.bundledInto)) continue;
    if (new Set(members.map((it) => it.category || 'other')).size !== 1) continue;
    if (members.some((it) => used.has(it.id))) continue;
    usedIds.add(stack.id);
    members.forEach((it) => used.add(it.id));
    next.push({ ...stack, itemIds: members.map((it) => it.id) });
  }
  ui.stacks = next;
}

function renderCats() {
  const counts = {};
  for (const it of state.items) {
    if (!it.bundledInto) counts[it.category] = (counts[it.category] || 0) + 1;
  }
  const el = $('#cats');
  el.innerHTML = '';
  const mk = (key, label, n) => {
    const b = document.createElement('div');
    b.className = 'cat' + (ui.cat === key ? ' active' : '');
    b.innerHTML = `<span>${label}</span><span class="n">${n}</span>`;
    b.onclick = () => { ui.cat = key; if (key === 'all') ui.collectionId = null; renderAll(); };
    el.appendChild(b);
  };
  mk('all', '全部资产', state.items.filter((it) => !it.bundledInto).length);
  for (const c of catList()) {
    const b = document.createElement('div');
    b.className = 'cat' + (ui.cat === c.key ? ' active' : '');
    b.innerHTML = `<span>${escapeHtml(c.name)}</span><span class="n">${counts[c.key] || 0}</span>`;
    b.onclick = () => { ui.cat = c.key; renderAll(); };
    b.oncontextmenu = (e) => { e.preventDefault(); showCatMenu(e.clientX, e.clientY, c); };
    bindCatDrag(b, c);
    el.appendChild(b);
  }
}

let catDragKey = null;
function bindCatDrag(el, c) {
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    catDragKey = c.key;
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', c.key); } catch (_) {}
  });
  el.addEventListener('dragend', () => {
    catDragKey = null;
    el.classList.remove('dragging');
    document.querySelectorAll('.cat.drop-target').forEach((x) => x.classList.remove('drop-target'));
  });
  el.addEventListener('dragover', (e) => {
    if (!catDragKey || catDragKey === c.key) return;
    e.preventDefault();
    el.classList.add('drop-target');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    el.classList.remove('drop-target');
    if (!catDragKey || catDragKey === c.key) return;
    const keys = catList().map((x) => x.key).filter((k) => k !== catDragKey);
    const at = keys.indexOf(c.key);
    if (at < 0) return;
    keys.splice(at, 0, catDragKey);
    catDragKey = null;
    const r = await api.orderCategories(keys);
    if (!r || !r.ok) return toast('排序失败');
    applyResponse(r);
    toast('类目顺序已更新');
  });
}

function showCatMenu(x, y, c) {
  closeCtx();
  ctxEl = document.createElement('div');
  ctxEl.className = 'ctx';
  ctxEl.style.left = Math.min(x, window.innerWidth - 170) + 'px';
  ctxEl.style.top = Math.min(y, window.innerHeight - 90) + 'px';
  const mk = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => { closeCtx(); fn(); };
    ctxEl.appendChild(b);
  };
  const keys = catList().map((x) => x.key);
  const idx = keys.indexOf(c.key);
  const moveTo = async (dir) => {
    const to = idx + dir;
    if (to < 0 || to >= keys.length) return;
    const next = keys.slice();
    next.splice(idx, 1);
    next.splice(to, 0, c.key);
    const r = await api.orderCategories(next);
    if (!r || !r.ok) return toast('排序失败');
    applyResponse(r);
    toast('类目顺序已更新');
  };
  if (idx > 0) mk('上移', () => moveTo(-1));
  if (idx >= 0 && idx < keys.length - 1) mk('下移', () => moveTo(1));

  mk('重命名', async () => {
    const name = await askText('重命名类目', c.name);
    if (!name) return;
    const r = await api.renameCategory(c.key, name);
    if (!r.ok) return toast(r.message || '重命名失败');
    applyResponse(r);
    toast('类目已改名');
  });
  if (c.key !== 'other') {
    mk('删除这个类目', async () => {
      const n = (state.items || []).filter((it) => it.category === c.key).length;
      const tip = n ? `删除类目「${c.name}」？\n里面的 ${n} 个素材会移到「未分类」，文件不动。`
                    : `删除类目「${c.name}」？`;
      if (!confirm(tip)) return;
      const r = await api.deleteCategory(c.key);
      if (!r.ok) return toast(r.message || '删除失败');
      if (ui.cat === c.key) ui.cat = 'all';
      applyResponse(r);
      toast(n ? `已删除，${n} 个素材移到未分类` : '类目已删除');
    });
  }
  document.body.appendChild(ctxEl);
}

function renderCollections() {
  const el = $('#collections');
  el.innerHTML = '';
  if (!state.collections.length) {
    const d = document.createElement('div');
    d.className = 'side-tip';
    d.style.padding = '2px 8px';
    d.textContent = '还没有套装';
    el.appendChild(d);
    return;
  }
  for (const c of state.collections) {
    const b = document.createElement('div');
    b.className = 'collection' + (ui.collectionId === c.id ? ' active' : '');
    b.title = (c.description ? c.description + '\n' : '') + '拖到 Unity / 资源管理器，整套文件一起导入';
    b.draggable = true;
    b.innerHTML = `<span class="dot"></span><span class="nm">${escapeHtml(c.name)}</span><span class="n">${c.itemIds.length}</span>`;
    b.onclick = () => {
      ui.collectionId = ui.collectionId === c.id ? null : c.id;
      ui.cat = 'all';
      renderAll();
    };
    b.ondragstart = (e) => {
      e.preventDefault();
      api.dragCollection(c.id).then((r) => {
        if (r && !r.ok && r.message) toast(r.message);
        else if (r && r.ok && r.skipped) toast(`已拖出 ${r.count} 个，跳过 ${r.skipped} 个文件夹引用/缺失文件`);
      });
    };
    b.oncontextmenu = (e) => {
      e.preventDefault();
      showCollectionMenu(e.clientX, e.clientY, c);
    };
    el.appendChild(b);
  }
}

function renderCollectionBar() {
  const bar = $('#collectionBar');
  const c = currentCollection();
  if (!c) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');

  const items = state.items.filter((it) => c.itemIds.includes(it.id));
  const total = items.reduce((a, it) => a + (it.sizeBytes || 0), 0);
  const refs = items.filter((it) => it.refOnly).length;
  const missing = items.filter((it) => it.missingRef).length;
  const selectedIn = [...ui.selection].filter((id) => c.itemIds.includes(id));

  $('#collName').textContent = c.name || '未命名套装';
  $('#collDesc').textContent = c.description || '还没有说明，点「编辑」补一句用途或搭配备注。';
  $('#collStats').textContent = `${items.length} 个资产 · ${fmtSize(total)}`
    + (refs ? ` · ${refs} 个文件夹引用` : '')
    + (missing ? ` · ${missing} 个原件缺失` : '');

  $('#btnCollAdd').disabled = ui.selection.size === 0;
  $('#btnCollRemove').disabled = selectedIn.length === 0;
  const idx = c.itemIds.indexOf(ui.activeId);
  $('#btnCollMoveUp').disabled = idx <= 0;
  $('#btnCollMoveDown').disabled = idx < 0 || idx >= c.itemIds.length - 1;
  const hasFiles = items.some((it) => !it.refOnly && !it.missingRef);
  $('#btnCollExport').disabled = !hasFiles;
  $('#btnCollExportDir').disabled = !hasFiles;

  const grip = $('#collGrip');
  grip.style.opacity = hasFiles ? '' : '.35';
  grip.style.pointerEvents = hasFiles ? '' : 'none';
  grip.ondragstart = (e) => {
    e.preventDefault();
    api.dragCollection(c.id).then((r) => {
      if (r && !r.ok && r.message) toast(r.message);
      else if (r && r.ok && r.skipped) toast(`已拖出 ${r.count} 个，跳过 ${r.skipped} 个文件夹引用/缺失文件`);
    });
  };
}

function syncViewSwitch() {
  const box = $('#viewSwitch');
  if (!box) return;
  for (const b of box.querySelectorAll('[data-view]')) {
    b.classList.toggle('on', b.dataset.view === ui.view);
  }
}

function setView(view) {
  if (!VIEWS.includes(view)) return;
  ui.view = view;
  try { localStorage.setItem('av:view', view); } catch (_) { /* ignore */ }
  renderGrid();
}

function renderGrid(opts = {}) {
  pruneStacks();
  const grid = $('#grid');
  const empty = $('#empty');
  const items = visibleItems();
  const total = totalVisibleCount();
  const c = currentCollection();
  const units = buildGridUnits(items);
  grid.className = 'grid view-' + ui.view;
  syncViewSwitch();

  $('#countText').textContent = `${items.length} 个资产` + (items.length !== total ? `（共 ${total}）` : '');
  $('#filterHint').textContent = c ? '套装 · ' + c.name : '';

  if (!items.length) {
    empty.classList.add('show');
    grid.style.display = 'none';
    if (gridApi) gridApi.setData([], ui.view);
    if (c && !c.itemIds.length) {
      empty.querySelector('p').textContent = '这个套装还是空的';
      empty.querySelector('.sub').textContent = '在资产库选中素材，点右上角「加入套装」或套装栏的「添加选中」';
    } else if (state.items.length) {
      empty.querySelector('p').textContent = '没有匹配的资产';
      empty.querySelector('.sub').textContent = '换个关键词，或清除筛选条件';
    }
    return;
  }
  empty.classList.remove('show');
  grid.style.display = 'block';
  const apiGrid = ensureGrid();
  if (apiGrid) {
    apiGrid.setData(units, ui.view, { resetScroll: !!opts.resetScroll });
  }
}

/** 选中状态不需要重排，只改已挂载卡片的 class。 */
function refreshSelectionUI() {
  if (!gridApi) return;
  for (const card of gridApi.mountedCards()) {
    card.classList.toggle('selected', ui.selection.has(card.dataset.id));
  }
}

function visibleOrderIds() {
  return visibleItems().map((it) => it.id);
}

function selectById(id, { additive = false, range = false } = {}) {
  const ids = visibleOrderIds();
  if (!ids.includes(id)) return;
  if (range) {
    const anchor = ids.includes(ui.anchorId) ? ui.anchorId : id;
    const a = ids.indexOf(anchor);
    const b = ids.indexOf(id);
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    if (!additive) ui.selection.clear();
    for (let i = lo; i <= hi; i++) ui.selection.add(ids[i]);
    ui.activeId = id;
  } else if (additive) {
    if (ui.selection.has(id)) ui.selection.delete(id);
    else ui.selection.add(id);
    ui.activeId = id;
    ui.anchorId = id;
  } else {
    ui.selection.clear();
    ui.selection.add(id);
    ui.activeId = id;
    ui.anchorId = id;
  }
  refreshSelectionUI();
  renderDetail();
  renderCollectionBar();
  updateSelCount();
}


function gridThumbHTML(it, extraClass = '') {
  const f = (it.thumbFiles || [])[0];
  if (!f) return `<span class="ph">无示意图</span>`;
  const base = thumbURL(it.id, f, 'grid640');
  const small = thumbURL(it.id, f, 'grid320');
  const micro = thumbURL(it.id, f, 'micro');
  return `<img class="${extraClass}" src="${base}" srcset="${small} 320w, ${base} 640w"
    sizes="(max-width: 900px) 45vw, 260px" loading="lazy" decoding="async" draggable="false" alt=""
    style="background-image:url('${micro}');background-size:cover;background-position:center">`;
}

function makeItemCard(it, c) {
  const card = document.createElement('div');
  card.className = 'card' + (ui.selection.has(it.id) ? ' selected' : '') + (isBundleItem(it) ? ' bundle-card' : '');
  card.draggable = true;
  card.dataset.id = it.id;

  const st = it.stats || {};
  const vram = st.vramMB;
  const order = c ? c.itemIds.indexOf(it.id) + 1 : 0;
  const bundleN = isBundleItem(it) ? it.bundle.memberIds.length : 0;
  card.innerHTML = `
    <div class="thumb">
      ${gridThumbHTML(it)}
      ${order ? `<span class="badge-order">${order}</span>` : ''}
      ${bundleN ? `<span class="badge-bundle">合集 ${bundleN}</span>` : ''}
      <span class="badge-cat">${escapeHtml(catLabel(it.category))}</span>
      <button class="fav-btn ${it.favorite ? 'on' : ''}" title="收藏">${it.favorite ? '★' : '☆'}</button>
    </div>
    <div class="card-body">
      <div class="card-name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</div>
      <div class="card-meta">
        <span>${fmtCount(st.assetCount)} 件</span>
        <span>${st.materials || 0} 材质</span>
        <span class="vram ${vram >= 200 ? 'high' : ''}">${vram ? vram + ' MB' : '—'}</span>
      </div>
    </div>`;

  const img = card.querySelector('img');
  if (img) {
    img.addEventListener('load', () => img.classList.add('loaded'));
    if (img.complete) img.classList.add('loaded');
  }

  card.addEventListener('click', (e) => {
    if (e.target.classList.contains('fav-btn')) return;
    const modeOn = $('#btnSelMode').classList.contains('on');
    selectById(it.id, {
      additive: e.ctrlKey || e.metaKey || modeOn,
      range: e.shiftKey,
    });
  });

  card.querySelector('.fav-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    const next = !it.favorite;
    const r = await api.updateItem(it.id, { favorite: next });
    applyResponse(r);
    if (ui.activeId === it.id) renderDetail();
  });

  card.addEventListener('dragstart', (e) => {
    e.preventDefault(); // 取消 HTML5 拖拽，改由主进程发起原生拖拽
    api.startDrag(it.id).then((r) => {
      if (r && !r.ok && r.message) toast(r.message);
    });
  });

  card.addEventListener('dblclick', () => {
    if (!it.refOnly) api.revealItem(it.id);
  });

  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!ui.selection.has(it.id)) {
      ui.selection.clear();
      ui.selection.add(it.id);
      ui.activeId = it.id;
      ui.anchorId = it.id;
      refreshSelectionUI();
      renderDetail();
      updateSelCount();
    }
    showCardMenu(e.clientX, e.clientY, it);
  });

  return card;
}

function makeStackCard(stack, members) {
  const first = members[0];
  const n = members.length;
  const card = document.createElement('div');
  card.className = 'card stack-card';
  card.dataset.stackId = stack.id;
  card.draggable = false;
  card.title = '堆叠；点击展开，右键可合并或解散';
  card.innerHTML = `
    <div class="thumb">
      ${gridThumbHTML(first)}
      <span class="stack-count">${n}</span>
      <span class="badge-cat">${escapeHtml(catLabel(first.category))}</span>
    </div>
    <div class="card-body">
      <div class="card-name" title="${escapeHtml(first.name)}">${escapeHtml(first.name)}${n > 1 ? ` 等 ${n} 项` : ''}</div>
      <div class="card-meta"><span>${n} 张 · 堆叠</span><span>点击展开</span></div>
    </div>`;

  card.addEventListener('click', (e) => {
    e.stopPropagation();
    stack.expanded = true;
    ui.selection.clear();
    ui.activeId = first.id;
    renderGrid();
    renderDetail();
    updateSelCount();
  });

  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showStackMenu(e.clientX, e.clientY, stack);
  });

  return card;
}

function makeStackHeader(stack, members) {
  const first = members[0];
  const n = members.length;
  const el = document.createElement('div');
  el.className = 'stack-header';
  el.dataset.stackId = stack.id;
  el.innerHTML = `
    <div class="stack-header-thumb">${gridThumbHTML(first)}</div>
    <div class="stack-header-main">
      <div class="stack-header-name">${escapeHtml(first.name)} 等 ${n} 项</div>
      <div class="stack-header-sub">堆叠 · 同类目 · 展开中</div>
    </div>
    <div class="stack-header-actions">
      <button type="button" class="chip" data-act="collapse">收起</button>
      <button type="button" class="chip accent" data-act="merge">合并为 ZIP</button>
    </div>`;

  el.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    stack.expanded = false;
    renderGrid();
  });
  el.querySelector('[data-act="collapse"]').onclick = (e) => {
    e.stopPropagation();
    stack.expanded = false;
    renderGrid();
  };
  el.querySelector('[data-act="merge"]').onclick = (e) => {
    e.stopPropagation();
    mergeStack(stack);
  };
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showStackMenu(e.clientX, e.clientY, stack);
  });

  return el;
}

function renderDetailCollections(it) {
  const sets = state.collections.filter((c) => (c.itemIds || []).includes(it.id));
  const el = $('#dCollections');
  if (!sets.length) {
    el.innerHTML = '<b>所属套装</b><span class="d-coll-empty">未加入套装</span>';
    return;
  }
  el.innerHTML = '<b>所属套装</b><span class="d-coll-chips">' + sets.map((c) => {
    const pos = c.id === ui.collectionId ? ` · 第 ${c.itemIds.indexOf(it.id) + 1} 位` : '';
    return `<button class="d-coll-chip${c.id === ui.collectionId ? ' on' : ''}" data-id="${escapeHtml(c.id)}">${escapeHtml(c.name)}${pos}</button>`;
  }).join('') + '</span>';
  el.querySelectorAll('button').forEach((b) => {
    b.onclick = () => { ui.collectionId = b.dataset.id; ui.cat = 'all'; renderAll(); };
  });
}

function renderDetail() {
  const id = ui.activeId;
  const it = state.items.find((x) => x.id === id);
  const emptyEl = $('#detailEmpty');
  const bodyEl = $('#detailBody');

  if (!it) {
    emptyEl.classList.remove('hidden');
    bodyEl.classList.add('hidden');
    return;
  }
  emptyEl.classList.add('hidden');
  bodyEl.classList.remove('hidden');

  if (ui.previewFor !== it.id) { ui.previewFor = it.id; ui.previewIdx = 0; }
  const files = it.thumbFiles || [];
  const idx = Math.min(ui.previewIdx, Math.max(files.length - 1, 0));
  const thumb = files[idx] ? thumbURL(it.id, files[idx], 'detail') : '';
  $('#dPreview').innerHTML = thumb
    ? `<img src="${thumb}" data-orig="${thumbURL(it.id, files[idx], 'orig')}" alt="">`
    : `<span class="ph">还没有示意图<br>点下面的「＋」导入，或选中后直接 Ctrl+V 粘贴截图</span>`;
  $('#dPreview').classList.toggle('clickable', !!thumb);

  const strip = $('#dThumbs');
  strip.innerHTML = '';
  // 详情图预取：把前后两张的 1280 档先拉进缓存，翻图不闪
  for (const j of [idx - 1, idx + 1]) {
    if (j >= 0 && j < files.length && files[j]) {
      const pre = new Image();
      pre.src = thumbURL(it.id, files[j], 'detail');
    }
  }
  if (files.length) {
    files.forEach((u, i) => {
      const d = document.createElement('div');
      d.className = 'd-thumb' + (i === idx ? ' on' : '');
      const isBooth = String(files[i] || '').startsWith('booth_');
      const custom = String(files[i] || '').startsWith('custom_') || isBooth;
      d.innerHTML = `<img src="${thumbURL(it.id, u, 'detail')}" alt="">${custom ? `<span class="tag">${isBooth ? 'B' : '自'}</span><button class="thumb-x" title="移除这张示意图">×</button>` : ''}`;
      d.title = isBooth ? 'BOOTH 缩略图' : (custom ? '自定义示意图' : '包内预览图');
      d.onclick = () => { ui.previewIdx = i; renderDetail(); };
      const remove = () => {
        if (!custom) return;
        api.removeThumb(it.id, files[i]).then((r) => {
          if (r && r.ok) { ui.previewIdx = 0; applyResponse(r); toast('已移除'); }
        });
      };
      d.oncontextmenu = (e) => {
        if (!custom) return;
        e.preventDefault();
        if (!confirm('移除这张示意图？\n原件不动。')) return;
        remove();
      };
      const x = d.querySelector('.thumb-x');
      if (x) x.onclick = (e) => {
        e.stopPropagation();
        if (!confirm('移除这张示意图？\n原件不动。')) return;
        remove();
      };
      strip.appendChild(d);
    });
  }
  $('#dName').value = it.name;
  const catSel = $('#dCategory');
  catSel.innerHTML = catList()
    .map((c) => `<option value="${c.key}">${escapeHtml(c.name)}</option>`)
    .join('');
  catSel.value = it.category;
  $('#dFav').classList.toggle('on', !!it.favorite);
  $('#dFav').textContent = it.favorite ? '★ 已收藏' : '☆ 收藏';
  $('#dTags').value = (it.tags || []).join(', ');
  $('#dNotes').value = it.notes || '';

  const st = it.stats || {};
  const vramHigh = (st.vramMB || 0) >= 200;
  $('#dStats').innerHTML = [
    stat('资产文件', fmtCount(st.assetCount) + ' 件'),
    stat('材质球', fmtCount(st.materials)),
    stat('贴图', fmtCount(st.textures)),
    stat('预估显存', (st.vramMB ? st.vramMB + ' MB' : '—'), vramHigh),
    stat('PreFab', fmtCount(st.prefabs)),
    stat('文件体积', fmtSize(it.sizeBytes)),
  ].join('');

  $('#dMeta').innerHTML = `
    <div><b>类型</b> ${KIND_LABEL[it.kind] || it.kind}${it.refOnly ? '（不复制，仅引用路径）' : ''}</div>
    <div><b>入库</b> ${fmtDate(it.addedAt)}${it.lastUsed ? ` · 最近使用 ${fmtDate(it.lastUsed)}` : ''}</div>
    <div><b>原文件</b><div class="path">${escapeHtml(it.refOnly ? (it.originPath || '') + '（文件夹引用）' : (it.storedPath || ''))}</div></div>
    ${it.boothTitle ? `<div><b>BOOTH</b> ${escapeHtml(it.boothTitle)}${it.boothShop ? ` · ${escapeHtml(it.boothShop)}` : ''}</div>` : ''}
    ${isBundleItem(it) ? `<div><b>合并卡</b> ${it.bundle.memberIds.length} 个素材 · 右键可还原原卡</div><div><b>成员</b><div class="bundle-members">${(it.bundle.memberNames || []).map((n) => escapeHtml(n)).join('、')}</div></div>` : ''}`;
  renderDetailCollections(it);
  ensureStats(it);

  $('#dDrag').disabled = false;
}

const statsBusy = new Set();
/**
 * 旧手机备份/旧库可能没有 stats 或 vramMB=0；选中时在 PC 上补统计一次。
 * statsRepaired 会在主进程写回 index.json，避免每次选中都重算。
 */
function ensureStats(it) {
  if (!it || it.refOnly || it.statsRepaired || isBundleItem(it) || statsBusy.has(it.id)) return;
  if (!api.refreshStats) return;
  const vram = it.stats && Number(it.stats.vramMB);
  const isPackage = it.kind === 'unitypackage' || it.kind === 'zip';
  // 包类文件的手机端/旧版统计可能偏小，选中时也补算一次；单文件只在缺失/为 0 时补。
  if (!isPackage && Number.isFinite(vram) && vram > 0) return;
  statsBusy.add(it.id);
  api.refreshStats(it.id).then((r) => {
    statsBusy.delete(it.id);
    if (r && r.item) applyResponse(r);
  }).catch(() => {
    statsBusy.delete(it.id);
  });
}

function stat(k, v, warn) {
  return `<div class="stat"><div class="k">${k}</div><div class="v ${warn ? 'warn' : ''}">${v}</div></div>`;
}

function updateSelCount() {
  const el = $('#selCount');
  el.textContent = ui.selection.size ? `已选 ${ui.selection.size}` : '';
  $('#btnAddToCollection').disabled = ui.selection.size === 0;
}

function renderAll() {
  renderCats();
  renderCollections();
  renderCollectionBar();
  renderGrid();
  renderDetail();
  updateSelCount();
}

function renderStatePayload(payload) {
  if (!payload) return;
  if (Array.isArray(payload.categories)) state.categories = payload.categories;
  const nextRoot = payload.root || '';
  const rootChanged = nextRoot !== state.root;
  state.root = nextRoot;
  const setupEl = $('#setup');
  if (payload.needSetup) {
    setupEl.classList.remove('hidden');
    $('#setupDefaultPath').textContent = payload.defaultRoot || '';
    $('#rootText').textContent = '库：未设置';
  } else {
    setupEl.classList.add('hidden');
  }
  state.items = Array.isArray(payload.items) ? payload.items : [];
  state.collections = payload.collections || [];
  if (rootChanged) ui.stacks = [];
  applyStacksFromPayload(payload.stacks);
  pruneStacks();
  if (ui.collectionId && !state.collections.some((c) => c.id === ui.collectionId)) ui.collectionId = null;
  $('#rootText').textContent = '库：' + state.root;
  // 清理已不存在的选中项
  for (const id of [...ui.selection]) {
    if (!state.items.find((x) => x.id === id)) ui.selection.delete(id);
  }
  if (ui.activeId && !state.items.find((x) => x.id === ui.activeId)) ui.activeId = null;
  if (!ui.activeId && state.items.length && !ui.selection.size) {
    const first = state.items.find((it) => !isHiddenOriginal(it));
    if (first) {
      ui.activeId = first.id;
      ui.selection.add(ui.activeId);
    }
  }
  renderAll();
}

function mergeItems(list) {
  if (!Array.isArray(list) || !list.length) return;
  const incoming = [];
  for (const it of list) {
    if (!it || !it.id) continue;
    const idx = state.items.findIndex((x) => x.id === it.id);
    if (idx >= 0) state.items[idx] = it;
    else incoming.push(it);
  }
  if (incoming.length) state.items = incoming.concat(state.items);
}

function removeItems(ids) {
  const set = new Set(Array.isArray(ids) ? ids : [ids]);
  state.items = state.items.filter((it) => !set.has(it.id));
  for (const c of state.collections) c.itemIds = (c.itemIds || []).filter((id) => !set.has(id));
  for (const id of set) ui.selection.delete(id);
  if (set.has(ui.activeId)) ui.activeId = null;
}

function clearMissingSelection() {
  const ids = new Set(state.items.map((it) => it.id));
  for (const id of [...ui.selection]) if (!ids.has(id)) ui.selection.delete(id);
  if (ui.activeId && !ids.has(ui.activeId)) ui.activeId = null;
}

/**
 * 增量结果合并：主进程只回变化的 item / collections / categories，
 * 这里合并到本地 state，再让虚拟网格重排（只挂几十个节点，很便宜）。
 */
function applyResponse(r) {
  if (!r) return;
  if (r.state) {
    applyResponse(r);
    return;
  }
  let structureChanged = false;
  if (Array.isArray(r.categories)) { state.categories = r.categories; structureChanged = true; }
  if (Array.isArray(r.collections)) { state.collections = r.collections; structureChanged = true; }
  if (Array.isArray(r.stacks)) { applyStacksFromPayload(r.stacks); structureChanged = true; }
  if (Array.isArray(r.patches)) {
    for (const p of r.patches) {
      const it = state.items.find((x) => x.id === p.id);
      if (it) it.category = p.category;
    }
    structureChanged = true;
  }
  if (r.item) mergeItems([r.item]);
  if (r.bundleItem) mergeItems([r.bundleItem]);
  if (Array.isArray(r.items)) mergeItems(r.items);
  if (Array.isArray(r.restored)) mergeItems(r.restored);
  if (Array.isArray(r.addedItems)) mergeItems(r.addedItems);
  if (r.removedId) removeItems([r.removedId]);
  if (Array.isArray(r.removed)) removeItems(r.removed);
  clearMissingSelection();
  if (ui.collectionId && !state.collections.some((c) => c.id === ui.collectionId)) ui.collectionId = null;

  if (structureChanged || r.removedId || r.removed || r.item || r.items || r.bundleItem || r.addedItems) {
    renderAll();
  }
}


function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ---------- 自绘输入框（Electron 不支持 window.prompt） ---------- */
function askText(title, defaultValue = '') {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal">
        <div class="modal-title">${escapeHtml(title)}</div>
        <input class="modal-input" type="text" value="${escapeHtml(defaultValue)}">
        <div class="modal-actions">
          <button class="btn ghost" data-act="cancel">取消</button>
          <button class="btn primary" data-act="ok">确定</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    const input = mask.querySelector('.modal-input');
    input.focus();
    input.select();

    const close = (val) => { mask.remove(); document.removeEventListener('keydown', onKey, true); resolve(val); };
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(input.value.trim() || null); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
    };
    document.addEventListener('keydown', onKey, true);
    mask.querySelector('[data-act="cancel"]').onclick = () => close(null);
    mask.querySelector('[data-act="ok"]').onclick = () => close(input.value.trim() || null);
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(null); });
  });
}

/* ---------- 套装新建 / 编辑弹窗 ---------- */
function askCollection(title, { name = '新套装', description = '', hint = '', selectedCount = 0 } = {}) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal">
        <div class="modal-title">${escapeHtml(title)}</div>
        <input class="modal-input" type="text" placeholder="套装名称" value="${escapeHtml(name)}">
        <textarea class="modal-textarea" placeholder="说明（可选）：这套资源用在哪个项目、搭配注意什么">${escapeHtml(description)}</textarea>
        ${selectedCount ? `<label class="modal-check"><input type="checkbox" class="modal-checkbox" checked> 带入当前选中的 ${selectedCount} 个资产</label>` : ''}
        ${hint ? `<div class="modal-hint">${escapeHtml(hint)}</div>` : ''}
        <div class="modal-actions">
          <button class="btn ghost" data-act="cancel">取消</button>
          <button class="btn primary" data-act="ok">保存</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    const input = mask.querySelector('.modal-input');
    const textarea = mask.querySelector('.modal-textarea');
    input.focus();
    input.select();

    const close = (val) => { mask.remove(); document.removeEventListener('keydown', onKey, true); resolve(val); };
    const submit = () => close({ name: input.value.trim() || '未命名套装', description: textarea.value.trim(), includeSelected: mask.querySelector('.modal-checkbox') ? mask.querySelector('.modal-checkbox').checked : false });
    const onKey = (e) => {
      if (e.key === 'Enter' && e.target !== textarea) { e.preventDefault(); e.stopPropagation(); submit(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
    };
    document.addEventListener('keydown', onKey, true);
    mask.querySelector('[data-act="cancel"]').onclick = () => close(null);
    mask.querySelector('[data-act="ok"]').onclick = submit;
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(null); });
  });
}

/* ---------- 提示 ---------- */

let toastTimer = null;
function toast(msg) {
  $('#statusText').textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#statusText').textContent = '就绪'; }, 6000);
}

function showProgress(text, ratio) {
  $('#progress').classList.remove('hidden');
  $('#progressText').textContent = text;
  $('#progressFill').style.width = Math.round((ratio || 0) * 100) + '%';
}
function hideProgress() {
  $('#progressFill').style.width = '100%';
  setTimeout(() => $('#progress').classList.add('hidden'), 400);
}

/* ---------- 入库 ---------- */

async function ingest(paths) {
  if (!paths || !paths.length) return;
  showProgress(`准备处理 ${paths.length} 个素材…`, 0);
  const res = await api.ingest(paths);
  hideProgress();
  applyResponse(res);

  const a = res.added.length, d = res.duplicated.length, f = res.failed.length;
  const msg = `已入库 ${a}` + (d ? ` · 重复 ${d}` : '') + (f ? ` · 失败 ${f}` : '');
  toast(a || d || f ? msg : '没有变化');
  if (res.failed.length) console.warn('入库失败：', res.failed);
  if (res.notices && res.notices.length) console.info(res.notices.join('\n'));
}

api.onIngestProgress((d) => {
  const ratio = (d.index - 1 + (d.phase === 'done' ? 1 : 0.4)) / (d.total || 1);
  const name = (d.path || '').split(/[\\/]/).pop();
  const phaseText = {
    start: '读取', hash: '计算哈希', unpack: '解析包内容', scan: '扫描文件',
    thumb: '提取预览图', done: '完成', dup: '已存在，跳过', error: '出错',
  }[d.phase] || '处理中';
  showProgress(`[${d.index}/${d.total}] ${phaseText}：${name}`, Math.min(ratio, 1));
});

api.onExportProgress((d) => {
  showProgress(`导出套装：${d.name || '处理中'}`, Math.min(1, d.index / (d.total || 1)));
});

/* ---------- 套装管理 ---------- */
async function createCollectionFromSelection() {
  const sel = [...ui.selection];
  const d = await askCollection('新建套装', {
    name: '新套装',
    description: '',
    selectedCount: sel.length,
    hint: sel.length ? '默认带入当前选中，取消勾选可先建空套装' : '先建空套装，之后从资产库选中素材再添加',
  });
  if (!d) return;
  const items = d.includeSelected ? sel : [];
  const r = await api.saveCollection({ name: d.name, description: d.description, itemIds: items });
  if (!r.ok) return toast(r.message || '创建失败');
  ui.collectionId = r.id;
  ui.cat = 'all';
  applyResponse(r);
  toast(items.length ? `已创建，带入 ${items.length} 个资产` : '已创建空套装，选中素材后点「添加选中」');
}

async function addSelectionToCollection(c) {
  if (!ui.selection.size) return toast('先选中资产');
  const r = await api.addToCollection({ id: c.id, itemIds: [...ui.selection] });
  if (!r.ok) return toast(r.message || '加入失败');
  applyResponse(r);
  toast(r.added ? `已加入 ${r.added} 个资产` : '这些资产已经都在套装里');
}

async function removeSelectionFromCollection(c) {
  const sel = [...ui.selection].filter((id) => c.itemIds.includes(id));
  if (!sel.length) return toast('选中的资产不在这个套装里');
  const r = await api.removeFromCollection({ id: c.id, itemIds: sel });
  if (!r.ok) return toast(r.message || '移出失败');
  applyResponse(r);
  toast(`已移出 ${r.removed} 个资产`);
}

async function editCollection(c) {
  const d = await askCollection('编辑套装', {
    name: c.name,
    description: c.description || '',
    hint: `${c.itemIds.length} 个资产；说明会随套装一起导出`,
  });
  if (!d) return;
  const r = await api.saveCollection({ id: c.id, name: d.name, description: d.description });
  if (!r.ok) return toast(r.message || '保存失败');
  applyResponse(r);
  toast('套装已更新');
}

async function exportCollection(c, mode) {
  const hasFiles = state.items.some((it) => c.itemIds.includes(it.id) && !it.refOnly && !it.missingRef);
  if (!hasFiles) return toast('这个套装里没有可导出的原件');
  showProgress(mode === 'zip' ? '正在导出 ZIP…' : '正在导出文件夹…', 0.1);
  try {
    const r = await api.exportCollection(c.id, mode);
    hideProgress();
    if (!r.ok) return toast(r.message || '导出失败');
    toast(`已导出 ${r.count} 个` + (r.skippedRef ? `，跳过 ${r.skippedRef} 个文件夹引用` : '') + (r.missing ? `，${r.missing} 个原件缺失` : ''));
  } catch (e) {
    hideProgress();
    toast('导出失败：' + (e && e.message ? e.message : '未知错误'));
  }
}

async function moveCollectionItem(c, delta) {
  if (!ui.activeId) return toast('先选中套装里的资产');
  const r = await api.moveCollectionItem({ id: c.id, itemId: ui.activeId, delta });
  if (!r.ok) return toast(r.message || '移动失败');
  applyResponse(r);
}

function showAddToCollectionMenu(x, y) {
  if (!ui.selection.size) return toast('先选中资产');
  closeCtx();
  ctxEl = document.createElement('div');
  ctxEl.className = 'ctx';
  ctxEl.style.left = Math.min(x, window.innerWidth - 230) + 'px';
  ctxEl.style.top = Math.min(y, window.innerHeight - 260) + 'px';
  const mk = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => { closeCtx(); fn(); };
    ctxEl.appendChild(b);
  };
  for (const c of state.collections) mk(`加入「${c.name}」`, () => addSelectionToCollection(c));
  if (state.collections.length) {
    const sep = document.createElement('div');
    sep.className = 'ctx-sep';
    ctxEl.appendChild(sep);
  }
  mk('＋ 新建套装并加入', createCollectionFromSelection);
  document.body.appendChild(ctxEl);
}

function selectedItems() {
  return [...ui.selection].map((id) => state.items.find((it) => it.id === id)).filter(Boolean);
}

async function createStackFromSelection() {
  if (ui.collectionId) return toast('套装视图里先不堆叠');
  const members = selectedItems();
  if (members.length < 2) return toast('至少选 2 张卡片');
  if (members.some(isBundleItem)) return toast('合并卡不能再堆叠');
  if (members.some((it) => it.category !== members[0].category)) return toast('只能堆叠同一类目的卡片');
  if (ui.stacks.some((s) => s.itemIds.some((id) => ui.selection.has(id)))) {
    return toast('选中的卡片已经在某个堆叠里');
  }
  try {
    const r = await api.createStack({ itemIds: members.map((it) => it.id) });
    if (!r || !r.ok) return toast((r && r.message) || '堆叠失败');
    ui.selection.clear();
    ui.activeId = members[0].id;
    applyResponse(r);
    toast(`已堆叠 ${members.length} 张，点击堆叠卡展开`);
  } catch (e) {
    toast('堆叠失败：' + (e && e.message ? e.message : '未知错误'));
  }
}

async function dissolveStackById(id) {
  try {
    const r = await api.dissolveStack(id);
    if (!r || !r.ok) return toast((r && r.message) || '解散失败');
    applyResponse(r);
    toast('堆叠已解散，素材没有变化');
  } catch (e) {
    toast('解散失败：' + (e && e.message ? e.message : '未知错误'));
  }
}

async function mergeStack(stack) {
  const members = stack.itemIds.map((id) => state.items.find((it) => it.id === id)).filter(Boolean);
  if (members.length < 2) {
    ui.stacks = ui.stacks.filter((s) => s.id !== stack.id);
    renderGrid();
    return toast('成员不足 2 张，堆叠已自动解散');
  }
  if (members.some(isBundleItem)) return toast('合并卡不能再合并');
  if (!confirm(`把「${members[0].name}」等 ${members.length} 张合并成一张 ZIP 卡？\n原卡会隐藏，右键合并卡可以还原。`)) return;
  showProgress('正在合并为 ZIP…', 0.2);
  try {
    const r = await api.createBundle({ itemIds: stack.itemIds });
    if (!r || !r.ok) {
      hideProgress();
      return toast((r && r.message) || '合并失败');
    }
    ui.selection.clear();
    ui.activeId = r.bundleId;
    hideProgress();
    applyResponse(r);
    toast(`已合并 ${r.memberCount} 张为一张 ZIP 卡`);
  } catch (e) {
    hideProgress();
    toast('合并失败：' + (e && e.message ? e.message : '未知错误'));
  }
}

async function restoreBundleCard(it) {
  if (!it || !isBundleItem(it)) return;
  if (!confirm(`还原「${it.name}」？\n会删除这张合并卡，并恢复原来的 ${it.bundle.memberIds.length} 张卡片。`)) return;
  try {
    const r = await api.restoreBundle(it.id);
    if (!r || !r.ok) return toast((r && r.message) || '还原失败');
    ui.selection.clear();
    ui.activeId = (r.memberIds && r.memberIds[0]) || null;
    applyResponse(r);
    toast(`已还原 ${r.restored || 0} 张原卡`);
  } catch (e) {
    toast('还原失败：' + (e && e.message ? e.message : '未知错误'));
  }
}

function showCardMenu(x, y, it) {
  closeCtx();
  ctxEl = document.createElement('div');
  ctxEl.className = 'ctx';
  ctxEl.style.left = Math.min(x, window.innerWidth - 250) + 'px';
  ctxEl.style.top = Math.min(y, window.innerHeight - 260) + 'px';
  const mk = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => { closeCtx(); fn(); };
    ctxEl.appendChild(b);
    return b;
  };
  const selCount = ui.selection.size;
  const members = selectedItems();
  const canStack = !ui.collectionId
    && members.length >= 2
    && !members.some(isBundleItem)
    && members.every((m) => m.category === it.category);
  if (canStack) {
    mk(`堆叠选中的 ${members.length} 张`, createStackFromSelection);
  } else {
    const b = mk(ui.collectionId ? '堆叠（套装视图不可用）' : '堆叠（需 2 张以上同类目）', () => {});
    b.disabled = true;
  }
  if (selCount > 1) {
    const sep = document.createElement('div');
    sep.className = 'ctx-sep';
    ctxEl.appendChild(sep);
    mk(`批量改类目（${selCount}）`, () => showBatchCategoryMenu(x, y));
    mk(`批量加标签（${selCount}）`, addTagsToSelection);
    mk(`批量删除（${selCount}）`, deleteSelection);
    const sep2 = document.createElement('div');
    sep2.className = 'ctx-sep';
    ctxEl.appendChild(sep2);
  }
  if (isBundleItem(it)) mk('还原原卡（撤销合并）', () => restoreBundleCard(it));
  mk('打开原文件位置', () => api.revealItem(it.id));
  document.body.appendChild(ctxEl);
}

function showBatchCategoryMenu(x, y) {
  closeCtx();
  ctxEl = document.createElement('div');
  ctxEl.className = 'ctx';
  ctxEl.style.left = Math.min(x, window.innerWidth - 200) + 'px';
  ctxEl.style.top = Math.min(y, window.innerHeight - 330) + 'px';
  const mk = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => { closeCtx(); fn(); };
    ctxEl.appendChild(b);
  };
  for (const c of catList()) {
    mk(`移到「${c.name}」`, async () => {
      const r = await api.batchUpdateItems([...ui.selection], { category: c.key, categorySource: 'manual' });
      if (!r || !r.ok) return toast((r && r.message) || '批量修改失败');
      applyResponse(r);
      toast(`已把 ${r.items.length} 个资产移到「${c.name}」`);
    });
  }
  document.body.appendChild(ctxEl);
}

async function addTagsToSelection() {
  if (ui.selection.size < 1) return;
  const text = await askText('给选中的资产加标签', '');
  if (!text) return;
  const tags = text.split(/[,，]/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
  if (!tags.length) return;
  const r = await api.batchUpdateItems([...ui.selection], { addTags: tags });
  if (!r || !r.ok) return toast((r && r.message) || '批量加标签失败');
  applyResponse(r);
  toast(`已给 ${r.items.length} 个资产加标签`);
}

async function deleteSelection() {
  const ids = [...ui.selection];
  if (!ids.length) return;
  const bundles = ids.filter((id) => {
    const it = state.items.find((x) => x.id === id);
    return it && isBundleItem(it);
  }).length;
  const tip = `删除选中的 ${ids.length} 个资产？\n`
    + (bundles ? `其中 ${bundles} 张合并卡会恢复成原卡；` : '')
    + '只删库内副本，原文件不动。';
  if (!confirm(tip)) return;
  const r = await api.batchDeleteItems(ids);
  if (!r || !r.ok) return toast((r && r.message) || '批量删除失败');
  ui.selection.clear();
  applyResponse(r);
  toast(`已删除 ${r.removed.length} 个资产`);
}


function showStackMenu(x, y, stack) {
  closeCtx();
  ctxEl = document.createElement('div');
  ctxEl.className = 'ctx';
  ctxEl.style.left = Math.min(x, window.innerWidth - 210) + 'px';
  ctxEl.style.top = Math.min(y, window.innerHeight - 150) + 'px';
  const mk = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => { closeCtx(); fn(); };
    ctxEl.appendChild(b);
  };
  mk(stack.expanded ? '收起堆叠' : '展开堆叠', () => {
    stack.expanded = !stack.expanded;
    renderGrid();
  });
  mk('合并为 ZIP 卡片', () => mergeStack(stack));
  mk('解散堆叠', () => dissolveStackById(stack.id));
  document.body.appendChild(ctxEl);
}

/* ---------- 事件绑定 ---------- */

$('#btnAdd').addEventListener('click', async () => {
  const paths = await api.pickFiles();
  if (paths && paths.length) ingest(paths);
});

$('#btnLib').addEventListener('click', (e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  showLibraryMenu(rect.right - 170, rect.bottom + 6);
});

let searchTimer = null;
$('#search').addEventListener('input', (e) => {
  const v = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { ui.query = v; renderGrid(); }, 160);
});
$('#searchClear').addEventListener('click', () => {
  $('#search').value = '';
  ui.query = '';
  renderGrid();
});

$('#viewSwitch').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-view]');
  if (btn) setView(btn.dataset.view);
});

$('#btnFav').addEventListener('click', (e) => {
  ui.favOnly = !ui.favOnly;
  e.currentTarget.classList.toggle('on', ui.favOnly);
  renderGrid();
});

$('#btnSelMode').addEventListener('click', (e) => {
  e.currentTarget.classList.toggle('on');
});

$('#btnNewCollection').addEventListener('click', createCollectionFromSelection);
$('#btnAddToCollection').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  showAddToCollectionMenu(r.left, r.bottom + 5);
});
$('#btnCollAdd').addEventListener('click', () => {
  const c = currentCollection();
  if (c) addSelectionToCollection(c);
});
$('#btnCollRemove').addEventListener('click', () => {
  const c = currentCollection();
  if (c) removeSelectionFromCollection(c);
});
$('#btnCollMoveUp').addEventListener('click', () => {
  const c = currentCollection();
  if (c) moveCollectionItem(c, -1);
});
$('#btnCollMoveDown').addEventListener('click', () => {
  const c = currentCollection();
  if (c) moveCollectionItem(c, 1);
});
$('#btnCollEdit').addEventListener('click', () => {
  const c = currentCollection();
  if (c) editCollection(c);
});
$('#btnCollExportDir').addEventListener('click', () => {
  const c = currentCollection();
  if (c) exportCollection(c, 'folder');
});
$('#btnCollExport').addEventListener('click', () => {
  const c = currentCollection();
  if (c) exportCollection(c, 'zip');
});

/* 详情面板编辑 */
let saveTimer = null;
let boothBusy = false;

async function refreshBooth(id, force) {
  if (!id || boothBusy) return;
  boothBusy = true;
  if (force) toast('正在读取 BOOTH…');
  try {
    const r = await api.fetchBooth(id, !!force);
    if (!r) return;
    if (r.skipped) {
      if (force) toast('备注里没有可识别的 BOOTH 商品链接');
      return;
    }
    if (!r.ok) {
      toast(r.message || 'BOOTH 读取失败');
      return;
    }
    if (r && (r.item || r.state)) applyResponse(r);
    if (r.imageUpdated) toast(`已抓取 BOOTH：${r.title || '商品信息'}`);
    else if (r.imageError) toast(`商品名已更新，缩略图未抓到：${r.imageError}`);
    else toast('BOOTH 商品信息已更新');
  } catch (err) {
    toast(err && err.message ? err.message : 'BOOTH 读取失败');
  } finally {
    boothBusy = false;
  }
}
function patchActive(patch, debounce) {
  const id = ui.activeId;
  if (!id) return;
  const run = async () => {
    const r = await api.updateItem(id, patch);
    if (r && r.item) {
      mergeItems([r.item]);
      if ('category' in patch || 'name' in patch) {
        renderGrid();
        renderCats();
        renderDetail();
      } else if ('favorite' in patch) {
        renderGrid();
        renderDetail();
      }
      renderCollections();
    }
  };
  if (debounce) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(run, 600);
  } else {
    return run();
  }
}

$('#dName').addEventListener('change', (e) => patchActive({ name: e.target.value.trim() || '未命名资产' }));
$('#btnAddCat').onclick = async () => {
  const name = await askText('新建类目', '');
  if (!name) return;
  const r = await api.addCategory(name);
  if (!r.ok) return toast(r.message || '新建失败');
  applyResponse(r);
  toast('类目已新建');
};

$('#dCategory').addEventListener('change', (e) => {
  patchActive({ category: e.target.value, categorySource: 'manual' });
  renderCats();
});
$('#dTags').addEventListener('input', (e) => {
  const tags = e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
  patchActive({ tags }, true);
});
$('#dNotes').addEventListener('input', (e) => patchActive({ notes: e.target.value }, true));
$('#dNotes').addEventListener('blur', async (e) => {
  // 点「从备注抓 BOOTH」时会先触发 blur；交给按钮自己走 force 流程
  if (e.relatedTarget && e.relatedTarget.id === 'dBoothFetch') return;
  const id = ui.activeId;
  if (!id) return;
  await patchActive({ notes: $('#dNotes').value }, false);
  await refreshBooth(id, false);
});
$('#dBoothFetch').addEventListener('click', async () => {
  const id = ui.activeId;
  if (!id) return;
  await patchActive({ notes: $('#dNotes').value }, false);
  await refreshBooth(id, true);
});
$('#dFav').addEventListener('click', () => {
  const it = state.items.find((x) => x.id === ui.activeId);
  if (!it) return;
  it.favorite = !it.favorite;
  patchActive({ favorite: it.favorite });
  renderDetail();
});

$('#dDrag').addEventListener('click', () => {
  const it = state.items.find((x) => x.id === ui.activeId);
  if (!it) return;
  api.startDrag(it.id).then((r) => {
    if (r && !r.ok && r.message) toast(r.message);
    else toast('拖到 Unity 窗口');
  });
});

$('#dReveal').addEventListener('click', () => {
  if (ui.activeId) api.revealItem(ui.activeId);
});

$('#dDelete').addEventListener('click', async () => {
  const it = state.items.find((x) => x.id === ui.activeId);
  if (!it) return;
  const isBundle = isBundleItem(it);
  const go = confirm(isBundle
    ? `删除合并卡「${it.name}」？\n会恢复原来的 ${it.bundle.memberIds.length} 张卡片，素材文件不会删除。`
    : `删除「${it.name}」？\n${it.refOnly ? '仅移除记录，文件夹不动。' : '只删库内副本，原文件不动。'}`);
  if (!go) return;
  const r = await api.deleteItem(it.id);
  ui.selection.delete(it.id);
  ui.activeId = null;
  applyResponse(r);
  toast(isBundle ? '已移除合并卡，原卡已恢复' : '已移除');
});

/* 拖拽状态 */
api.onDragState((on) => {
  $('#dropOverlay').classList.toggle('on', !!on);
});
api.onDrop((paths) => ingest(paths));

/* 套装右键菜单 */
let ctxEl = null;
function closeCtx() { if (ctxEl) { ctxEl.remove(); ctxEl = null; } }
function showCollectionMenu(x, y, c) {
  closeCtx();
  ctxEl = document.createElement('div');
  ctxEl.className = 'ctx';
  ctxEl.style.left = Math.min(x, window.innerWidth - 190) + 'px';
  ctxEl.style.top = Math.min(y, window.innerHeight - 300) + 'px';
  const mk = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => { closeCtx(); fn(); };
    ctxEl.appendChild(b);
  };
  mk('打开套装', () => {
    ui.collectionId = c.id;
    ui.cat = 'all';
    renderAll();
  });
  mk('添加当前选中', () => addSelectionToCollection(c));
  mk('移出当前选中', () => removeSelectionFromCollection(c));
  mk('编辑名称和说明', () => editCollection(c));
  mk('导出文件夹', () => exportCollection(c, 'folder'));
  mk('导出 ZIP', () => exportCollection(c, 'zip'));
  mk('删除套装', async () => {
    if (!confirm(`删除套装「${c.name}」？（不影响资产本身）`)) return;
    const r = await api.deleteCollection(c.id);
    if (ui.collectionId === c.id) ui.collectionId = null;
    applyResponse(r);
  });
  document.body.appendChild(ctxEl);
}
document.addEventListener('mousedown', (e) => {
  if (ctxEl && !ctxEl.contains(e.target)) closeCtx();
});

/* 库菜单 */
function showLibraryMenu(x, y) {
  closeCtx();
  ctxEl = document.createElement('div');
  ctxEl.className = 'ctx';
  ctxEl.style.left = Math.min(x, window.innerWidth - 262) + 'px';
  ctxEl.style.top = Math.min(y, window.innerHeight - 180) + 'px';
  const mk = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => { closeCtx(); fn(); };
    ctxEl.appendChild(b);
  };
  mk('库位置…', async () => {
    const r = await api.chooseRoot();
    if (r && r.changed) { applyResponse(r); toast('库位置已切换'); }
  });
  mk('打开库目录', () => api.revealLibrary());
  mk('导出整库（搬去另一台电脑）', async () => {
    const r = await api.exportLibrary();
    hideProgress();
    if (r && r.ok) {
      toast(`已导出 ${r.entryCount}`);
    }
  });
  mk('从备份导入', async () => {
    const r = await api.importLibrary();
    hideProgress();
    if (!r) return;
    if (!r.ok) {
      if (!r.canceled) toast(r.message || '导入失败');
      return;
    }
    applyResponse(r);
    const catN = (r.catAdded || []).length;
    toast(`已导入 ${r.added.length}` + (r.skipped.length ? ` · 跳过 ${r.skipped.length}` : '') + (r.failed.length ? ` · 失败 ${r.failed.length}` : '') + (catN ? ` · 新类目 ${catN}` : ''));
  });
  document.body.appendChild(ctxEl);
}

/* 示意图：导入 / 粘贴 */
$('#dAddThumb').addEventListener('click', async () => {
  if (!ui.activeId) return;
  const r = await api.pickThumbImage(ui.activeId);
  if (r && r.ok) { ui.previewIdx = 0; applyResponse(r); }
  else if (r && r.message) toast(r.message);
});

// 全局 Ctrl+V：焦点不在输入框时直接把剪贴板图片贴到当前选中资产
document.addEventListener('paste', async (e) => {
  const el = document.activeElement;
  if (el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
  if (!ui.activeId) return;
  e.preventDefault();
  const r = await api.pasteThumb(ui.activeId);
  if (r && r.ok) { ui.previewIdx = 0; applyResponse(r); toast('已加示意图'); }
  else if (r && r.message) toast(r.message);
});

/* 大图 */
$('#dPreview').addEventListener('click', () => {
  const img = $('#dPreview').querySelector('img');
  if (!img) return;
  const lb = $('#lightbox');
  lb.querySelector('img').src = img.dataset.orig || img.src;
  lb.classList.add('on');
});
$('#lightbox').addEventListener('click', () => $('#lightbox').classList.remove('on'));

/* 库导入导出进度 */
api.onLibraryProgress((d) => {
  if (d.phase === 'export') {
    showProgress(`导出中：${d.name || ''}`, d.total ? d.done / d.total : 0);
  } else if (d.phase === 'unzip') {
    showProgress(`解包备份：${d.name || ''}`, d.total ? d.done / d.total : 0);
  } else if (d.phase === 'import') {
    showProgress(`导入中 [${d.index}/${d.total}] ${d.name || ''}`, d.total ? d.index / d.total : 0);
  }
});

/* 键盘 */
document.addEventListener('keydown', (e) => {
  const el = document.activeElement;
  const typing = el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    $('#search').focus();
    return;
  }
  if (typing) return;

  if (e.key === 'Escape') {
    const lb = $('#lightbox');
    if (lb.classList.contains('on')) { lb.classList.remove('on'); return; }
    closeCtx();
    ui.selection.clear();
    if (ui.activeId) ui.selection.add(ui.activeId);
    refreshSelectionUI();
    updateSelCount();
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    ui.selection.clear();
    for (const it of visibleItems()) ui.selection.add(it.id);
    ui.anchorId = ui.activeId || (visibleItems()[0] && visibleItems()[0].id);
    refreshSelectionUI();
    updateSelCount();
    return;
  }

  if ((e.key === 'Delete' || e.key === 'Backspace') && ui.selection.size) {
    e.preventDefault();
    deleteSelection();
  }
});


/* 首次设置 */
$('#setupDefault').addEventListener('click', async () => {
  const r = await api.initRoot('default');
  if (r && r.ok) { applyResponse(r); toast('库已创建'); }
});
$('#setupPick').addEventListener('click', async () => {
  const r = await api.initRoot('pick');
  if (!r || !r.ok) return;
  applyResponse(r);
  toast('库已创建');
});

/* 启动 */
(async function boot() {
  const payload = await api.loadState();
  renderStatePayload(payload);
})();
