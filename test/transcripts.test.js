const assert = require('node:assert/strict');
const test = require('node:test');
const { extractExecutedSkillReads } = require('../out/transcripts.js');

test('ignores skill paths that only appear in prompt text', () => {
  const raw = JSON.stringify({
    type: 'assistant.message',
    timestamp: '2026-10-25T08:00:00.000Z',
    data: { text: 'Available: ~/.copilot/skills/project-doc-sync/SKILL.md' },
  });
  assert.deepEqual([...extractExecutedSkillReads(raw)], []);
});

test('records a skill when read_file execution starts', () => {
  const raw = JSON.stringify({
    type: 'tool.execution_start',
    timestamp: '2026-10-25T08:00:00.000Z',
    data: {
      toolName: 'read_file',
      arguments: { filePath: '/Users/test/.copilot/skills/project-doc-sync/SKILL.md' },
    },
  });
  assert.equal(
    extractExecutedSkillReads(raw).get('project-doc-sync'),
    Date.parse('2026-10-25T08:00:00.000Z'),
  );
});

test('supports legacy completed copilot_readFile records and Windows paths', () => {
  const raw = JSON.stringify({
    kind: 'toolInvocationSerialized',
    ts: 1_700_000_000_000,
    toolId: 'copilot_readFile',
    isComplete: true,
    input: { filePath: 'C:\\Users\\test\\.copilot\\skills\\awesome-design-md\\SKILL.md' },
  });
  assert.equal(extractExecutedSkillReads(raw).get('awesome-design-md'), 1_700_000_000_000);
});

test('does not count pending tool requests before execution', () => {
  const raw = JSON.stringify({
    type: 'assistant.message',
    timestamp: '2026-10-25T08:00:00.000Z',
    data: {
      toolRequests: [{
        name: 'read_file',
        arguments: JSON.stringify({ filePath: '/Users/test/.copilot/skills/project-doc-sync/SKILL.md' }),
      }],
    },
  });
  assert.deepEqual([...extractExecutedSkillReads(raw)], []);
});
