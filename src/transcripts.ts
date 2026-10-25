/**
 * 从 Copilot 会话记录中提取真正执行过的 SKILL.md 读取操作。
 * 只接受 read_file 一类工具的 execution 事件，避免把系统提示词里的技能清单误判为调用。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** VS Code 用户数据目录（跨平台：Windows APPDATA / Linux .config / macOS Library） */
function codeUserDataDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) { return path.join(appData, 'Code', 'User'); }
    return path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User');
  }
  if (process.platform === 'linux') {
    return path.join(os.homedir(), '.config', 'Code', 'User');
  }
  return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User');
}

const WS_ROOT = path.join(codeUserDataDir(), 'workspaceStorage');
const SKILL_PATH = /(?:^|[\\/])\.copilot[\\/]skills[\\/]([a-zA-Z0-9][a-zA-Z0-9-]*)[\\/]SKILL\.md\b/gi;

function walkTranscriptFiles(): string[] {
  const out: string[] = [];
  if (!fs.existsSync(WS_ROOT)) { return out; }
  for (const ws of fs.readdirSync(WS_ROOT, { withFileTypes: true })) {
    if (!ws.isDirectory()) { continue; }
    const dir = path.join(WS_ROOT, ws.name, 'GitHub.copilot-chat', 'transcripts');
    if (!fs.existsSync(dir)) { continue; }
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.jsonl')) { out.push(path.join(dir, f)); }
    }
  }
  return out;
}

/** 从 transcript 文本提取 技能名 → 最新真实读取时间戳(ms)。导出供测试使用。 */
export function extractExecutedSkillReads(raw: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of raw.split('\n')) {
    if (!line.includes('SKILL.md')) { continue; }
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    collectExecutedReads(event, eventTimestamp(event), out);
  }
  return out;
}

/** 从单个 transcript 文件提取 技能名 → 最新真实读取时间戳(ms)。 */
function extractHits(file: string): Map<string, number> {
  return extractExecutedSkillReads(fs.readFileSync(file, 'utf8'));
}

function collectExecutedReads(value: unknown, inheritedTs: number, out: Map<string, number>): void {
  if (!value || typeof value !== 'object') { return; }
  const record = value as Record<string, unknown>;
  const type = stringValue(record.type ?? record.kind).toLowerCase();
  const data = objectValue(record.data) ?? record;
  const toolName = stringValue(
    data.toolName ?? data.toolId ?? data.name ?? record.toolName ?? record.toolId,
  );
  const isExecutionEvent = type === 'tool.execution_start'
    || type === 'tool.execution_complete'
    || type === 'tool.execution_end'
    || type === 'toolinvocationserialized';
  const isCompletedLegacy = type !== 'toolinvocationserialized' || record.isComplete !== false;

  if (isExecutionEvent && isCompletedLegacy && isReadTool(toolName)) {
    const args = data.arguments ?? data.input ?? record.arguments ?? record.input ?? data;
    const ts = eventTimestamp(record) || inheritedTs;
    for (const name of skillNamesIn(args)) {
      out.set(name, Math.max(out.get(name) ?? 0, ts));
    }
  }

  for (const child of Object.values(record)) {
    if (child && typeof child === 'object') {
      collectExecutedReads(child, eventTimestamp(record) || inheritedTs, out);
    }
  }
}

function isReadTool(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[^a-z]/g, '');
  return normalized === 'readfile'
    || normalized === 'copilotreadfile'
    || normalized === 'readtextfile';
}

function skillNamesIn(value: unknown): Set<string> {
  const names = new Set<string>();
  const visit = (item: unknown): void => {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length < 200_000) {
        try { visit(JSON.parse(trimmed)); } catch { /* 普通字符串，继续按路径匹配 */ }
      }
      SKILL_PATH.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = SKILL_PATH.exec(item)) !== null) {
        names.add(match[1]);
      }
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) { visit(child); }
      return;
    }
    if (item && typeof item === 'object') {
      for (const child of Object.values(item as Record<string, unknown>)) { visit(child); }
    }
  };
  visit(value);
  return names;
}

function eventTimestamp(value: unknown): number {
  if (!value || typeof value !== 'object') { return 0; }
  const record = value as Record<string, unknown>;
  for (const candidate of [record.ts, record.timestamp, objectValue(record.data)?.timestamp]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate < 10_000_000_000 ? candidate * 1_000 : candidate;
    }
    if (typeof candidate === 'string') {
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) { return parsed; }
    }
  }
  return 0;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 增量扫描：known 记录 文件名→mtime 与 技能名→已知 ts。
 * 只处理 mtime 变化的文件；返回 技能名 → 最新命中 ts 的全量视图。
 */
export function scanTranscripts(known: Map<string, number>): Map<string, number> {
  const skills = new Map<string, number>();
  // 先把 known 中技能条目拷贝出来
  for (const [k, v] of known) {
    if (!k.startsWith('__file__')) { skills.set(k, v); }
  }
  for (const f of walkTranscriptFiles()) {
    let st: fs.Stats;
    try { st = fs.statSync(f); } catch { continue; }
    const key = '__file__' + f;
    if (known.get(key) === st.mtimeMs) { continue; } // 未变化
    try {
      const hits = extractHits(f);
      for (const [n, ts] of hits) {
        const resolvedTs = ts || st.mtimeMs;
        const prev = skills.get(n) ?? 0;
        if (resolvedTs > prev) {
          skills.set(n, resolvedTs);
          known.set(n, resolvedTs);
        }
      }
      known.set(key, st.mtimeMs);
    } catch { /* unreadable, skip */ }
  }
  return skills;
}
