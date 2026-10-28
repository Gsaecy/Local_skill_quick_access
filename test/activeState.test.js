// 共享状态文件的读写：**读不懂时不能拿空状态去覆盖**。
//
// 那个文件现在由两个扩展共同读写：本扩展面板，以及 HWChat 的对话面板。两边都是
// 「截断再写」，所以「读到的内容不是用户真实选择」这种情况是会发生的——文件正被
// 另一个扩展写到一半，或者被手改坏。
//
// 如果此时把「解析失败」当成「用户什么都没勾」，接下来任何一次写入都会把文件覆盖成
// 只剩 `active`，用户攒的分类改名、自建分类、自定义名称、历史调用时间一起消失，
// 而且不可撤销。这里钉住的就是这条底线：读不懂 → 回退到上一次成功读到的状态。
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  emptyState,
  readActiveState,
  writeActiveState,
} = require('../out/activeState.js');

/** 每个用例一个独立临时文件：模块里按路径缓存「上一次读到的状态」，互不干扰。 */
function tempFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwsq-'));
  return { dir, file: path.join(dir, name), legacy: path.join(dir, 'legacy.json') };
}

function seededState() {
  return {
    ...emptyState(),
    active: ['app-store-rules', 'chadlini-render'],
    unchecked: { claude: 111 },
    lastUsed: { 'app-store-rules': 1700000000000 },
    custom: { mine: { title: '自定义名', desc: '描述' } },
    origins: { mine: 'self' },
    categoryTitles: { misc: '未分类' },
    customCategories: [{ id: 'cat-1', title: '自建分类' }],
    skillCategory: { mine: 'cat-1' },
  };
}

test('文件不存在时读到空状态（首次使用）', () => {
  const { file, legacy } = tempFile('state.json');
  const st = readActiveState(file, legacy);
  assert.deepEqual(st, emptyState());
});

test('正常读取：字段逐个收敛，缺字段不会崩', () => {
  const { file, legacy } = tempFile('state.json');
  fs.writeFileSync(file, JSON.stringify({ active: ['a'], custom: { a: { title: 't', desc: 'd' } } }));
  const st = readActiveState(file, legacy);
  assert.deepEqual(st.active, ['a']);
  assert.deepEqual(st.custom, { a: { title: 't', desc: 'd' } });
  // 缺的字段给默认值，而不是 undefined（后面会直接往 st.unchecked[name] 里写）。
  assert.deepEqual(st.unchecked, {});
  assert.deepEqual(st.customCategories, []);
});

test('读不懂时回退到上一次成功读到的状态，而不是空状态', () => {
  const { file, legacy } = tempFile('state.json');
  const seeded = seededState();
  writeActiveState(seeded, file);

  // 写一半被截断（另一个扩展正写到一半的典型形态）。
  fs.writeFileSync(file, '{"active": ["app-store-rules"');
  const st = readActiveState(file, legacy);

  assert.deepEqual(st.active, seeded.active);
  assert.deepEqual(st.custom, seeded.custom, '自定义名称不能被清空');
  assert.deepEqual(st.customCategories, seeded.customCategories, '自建分类不能被清空');
  assert.deepEqual(st.categoryTitles, seeded.categoryTitles);
  assert.deepEqual(st.lastUsed, seeded.lastUsed);
});

test('回退内容与缓存互不影响：调用方就地改再写回，不会污染下一次回退', () => {
  const { file, legacy } = tempFile('state.json');
  writeActiveState(seededState(), file);
  fs.writeFileSync(file, 'not json');

  const first = readActiveState(file, legacy);
  first.active.push('polluted');
  first.custom.mine.title = '被改掉了';

  const second = readActiveState(file, legacy);
  assert.ok(!second.active.includes('polluted'), '回退状态被调用方改坏了');
  assert.equal(second.custom.mine.title, '自定义名');
});

test('自己写入的内容也会更新回退基线', () => {
  const { file, legacy } = tempFile('state.json');
  writeActiveState({ ...emptyState(), active: ['new-one'] }, file);
  fs.writeFileSync(file, '{');           // 紧接着被写坏
  const st = readActiveState(file, legacy);
  assert.deepEqual(st.active, ['new-one'], '回退基线应停在最后一次成功写入的内容');
});

test('旧版状态文件：迁移到新文件并删除（只做一次）', () => {
  const { file, legacy } = tempFile('state.json');
  fs.writeFileSync(legacy, JSON.stringify({ active: ['old'], unchecked: { x: 5 } }));
  const st = readActiveState(file, legacy);
  assert.deepEqual(st.active, ['old']);
  assert.deepEqual(st.unchecked, { x: 5 });
  assert.ok(fs.existsSync(file), '迁移后应写入新文件');
  assert.ok(!fs.existsSync(legacy), '旧文件应被删除');
  // 第二次读：走新文件，不会又迁移一遍。
  assert.deepEqual(readActiveState(file, legacy).active, ['old']);
});
