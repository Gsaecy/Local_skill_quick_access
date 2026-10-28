// 共享勾选状态比对：决定「要不要重写全局指令」的那一步。
//
// 背景：`~/.copilot/.skill-quick-launch.json` 现在由两个扩展读写——本扩展的面板，
// 和 HWChat 的对话面板。于是文档监听器收到变更时有两种情况必须分开处理：
//
//   1. 别人改了**勾选** → 全局指令 `~/.github/copilot-instructions.md` 必须跟着重写，
//      否则它停在旧清单上，直到重启 VS Code 才纠正。
//   2. 别人只写了 `lastUsed`（HWChat 每轮加载 Skill 都会写）→ **不能**重写：那等于
//      每次模型调用前都改一遍 Copilot 读的指令文件。
//
// 判据就是勾选集合的签名。这里钉住它最关键的三条语义：与顺序无关、去重、空值收敛，
// 以及「同一集合重复调用不重写」——漏了任何一条都会退化成每次都重写或永远不写。
const assert = require('node:assert/strict');
const test = require('node:test');
const { activeDiff, activeSignature, shouldSyncInstructions } = require('../out/sharedState.js');

test('签名与顺序无关：勾选先后顺序不代表语义', () => {
  assert.equal(activeSignature(['a', 'b']), activeSignature(['b', 'a']));
  // 那个文件里 active 的顺序取决于谁先写（本面板 / HWChat / 自动勾选），
  // 如果签名对顺序敏感，一次重排就会被当成「勾选变了」而重写指令。
  assert.equal(shouldSyncInstructions(activeSignature(['a', 'b']), ['b', 'a']), false);
});

test('签名去重并去空白：历史脏数据不该造成每次都重写', () => {
  assert.equal(activeSignature(['a', 'a', 'b']), activeSignature(['a', 'b']));
  assert.equal(activeSignature([' a ', 'b']), activeSignature(['a', 'b']));
  assert.equal(activeSignature(['a', '', '  ']), activeSignature(['a']));
  assert.equal(activeSignature([]), '');
  assert.equal(activeSignature(['']), '');
});

test('签名忽略非字符串：从 JSON 读回来的脏值不能让比较失准', () => {
  assert.equal(activeSignature(['a', 1, null, undefined, {}, 'b']), activeSignature(['a', 'b']));
});

test('勾选真的变了才重写', () => {
  const before = activeSignature(['a', 'b']);
  assert.equal(shouldSyncInstructions(before, ['a', 'b']), false, '没变不该重写');
  assert.equal(shouldSyncInstructions(before, ['a', 'b', 'c']), true, '新增必须重写');
  assert.equal(shouldSyncInstructions(before, ['a']), true, '取消必须重写');
  assert.equal(shouldSyncInstructions('', []), false, '空集合对空集合不重写');

  // 从未写过（首次启动）必须写一次，否则全局指令里根本没有这个区块。
  assert.equal(shouldSyncInstructions(null, []), true);
  assert.equal(shouldSyncInstructions(null, ['a']), true);
});

test('展示内容变了必须强制重写，哪怕勾选集合一模一样', () => {
  const same = activeSignature(['a', 'b']);
  // 改显示名、换分类、切换 activationMode、启动时的格式升级都属于这种情况：
  // 只比签名永远判不出需要重写，所以调用方必须显式 force。
  assert.equal(shouldSyncInstructions(same, ['a', 'b'], true), true);
  assert.equal(shouldSyncInstructions(null, ['a'], true), true);
});

test('增减明细：只用于向用户说明改了什么', () => {
  assert.deepEqual(activeDiff(['a', 'b'], ['b', 'c']), { added: ['c'], removed: ['a'] });
  assert.deepEqual(activeDiff([], ['a']), { added: ['a'], removed: [] });
  assert.deepEqual(activeDiff(['a'], []), { added: [], removed: ['a'] });
  // 结果排序固定，展示文案不会因文件里的顺序而跳动。
  assert.deepEqual(activeDiff([], ['b', 'a']), { added: ['a', 'b'], removed: [] });
  // 空白与重复同样要被收敛掉。
  assert.deepEqual(activeDiff(['a', 'a', ' '], [' a ']), { added: [], removed: [] });
});
