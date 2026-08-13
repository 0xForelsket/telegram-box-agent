export interface DurableMemory {
  id: string;
  scope: 'private' | 'group';
  type: 'fact' | 'preference' | 'person' | 'topic' | 'reminder';
  text: string;
  createdAt: string;
  updatedAt: string;
}

export function parseDurableMemories(raw: string | null): DurableMemory[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as DurableMemory[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(memory =>
      memory &&
      typeof memory.id === 'string' &&
      typeof memory.text === 'string' &&
      typeof memory.createdAt === 'string' &&
      typeof memory.updatedAt === 'string' &&
      (memory.scope === 'private' || memory.scope === 'group') &&
      ['fact', 'preference', 'person', 'topic', 'reminder'].includes(memory.type),
    );
  } catch {
    return [];
  }
}

export function rankDurableMemories(memories: DurableMemory[], query: string, limit = 10): DurableMemory[] {
  const terms = getMemoryTerms(query);
  return memories
    .map(memory => ({
      memory,
      score: terms.reduce((score, term) => score + (memory.text.toLowerCase().includes(term) ? 1 : 0), 0),
    }))
    .filter(item => query.trim() === '' || item.score > 0)
    .sort((left, right) => right.score - left.score || right.memory.updatedAt.localeCompare(left.memory.updatedAt))
    .slice(0, limit)
    .map(item => item.memory);
}

export function normalizeMemoryText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function getMemoryIdentity(text: string): string | null {
  const keyed = text.match(/^([^:]{2,80}):\s*.+$/);
  if (keyed) return normalizeMemoryText(keyed[1]);
  const preference = text.match(/^(.{2,80}?)\s+(?:is|are|prefers?|likes?)\s+.+$/i);
  return preference ? normalizeMemoryText(preference[1]) : null;
}

export function textIsDuplicateOfMemory(text: string, memories: DurableMemory[]): boolean {
  const normalized = normalizeMemoryText(text);
  if (normalized.length < 8) return false;
  return memories.some(memory => {
    const memoryText = normalizeMemoryText(memory.text);
    return memoryText === normalized || memoryText.includes(normalized) || normalized.includes(memoryText);
  });
}

export function removeDuplicateMemorySentences(text: string, memories: DurableMemory[]): string {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence && !textIsDuplicateOfMemory(sentence, memories))
    .join(' ')
    .trim();
}

export function inferMemoryType(text: string): DurableMemory['type'] {
  if (/\b(prefer|preference|like|dislike|favorite|favourite)\b/i.test(text)) return 'preference';
  if (/\b(remind|reminder|due|deadline)\b/i.test(text)) return 'reminder';
  if (/\b(topic|project|plan|working on)\b/i.test(text)) return 'topic';
  if (/\b(he|she|they|person|friend|colleague|wife|husband|brother|sister)\b/i.test(text)) return 'person';
  return 'fact';
}

function getMemoryTerms(text: string): string[] {
  const stopWords = new Set(['about', 'from', 'have', 'that', 'their', 'this', 'what', 'with']);
  return [...new Set((text.toLowerCase().match(/[\p{L}\p{N}_@.-]+/gu) || [])
    .filter(term => term.length >= 3 && !stopWords.has(term)))]
    .slice(0, 20);
}
