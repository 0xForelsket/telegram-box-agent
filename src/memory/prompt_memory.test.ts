import { describe, expect, it } from 'vitest';
import {
  buildStableMemoryBlock,
  describeFreshness,
  parsePersonCards,
  selectRelevantPromptMemory,
} from './prompt_memory';

describe('prompt memory', () => {
  it('parses only structurally valid person cards', () => {
    expect(parsePersonCards(JSON.stringify([
      { name: 'Ari', notes: ['likes Rust'], lastUpdatedAt: '2026-08-13T00:00:00Z' },
      { name: 'broken', notes: 'not-an-array', lastUpdatedAt: '2026-08-13T00:00:00Z' },
    ]))).toEqual([{ name: 'Ari', notes: ['likes Rust'], lastUpdatedAt: '2026-08-13T00:00:00Z' }]);
    expect(parsePersonCards('{bad-json')).toEqual([]);
  });

  it('selects subject-relevant memory ahead of unrelated recent memory', () => {
    const selected = selectRelevantPromptMemory({
      promptText: 'What did Ari decide about Rust?', replyContext: null,
      personCards: [
        { name: 'Bea', notes: ['likes Go'], lastUpdatedAt: '2026-08-13T00:00:00Z' },
        { name: 'Ari', notes: ['chose Rust'], lastUpdatedAt: '2026-08-13T00:00:00Z' },
      ],
      seenMembers: [], activeTopics: [], ambientMessages: [], durableMemories: [],
    });
    expect(selected.personCards.map(card => card.name)).toEqual(['Ari']);
  });

  it('bounds assembled stable memory and labels freshness deterministically', () => {
    const block = buildStableMemoryBlock({
      groupProfile: 'A'.repeat(500), personCards: [], conversationSummary: null, durableMemories: [],
    }, 120);
    expect(block?.length).toBeLessThanOrEqual(120);
    expect(describeFreshness('2026-08-13T11:00:00Z', Date.parse('2026-08-13T12:00:00Z'))).toBe('seen 1h ago');
  });
});
