/**
 * 共享勾选状态的比对工具。
 *
 * `~/.copilot/.skill-quick-launch.json` 现在由两个扩展读写：本扩展的面板，以及
 * HWChat 的对话面板（那边的勾选框直接读写同一份 `active`）。
 *
 * 由此多出一条必须处理的路径：**勾选可能是别人改的**。文件监听器收到变更后如果
 * 一味重写 `~/.github/copilot-instructions.md`，会顺手踩到另一个坑——HWChat 每轮
 * 实际加载 Skill 都会往同一份文件写 `lastUsed`，于是「每次模型调用前都重写一遍
 * 全局指令」。这个文件是给 Copilot 读的，写在半途可能被读到一半的内容；同时也会让
 * 文件修改时间在每次对话里跳一次，看上去像被反复篡改。
 *
 * 所以重写前先比一次「勾选集合有没有真的变」。比较用的签名对顺序不敏感——那个文件
 * 里 `active` 的顺序取决于谁先写，不代表语义；去重与去空白同理，否则 `["a", "a"]`
 * 这种历史脏数据会让它一直判为「变了」，变成每次都重写的死循环。
 */

/** 把勾选列表收敛成可比较的签名：去空白、去重、排序后用换行连接。 */
export function activeSignature(names: readonly string[]): string {
  const unique = [...new Set(
    names
      .filter((name): name is string => typeof name === 'string')
      .map((name) => name.trim())
      .filter(Boolean),
  )];
  unique.sort((left, right) => left.localeCompare(right));
  return unique.join('\n');
}

/**
 * 要不要重写全局指令。
 *
 * @param previous 上一次写文件时的签名（从未写过传 `null`）
 * @param force 展示内容也变了（改显示名、换分类、激活模式切换、启动时的格式升级）——
 *   这些不体现在勾选集合里，只比签名永远判不出需要重写。
 */
export function shouldSyncInstructions(
  previous: string | null,
  names: readonly string[],
  force = false,
): boolean {
  return force || activeSignature(names) !== previous;
}

/**
 * 两次备选状态之间的增减，用于向用户说明「这次是别人改了哪些勾选」。
 * 只做展示用途，不参与是否重写的判断。
 */
export function activeDiff(
  previous: readonly string[],
  next: readonly string[],
): { added: string[]; removed: string[] } {
  const before = new Set(previous.map((name) => name.trim()).filter(Boolean));
  const after = new Set(next.map((name) => name.trim()).filter(Boolean));
  const added: string[] = [];
  const removed: string[] = [];
  for (const name of after) {
    if (!before.has(name)) { added.push(name); }
  }
  for (const name of before) {
    if (!after.has(name)) { removed.push(name); }
  }
  added.sort((left, right) => left.localeCompare(right));
  removed.sort((left, right) => left.localeCompare(right));
  return { added, removed };
}
