/**
 * 共享状态文件的读写：`~/.copilot/.skill-quick-launch.json`。
 *
 * 这个文件现在**由两个扩展共同读写**：本扩展的面板，以及 HWChat 的对话面板（那边
 * 的勾选框直接读写同一份 `active`）。两个写入方都是「截断再写」，不是原子替换，
 * 于是多出一类以前没有的风险：
 *
 * - 读到一半（文件被截断成空）→ 解析失败；
 * - 若这时把「读不懂」当成「用户什么都没勾」，随后任意一次写入都会用空状态覆盖
 *   文件——用户的**全部勾选、分类改名、自建分类、自定义名称、历史调用时间**一起消失。
 *
 * 所以这里做两件事：
 * 1. 读取成功时把结果留一份在内存里（按文件路径分开存，测试可以用临时文件互不干扰）；
 * 2. 读取失败时优先回退到那份「上一次成功读到的状态」，而不是空状态。
 *
 * 回退不是掩盖错误：真损坏时下一次写入会把这份完整状态写回去，等于顺手修好了文件；
 * 而空状态则会静默清空配置，两者代价不对等。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** 状态文件放在 skills 目录之外，避免自身写入触发目录监听导致面板刷新（分类折叠丢失） */
export const STATE_FILE = path.join(os.homedir(), '.copilot', '.skill-quick-launch.json');
/** 旧版状态文件位置（0.3.x），读取后迁移并删除 */
export const LEGACY_STATE_FILE = path.join(os.homedir(), '.copilot', 'skills', '.active-skills.json');

export interface ActiveState {
  active: string[];
  unchecked: Record<string, number>; // 用户手动取消勾选的时间戳（晚于该时间的命中才自动勾回）
  lastUsed: Record<string, number>; // 技能名 → 最近一次确认调用时间；供 HWChat 等扩展共享
  custom: Record<string, { title: string; desc: string }>; // 自建技能的自定义名称/描述
  origins: Record<string, 'self' | 'third'>; // 用户显式指定的来源标记
  /** 内置分类改名（id → 标题）；空/缺失用默认名 */
  categoryTitles: Record<string, string>;
  /** 用户自建分类（按创建顺序追加在内置分类之后） */
  customCategories: { id: string; title: string }[];
  /** 技能 → 分类的手动指定；优先于内置映射 */
  skillCategory: Record<string, string>;
}

export function emptyState(): ActiveState {
  return {
    active: [],
    unchecked: {},
    lastUsed: {},
    custom: {},
    origins: {},
    categoryTitles: {},
    customCategories: [],
    skillCategory: {},
  };
}

/** 每个状态文件各自缓存「上一次成功读到的内容」。 */
const lastGood = new Map<string, ActiveState>();

/** 深拷贝：调用方会就地改返回值再写回，共享同一份对象会把缓存也改掉。 */
function cloneState(state: ActiveState): ActiveState {
  return structuredClone(state);
}

function asRecord<T>(value: unknown): Record<string, T> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, T>)
    : undefined;
}

export function readActiveState(
  file: string = STATE_FILE,
  legacyFile: string = LEGACY_STATE_FILE,
): ActiveState {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const state: ActiveState = {
      active: Array.isArray(j.active) ? j.active : [],
      unchecked: asRecord<number>(j.unchecked) ?? {},
      lastUsed: asRecord<number>(j.lastUsed) ?? {},
      custom: asRecord<{ title: string; desc: string }>(j.custom) ?? {},
      origins: asRecord<'self' | 'third'>(j.origins) ?? {},
      categoryTitles: asRecord<string>(j.categoryTitles) ?? {},
      customCategories: Array.isArray(j.customCategories)
        ? j.customCategories.filter(
            (c: unknown): c is { id: string; title: string } =>
              !!c && typeof (c as { id?: unknown }).id === 'string',
          )
        : [],
      skillCategory: asRecord<string>(j.skillCategory) ?? {},
    };
    lastGood.set(file, cloneState(state));
    return state;
  } catch { /* 首次使用、文件损坏，或另一个扩展正写到一半 */ }
  // 迁移旧版状态（~/.copilot/skills/.active-skills.json）
  try {
    if (fs.existsSync(legacyFile)) {
      const j = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
      const st = emptyState();
      if (Array.isArray(j.active)) { st.active = j.active; }
      if (j.unchecked && typeof j.unchecked === 'object') { st.unchecked = j.unchecked; }
      writeActiveState(st, file);
      try { fs.unlinkSync(legacyFile); } catch { /* 删除失败不影响功能 */ }
      return st;
    }
  } catch { /* 旧文件不可读时忽略 */ }
  // 读不懂：用上一次成功读到的状态，别拿空状态去覆盖用户的勾选与分类。
  const cached = lastGood.get(file);
  return cached ? cloneState(cached) : emptyState();
}

export function writeActiveState(state: ActiveState, file: string = STATE_FILE): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
  // 自己写进去的内容同样是一次“成功读到的状态”，回退基线要跟着走，
  // 否则下一次误读会把旧内容当成真相写回去。
  lastGood.set(file, cloneState(state));
}

export function writeActive(names: string[], file: string = STATE_FILE): void {
  const st = readActiveState(file);
  st.active = names;
  writeActiveState(st, file);
}

export function readActive(file: string = STATE_FILE): string[] {
  return readActiveState(file).active;
}

/** 用户手动取消勾选：记录时间戳，避免被旧记录自动勾回 */
export function markUnchecked(name: string, file: string = STATE_FILE): void {
  const st = readActiveState(file);
  st.unchecked[name] = Date.now();
  writeActiveState(st, file);
}
