'use strict';
/**
 * Vault：主进程常驻索引 + 追加日志 + 原子快照。
 *
 * 设计约束：
 * - index.json 仍是标准库格式，手机端/备份导入导出照旧；
 * - 内存 index 是唯一实时数据源，磁盘只做持久化；
 * - 事件日志记录“完整条目/完整集合”，重放时是幂等的；
 * - 快照按 seq 截断：meta.json 记录 lastSeq，日志里更早的事件直接跳过；
 * - index.json 旁保留 index.json.bak，防止半截文件。
 */
const fsp = require('fs/promises');
const path = require('path');
const store = require('./store');

const VAULT_DIR = '.avatarvault';
const JOURNAL = 'journal.ndjson';
const JOURNAL_TMP = 'journal.tmp.ndjson';
const JOURNAL_OLD = 'journal.old.ndjson';
const META = 'meta.json';

function rid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

class Vault {
  constructor(opts = {}) {
    this.root = '';
    this.dir = '';
    this.journalPath = '';
    this.metaPath = '';
    this.index = store.EMPTY_INDEX();
    this.seq = 0;
    this.lastSnapshotSeq = 0;
    this.dirty = false;
    this.deferred = [];
    this.snapshotting = false;
    this.appendChain = Promise.resolve();
    this.flushChain = Promise.resolve();
    this.timer = null;
    this.maxTimer = null;
    this.snapshotDebounceMs = Number(opts.snapshotDebounceMs) || 8000;
    this.snapshotMaxMs = Number(opts.snapshotMaxMs) || 30000;
    this.onError = typeof opts.onError === 'function' ? opts.onError : (e) => console.error('[vault]', e);
    this.listeners = new Set();
  }

  onChange(fn) {
    if (typeof fn === 'function') this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit() {
    for (const fn of this.listeners) {
      try { fn(this); } catch (_) { /* ignore */ }
    }
  }

  get ready() {
    return !!this.root;
  }

  get items() {
    return this.index.items;
  }

  findItem(id) {
    return this.index.items.find((it) => it.id === id);
  }

  async open(root) {
    if (this.root) await this.flush();
    this.root = root ? path.resolve(root) : '';
    this.index = store.EMPTY_INDEX();
    this.seq = 0;
    this.lastSnapshotSeq = 0;
    this.dirty = false;
    this.deferred = [];
    if (!this.root) {
      this._emit();
      return this.index;
    }
    this.dir = path.join(this.root, VAULT_DIR);
    this.journalPath = path.join(this.dir, JOURNAL);
    this.metaPath = path.join(this.dir, META);
    await fsp.mkdir(this.dir, { recursive: true });
    this.index = await this._readSnapshot();
    await this._readMeta();
    await this._replayJournal();
    this._emit();
    return this.index;
  }

  async _readSnapshot() {
    const main = path.join(this.root, 'index.json');
    const bak = path.join(this.root, 'index.json.bak');
    for (const file of [main, bak]) {
      try {
        const raw = await fsp.readFile(file, 'utf8');
        return store.normalizeIndex(JSON.parse(raw));
      } catch (_) { /* try next */ }
    }
    return store.EMPTY_INDEX();
  }

  async _readMeta() {
    try {
      const m = JSON.parse(await fsp.readFile(this.metaPath, 'utf8'));
      this.lastSnapshotSeq = Number(m.lastSeq) || 0;
      this.seq = this.lastSnapshotSeq;
    } catch (_) {
      this.lastSnapshotSeq = 0;
      this.seq = 0;
    }
  }

  async _readJournalFile(file) {
    let raw = '';
    try { raw = await fsp.readFile(file, 'utf8'); } catch (_) { return []; }
    const events = [];
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      try {
        const ev = JSON.parse(s);
        if (ev && Number.isFinite(Number(ev.seq)) && ev.op) events.push(ev);
      } catch (_) { /* 崩溃时可能留下半截行，忽略 */ }
    }
    return events;
  }

  async _replayJournal() {
    const old = await this._readJournalFile(path.join(this.dir, JOURNAL_OLD));
    const cur = await this._readJournalFile(this.journalPath);
    const events = old.concat(cur)
      .filter((ev) => Number(ev.seq) > this.lastSnapshotSeq)
      .sort((a, b) => Number(a.seq) - Number(b.seq));
    for (const ev of events) {
      this._apply(ev);
      this.seq = Math.max(this.seq, Number(ev.seq) || 0);
    }
    if (events.length) this.dirty = true;
  }

  _apply(ev) {
    const idx = this.index;
    switch (ev.op) {
      case 'item:set': {
        const item = ev.item;
        if (!item || !item.id) return;
        const i = idx.items.findIndex((it) => it.id === item.id);
        if (i >= 0) idx.items[i] = item;
        else idx.items.unshift(item);
        break;
      }
      case 'item:delete': {
        idx.items = idx.items.filter((it) => it.id !== ev.id);
        for (const c of idx.collections) c.itemIds = c.itemIds.filter((x) => x !== ev.id);
        break;
      }
      case 'collections:set': {
        idx.collections = store.normalizeCollections(ev.value);
        break;
      }
      case 'categories:set': {
        idx.categories = store.normalizeCategories(ev.value);
        break;
      }
      case 'cat:delete': {
        idx.items.forEach((it) => { if (it.category === ev.key) it.category = 'other'; });
        idx.categories = store.normalizeCategories(idx.categories.filter((c) => c.key !== ev.key));
        break;
      }
      case 'cat:rename': {
        const c = idx.categories.find((x) => x.key === ev.key);
        if (c) c.name = String(ev.name || c.name);
        idx.categories = store.normalizeCategories(idx.categories);
        break;
      }
      case 'cat:order': {
        const want = Array.isArray(ev.keys) ? ev.keys.map(String) : [];
        const byKey = new Map(idx.categories.map((c) => [c.key, c]));
        const ordered = [];
        for (const k of want) {
          const c = byKey.get(k);
          if (c) { ordered.push(c); byKey.delete(k); }
        }
        for (const c of byKey.values()) ordered.push(c);
        idx.categories = store.normalizeCategories(ordered);
        break;
      }
      case 'collection:save': {
        const c = ev.collection;
        if (!c || !c.id) return;
        const i = idx.collections.findIndex((x) => x.id === c.id);
        if (i >= 0) idx.collections[i] = c;
        else idx.collections.push(c);
        idx.collections = store.normalizeCollections(idx.collections);
        break;
      }
      case 'collection:delete': {
        idx.collections = idx.collections.filter((c) => c.id !== ev.id);
        break;
      }
      case 'collection:add': {
        const c = idx.collections.find((x) => x.id === ev.id);
        if (!c) return;
        for (const id of ev.itemIds || []) if (!c.itemIds.includes(id)) c.itemIds.push(id);
        c.updatedAt = Date.now();
        break;
      }
      case 'collection:remove': {
        const c = idx.collections.find((x) => x.id === ev.id);
        if (!c) return;
        const remove = new Set(ev.itemIds || []);
        c.itemIds = c.itemIds.filter((x) => !remove.has(x));
        c.updatedAt = Date.now();
        break;
      }
      case 'collection:move': {
        const c = idx.collections.find((x) => x.id === ev.id);
        if (!c) return;
        const i = c.itemIds.indexOf(ev.itemId);
        if (i < 0) return;
        const j = i + (Number(ev.delta) < 0 ? -1 : 1);
        if (j < 0 || j >= c.itemIds.length) return;
        c.itemIds.splice(i, 1);
        c.itemIds.splice(j, 0, ev.itemId);
        c.updatedAt = Date.now();
        break;
      }
      default:
        break;
    }
  }

  /**
   * 记录事件。调用方已经改好内存 index，这里只负责追加日志。
   * 事件必须是幂等的完整状态（item:set / collections:set / ...）。
   */
  record(events) {
    if (!this.root) return 0;
    const list = (Array.isArray(events) ? events : [events]).filter(Boolean);
    if (!list.length) return 0;
    const stamped = list.map((ev) => ({ ...ev, seq: ++this.seq, ts: Date.now() }));
    this.dirty = true;
    if (this.snapshotting) {
      this.deferred.push(...stamped);
    } else {
      this._append(stamped);
    }
    this._schedule();
    this._emit();
    return this.seq;
  }

  _append(events) {
    if (!events.length) return;
    const text = events.map((ev) => JSON.stringify(ev)).join('\n') + '\n';
    this.appendChain = this.appendChain
      .then(() => fsp.appendFile(this.journalPath, text, 'utf8'))
      .catch((err) => this.onError(err));
  }

  _schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch((e) => this.onError(e));
    }, this.snapshotDebounceMs);
    if (!this.maxTimer) {
      this.maxTimer = setTimeout(() => {
        this.maxTimer = null;
        this.flush().catch((e) => this.onError(e));
      }, this.snapshotMaxMs);
    }
  }

  /** 强制落盘：快照 + meta + 清掉已覆盖的日志。 */
  flush() {
    if (!this.root) return Promise.resolve();
    this.flushChain = this.flushChain.then(() => this._flushNow()).catch((e) => this.onError(e));
    return this.flushChain;
  }

  async _flushNow() {
    if (!this.dirty) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.maxTimer) { clearTimeout(this.maxTimer); this.maxTimer = null; }

    this.snapshotting = true;
    try {
      await this.appendChain;
      const seqAt = this.seq;
      // 同步抓取快照，保证文本内容和 seq 是同一时刻
      const text = JSON.stringify(this.index, null, 2);
      const main = path.join(this.root, 'index.json');
      const bak = path.join(this.root, 'index.json.bak');
      const tmp = main + '.tmp';
      await fsp.mkdir(path.dirname(main), { recursive: true });
      let hadMain = false;
      try { await fsp.access(main); hadMain = true; } catch (_) { /* 首次没有 index.json */ }
      try { await fsp.copyFile(main, bak); } catch (_) { /* 首次没有 index.json */ }
      await fsp.writeFile(tmp, text, 'utf8');
      await fsp.rename(tmp, main);
      // 第一次落盘没有旧文件可备份，就把刚写好的快照复制一份当兜底
      if (!hadMain) {
        try { await fsp.copyFile(main, bak); } catch (_) { /* ignore */ }
      }

      // 先轮转日志，避免快照写入期间新事件被误删
      const hadJournal = await fsp.access(this.journalPath).then(() => true).catch(() => false);
      if (hadJournal) {
        try {
          await fsp.rm(path.join(this.dir, JOURNAL_OLD), { force: true });
          await fsp.rename(this.journalPath, path.join(this.dir, JOURNAL_OLD));
        } catch (_) { /* ignore */ }
      }

      this.lastSnapshotSeq = seqAt;
      await store.saveJSONAtomic(this.metaPath, {
        version: 1,
        lastSeq: seqAt,
        updatedAt: Date.now(),
      });

      // 旧日志里的事件都 <= seqAt，已经进快照，可以删
      try { await fsp.rm(path.join(this.dir, JOURNAL_OLD), { force: true }); } catch (_) { /* ignore */ }
      this.snapshotting = false;

      if (this.deferred.length) {
        const pending = this.deferred;
        this.deferred = [];
        this._append(pending);
        this.dirty = true;
        this._schedule();
      } else {
        this.dirty = false;
      }
    } catch (err) {
      this.snapshotting = false;
      // 快照失败时把延迟事件追加回日志，下次再试
      if (this.deferred.length) {
        const pending = this.deferred;
        this.deferred = [];
        this._append(pending);
      }
      this.onError(err);
      throw err;
    }
  }

  /** 整库导入等批量替换：直接换内存并立刻落盘。 */
  async replace(nextIndex) {
    this.index = store.normalizeIndex(nextIndex);
    this.dirty = true;
    this.seq += 1;
    await this.flush();
    this._emit();
    return this.index;
  }

  async close() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.maxTimer) { clearTimeout(this.maxTimer); this.maxTimer = null; }
    await this.flush();
    this.root = '';
    this.dir = '';
    this.index = store.EMPTY_INDEX();
    this.seq = 0;
  }

  newId(prefix) {
    let id = String(prefix || 'x') + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
    while (this.index.items.some((it) => it.id === id)) {
      id = String(prefix || 'x') + Date.now().toString(36) + rid().slice(0, 4);
    }
    return id;
  }
}

module.exports = {
  Vault,
  VAULT_DIR,
  JOURNAL,
  META,
};
