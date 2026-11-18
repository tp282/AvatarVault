'use strict';
/**
 * 虚拟滚动网格：DOM 里永远只保留可视区上下各 2 行左右的块。
 * 布局单位是“块”：
 *   - row：一行普通卡片（最多 cols 张）
 *   - stack-expanded：一张堆叠标题 + 展开后的成员行
 * 块高度可以精确计算，所以堆叠展开也能虚拟化。
 */
(function () {
  const VIEW_LAYOUT = {
    comfortable: { minW: 176, gap: 14, bodyH: 58, headerH: 64 },
    compact: { minW: 132, gap: 9, bodyH: 50, headerH: 58 },
    list: { cardH: 74, gap: 6, headerH: 58 },
  };

  function lowerBound(blocks, y) {
    let lo = 0; let hi = blocks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (blocks[mid].y + blocks[mid].height <= y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function upperBound(blocks, y) {
    let lo = 0; let hi = blocks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (blocks[mid].y < y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  class VirtualGrid {
    constructor(opts) {
      this.container = opts.container;
      this.inner = opts.inner;
      this.renderItem = opts.renderItem;
      this.renderStackCard = opts.renderStackCard;
      this.renderStackHeader = opts.renderStackHeader;
      this.onVisibleChange = opts.onVisibleChange || (() => {});
      this.units = [];
      this.view = 'comfortable';
      this.blocks = [];
      this.nodes = new Map();
      this.cols = 1;
      this.cardW = 200;
      this.cardH = 258;
      this.gap = 14;
      this.headerH = 64;
      this.contentTop = 16;
      this.raf = null;
      this.lastRange = [-1, -1];
      this._onScroll = () => this.schedule();
      this._onResize = () => this.reflow();
      this.container.addEventListener('scroll', this._onScroll, { passive: true });
      if (typeof ResizeObserver !== 'undefined') {
        this.ro = new ResizeObserver(this._onResize);
        this.ro.observe(this.container);
        this.ro.observe(this.inner);
      } else {
        window.addEventListener('resize', this._onResize);
      }
    }

    schedule() {
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => {
        this.raf = null;
        this.renderNow();
      });
    }

    /** 重新测量容器、列数和卡片尺寸，然后重建块。 */
    reflow(preserveScroll = true) {
      const oldTop = this.container.scrollTop;
      const W = this.inner.getBoundingClientRect().width || (this.container.clientWidth - 36);
      const L = VIEW_LAYOUT[this.view] || VIEW_LAYOUT.comfortable;
      this.gap = L.gap;
      this.headerH = L.headerH;
      if (this.view === 'list') {
        this.cols = 1;
        this.cardW = W;
        this.cardH = L.cardH;
      } else {
        this.cols = Math.max(1, Math.floor((W + this.gap) / (L.minW + this.gap)));
        this.cardW = Math.max(1, (W - this.gap * (this.cols - 1)) / this.cols);
        this.cardH = Math.round(this.cardW + L.bodyH);
      }
      this.contentTop = this.inner.offsetTop || 0;
      this.inner.style.setProperty('--vg-cols', String(this.cols));
      this.inner.style.setProperty('--vg-card-w', this.cardW.toFixed(2) + 'px');
      this.inner.style.setProperty('--vg-card-h', this.cardH + 'px');
      this.inner.style.setProperty('--vg-gap', this.gap + 'px');
      this.inner.style.setProperty('--vg-header-h', this.headerH + 'px');
      this.buildBlocks();
      this.clearNodes();
      this.renderNow();
      if (preserveScroll) this.container.scrollTop = oldTop;
    }

    setData(units, view, opts = {}) {
      const changedView = view && view !== this.view;
      this.units = Array.isArray(units) ? units : [];
      if (view) this.view = view;
      this.reflow(false);
      if (changedView || opts.resetScroll) this.container.scrollTop = 0;
      this.renderNow();
    }

    /** 只重建块，不改变滚动位置（用于选中/收藏等不改变布局的更新）。 */
    refresh() {
      this.buildBlocks();
      this.clearNodes();
      this.renderNow();
    }

    buildBlocks() {
      const blocks = [];
      let row = [];
      let y = 0;
      const flushRow = () => {
        if (!row.length) return;
        blocks.push({ key: 'row:' + blocks.length, type: 'row', items: row, y, height: this.cardH });
        y += this.cardH + this.gap;
        row = [];
      };
      for (const unit of this.units) {
        if (unit.kind === 'stack' && unit.stack && unit.stack.expanded) {
          flushRow();
          const rows = Math.max(1, Math.ceil(unit.items.length / this.cols));
          const membersH = rows * this.cardH + Math.max(0, rows - 1) * this.gap;
          const height = this.headerH + this.gap + membersH;
          blocks.push({
            key: 'stack:' + unit.stack.id + ':' + unit.items.length + ':' + this.cols,
            type: 'stack-expanded',
            stack: unit.stack,
            items: unit.items,
            y,
            height,
          });
          y += height + this.gap;
        } else {
          row.push(unit.kind === 'stack'
            ? { kind: 'stack-card', stack: unit.stack, items: unit.items, item: unit.items[0] }
            : { kind: 'item', item: unit.item });
          if (row.length >= this.cols) flushRow();
        }
      }
      flushRow();
      this.blocks = blocks;
      this.inner.style.height = Math.max(0, y - (blocks.length ? this.gap : 0)) + 'px';
    }

    clearNodes() {
      for (const node of this.nodes.values()) node.remove();
      this.nodes.clear();
      this.lastRange = [-1, -1];
    }

    renderNow() {
      const top = this.container.scrollTop - this.contentTop;
      const bottom = top + this.container.clientHeight;
      const buffer = (this.view === 'list' ? this.cardH : this.cardH) * 2 + this.gap;
      const start = lowerBound(this.blocks, top - buffer);
      const end = upperBound(this.blocks, bottom + buffer);
      const visible = new Set();

      for (let i = start; i < end; i++) {
        const block = this.blocks[i];
        if (!block) continue;
        visible.add(block.key);
        let node = this.nodes.get(block.key);
        if (!node) {
          node = this.renderBlock(block);
          node.dataset.vgKey = block.key;
          node.style.position = 'absolute';
          node.style.left = '0';
          node.style.right = '0';
          this.nodes.set(block.key, node);
          this.inner.appendChild(node);
        }
        node.style.top = block.y + 'px';
        node.style.height = block.height + 'px';
      }

      for (const [key, node] of this.nodes) {
        if (!visible.has(key)) {
          node.remove();
          this.nodes.delete(key);
        }
      }

      if (this.lastRange[0] !== start || this.lastRange[1] !== end) {
        this.lastRange = [start, end];
        try { this.onVisibleChange(start, end); } catch (_) { /* ignore */ }
      }
    }

    renderBlock(block) {
      const el = document.createElement('div');
      el.className = 'vg-block';
      if (block.type === 'row') {
        el.classList.add('vg-row');
        el.style.gridTemplateColumns = `repeat(${this.cols}, ${this.cardW.toFixed(2)}px)`;
        el.style.gap = this.gap + 'px';
        for (const unit of block.items) {
          if (unit.kind === 'stack-card') el.appendChild(this.renderStackCard(unit.stack, unit.items));
          else el.appendChild(this.renderItem(unit.item));
        }
      } else {
        el.classList.add('vg-stack-block');
        el.appendChild(this.renderStackHeader(block.stack, block.items));
        const members = document.createElement('div');
        members.className = 'vg-stack-members';
        members.style.gridTemplateColumns = `repeat(${this.cols}, ${this.cardW.toFixed(2)}px)`;
        members.style.gap = this.gap + 'px';
        members.style.marginTop = this.gap + 'px';
        for (const it of block.items) members.appendChild(this.renderItem(it));
        el.appendChild(members);
      }
      return el;
    }

    /** 当前已挂载的卡片节点。 */
    mountedCards() {
      return this.inner.querySelectorAll('.card[data-id]');
    }

    scrollToId(id) {
      const block = this.blocks.find((b) => b.type === 'row' && b.items.some((u) => u.item && u.item.id === id))
        || this.blocks.find((b) => b.type === 'stack-expanded' && b.items.some((it) => it.id === id));
      if (!block) return false;
      const want = block.y + this.contentTop - 8;
      this.container.scrollTop = Math.max(0, want);
      this.renderNow();
      return true;
    }

    getBlockForId(id) {
      return this.blocks.find((b) => b.type === 'row' && b.items.some((u) => u.item && u.item.id === id))
        || this.blocks.find((b) => b.type === 'stack-expanded' && b.items.some((it) => it.id === id))
        || null;
    }

    destroy() {
      this.container.removeEventListener('scroll', this._onScroll);
      if (this.ro) this.ro.disconnect();
      else window.removeEventListener('resize', this._onResize);
      this.clearNodes();
    }
  }

  window.AVGrid = { VirtualGrid, VIEW_LAYOUT };
})();
