'use strict';
// 堆叠分组（程序配置持久化）回归：创建、同类目、重复、解散、失效清理
const assert = require('assert');
const stacks = require('../lib/stacks');

const items = [
  { id: 'a1', name: '服装 A', category: 'cloth' },
  { id: 'a2', name: '服装 B', category: 'cloth' },
  { id: 'a3', name: '服装 C', category: 'cloth' },
  { id: 'b1', name: '道具 A', category: 'prop' },
];
const index = { items };

const ok = stacks.createStack(index, ['a1', 'a2']);
assert.strictEqual(ok.ok, true);
assert.strictEqual(ok.stack.itemIds.length, 2);
assert.strictEqual(ok.stack.category, 'cloth');
console.log('创建同类目堆叠:', ok.stack.id);

assert.strictEqual(stacks.createStack(index, ['a1']).ok, false);
assert.strictEqual(stacks.createStack(index, ['a1', 'b1']).ok, false);
assert.strictEqual(stacks.createStack({ ...index, stacks: [ok.stack] }, ['a2', 'a3']).ok, false);
console.log('单张 / 跨类目 / 重复成员拒绝: PASS');

const normalized = stacks.normalizeStacks([
  ok.stack,
  { id: 'bad1', itemIds: ['a1', 'a3'], category: 'cloth' },
  { id: 'bad2', itemIds: ['b1'], category: 'prop' },
  { id: 'bad3', itemIds: ['a1', 'b1'], category: 'other' },
], items);
assert.strictEqual(normalized.length, 1);
assert.deepStrictEqual(normalized[0].itemIds, ['a1', 'a2']);
console.log('重复成员 / 失效分组清理: PASS');

const dissolved = stacks.dissolveStack(normalized, ok.stack.id);
assert.strictEqual(dissolved.dissolved, true);
assert.strictEqual(dissolved.list.length, 0);
console.log('解散堆叠: PASS');

const hidden = items.map((it) => it.id === 'a1' ? { ...it, bundledInto: 'bundle-x' } : it);
assert.strictEqual(stacks.normalizeStacks([ok.stack], hidden).length, 0);
console.log('合并隐藏原卡后清理: PASS');

console.log('test-stacks: PASS');
