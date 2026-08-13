import { describe, expect, it } from 'vitest';
import { getMemoryIdentity, inferMemoryType, normalizeMemoryText, parseDurableMemories, rankDurableMemories, removeDuplicateMemorySentences, textIsDuplicateOfMemory } from './durable_memory';

describe('durable memory helpers', () => {
  const memories = [
    { id: 'old', scope: 'private' as const, type: 'fact' as const, text: 'Project Atlas uses blue labels', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    { id: 'new', scope: 'private' as const, type: 'preference' as const, text: 'I prefer concise Atlas reports', createdAt: '2026-02-01', updatedAt: '2026-02-01' },
  ];

  it('parses valid records and ignores malformed records', () => {
    expect(parseDurableMemories(JSON.stringify([...memories, { id: 1 }]))).toEqual(memories);
  });

  it('ranks relevant memories and normalizes duplicates', () => {
    expect(rankDurableMemories(memories, 'Atlas report').map(memory => memory.id)).toEqual(['new', 'old']);
    expect(normalizeMemoryText('  SAME, fact! ')).toBe('same fact');
  });

  it('infers common memory categories', () => {
    expect(inferMemoryType('I prefer short replies')).toBe('preference');
    expect(inferMemoryType('Project Atlas is active')).toBe('topic');
    expect(inferMemoryType('The office is in KL')).toBe('fact');
  });

  it('identifies keyed corrections and duplicate lower-confidence text', () => {
    expect(getMemoryIdentity('favorite color: blue')).toBe('favorite color');
    expect(getMemoryIdentity('favorite color: orange')).toBe('favorite color');
    expect(textIsDuplicateOfMemory('Project Atlas uses blue labels', memories)).toBe(true);
    expect(removeDuplicateMemorySentences('Project Atlas uses blue labels. Keep this unrelated sentence.', memories))
      .toBe('Keep this unrelated sentence.');
  });
});
