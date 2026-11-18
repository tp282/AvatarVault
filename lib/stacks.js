'use strict';
// 堆叠是“程序配置”里的持久分组，不写素材库 index.json。
// 只记录成员；展开/收起是界面临时状态，不保存。

function isBundle(entry) {
  return !!(entry && entry.bundle && Array.isArray(entry.bundle.memberIds));
}

function newStackId(list) {
  let id;
  do {
    id = 'st' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  } while ((list || []).some((s) => s.id === id));
  return id;
}

/** 用当前库条目校验堆叠；成员缺失、跨类目、合并卡、重复成员都丢弃。 */
function normalizeStacks(list, items) {
  const byId = new Map((items || []).map((it) => [it.id, it]));
  const usedMembers = new Set();
  const usedIds = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || !raw.id) continue;
    const id = String(raw.id);
    if (usedIds.has(id)) continue;
    const ids = [...new Set((raw.itemIds || []).filter((x) => typeof x === 'string'))];
    const members = ids.map((x) => byId.get(x)).filter(Boolean);
    if (members.length < 2 || members.length !== ids.length) continue;
    if (members.some((it) => isBundle(it) || it.bundledInto)) continue;
    if (new Set(members.map((it) => it.category || 'other')).size !== 1) continue;
    if (members.some((it) => usedMembers.has(it.id))) continue;
    usedIds.add(id);
    members.forEach((it) => usedMembers.add(it.id));
    out.push({
      id,
      itemIds: members.map((it) => it.id),
      category: members[0].category || 'other',
      createdAt: Number(raw.createdAt) || Date.now(),
    });
  }
  return out;
}

function createStack(index, itemIds) {
  const ids = [...new Set((Array.isArray(itemIds) ? itemIds : []).filter((x) => typeof x === 'string'))];
  if (ids.length < 2) return { ok: false, message: '至少选 2 张卡片' };
  const members = ids.map((id) => (index.items || []).find((it) => it.id === id)).filter(Boolean);
  if (members.length !== ids.length) return { ok: false, message: '有卡片已经不存在，请重新选择' };
  if (members.some((it) => isBundle(it))) return { ok: false, message: '合并卡不能再堆叠' };
  if (members.some((it) => it.bundledInto)) return { ok: false, message: '合并卡的原卡已经隐藏，不能堆叠' };
  if (new Set(members.map((it) => it.category || 'other')).size !== 1) {
    return { ok: false, message: '只能堆叠同一类目的卡片' };
  }
  const existing = normalizeStacks(index.stacks || [], index.items);
  if (existing.some((s) => s.itemIds.some((id) => ids.includes(id)))) {
    return { ok: false, message: '选中的卡片已经在某个堆叠里' };
  }
  return {
    ok: true,
    stack: {
      id: newStackId(existing),
      itemIds: members.map((it) => it.id),
      category: members[0].category || 'other',
      createdAt: Date.now(),
    },
  };
}

function dissolveStack(list, id) {
  const before = (list || []).length;
  const after = (list || []).filter((s) => s.id !== id);
  return { ok: true, dissolved: before !== after.length, list: after };
}

module.exports = { normalizeStacks, createStack, dissolveStack, isBundle };
