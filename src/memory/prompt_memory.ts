import {
  type DurableMemory,
  removeDuplicateMemorySentences,
  textIsDuplicateOfMemory,
} from './durable_memory';

export interface SeenMember {
  userId: string;
  displayName: string;
  username?: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface PersonCard {
  name: string;
  notes: string[];
  lastUpdatedAt: string;
}

export interface ActiveTopic {
  topic: string;
  status?: string;
  lastUpdatedAt: string;
}

export function parseSeenMembers(raw: string | null): SeenMember[] {
  return parseArray(raw, 'seen members', member => !!member
    && typeof member.userId === 'string'
    && typeof member.displayName === 'string'
    && typeof member.firstSeenAt === 'string'
    && typeof member.lastSeenAt === 'string');
}

export function parsePersonCards(raw: string | null): PersonCard[] {
  return parseArray(raw, 'person cards', card => !!card
    && typeof card.name === 'string'
    && Array.isArray(card.notes)
    && typeof card.lastUpdatedAt === 'string');
}

export function parseActiveTopics(raw: string | null): ActiveTopic[] {
  return parseArray(raw, 'active topics', topic => !!topic
    && typeof topic.topic === 'string'
    && typeof topic.lastUpdatedAt === 'string');
}

export function parseAmbientMessages(raw: string | null): string[] {
  return parseArray(raw, 'ambient messages', item => typeof item === 'string');
}

export function formatSeenMembers(seenMembers: SeenMember[], includeFreshness = true): string {
  return seenMembers.slice(-12).map(member => {
    const username = member.username ? ` (@${member.username})` : '';
    const freshness = includeFreshness ? ` [${describeFreshness(member.lastSeenAt)}]` : '';
    return `- ${member.displayName}${username}${freshness}`;
  }).join('\n');
}

export function formatPersonCards(personCards: PersonCard[]): string {
  return personCards.slice(-10).map(card => `- ${card.name}: ${card.notes.join('; ')}`).join('\n');
}

export function formatActiveTopics(activeTopics: ActiveTopic[], includeFreshness = true): string {
  return activeTopics.slice(-6).map(topic => {
    const status = topic.status ? ` (${topic.status})` : '';
    const freshness = includeFreshness ? ` [${describeFreshness(topic.lastUpdatedAt)}]` : '';
    return `- ${topic.topic}${status}${freshness}`;
  }).join('\n');
}

export function selectRelevantPromptMemory(inputs: {
  promptText: string;
  replyContext: string | null;
  personCards: PersonCard[];
  seenMembers: SeenMember[];
  activeTopics: ActiveTopic[];
  ambientMessages: string[];
  durableMemories: DurableMemory[];
}) {
  const queryTerms = relevanceTerms(`${inputs.promptText}\n${inputs.replyContext || ''}`);
  const isRelevant = (text: string) => {
    const normalized = text.toLowerCase();
    return queryTerms.some(term => normalized.includes(term));
  };
  const relevantOrRecent = <T>(items: T[], toText: (item: T) => string, maximum: number, fallback: number) => {
    const relevant = items.filter(item => isRelevant(toText(item)));
    return (relevant.length > 0 ? relevant : items.slice(-fallback)).slice(-maximum);
  };

  return {
    personCards: relevantOrRecent(inputs.personCards, card => `${card.name} ${card.notes.join(' ')}`, 6, 3),
    seenMembers: relevantOrRecent(inputs.seenMembers, member => `${member.displayName} ${member.username || ''}`, 8, 4),
    activeTopics: relevantOrRecent(inputs.activeTopics, topic => `${topic.topic} ${topic.status || ''}`, 4, 2),
    ambientMessages: relevantOrRecent(inputs.ambientMessages, message => message, 5, 2),
    durableMemories: relevantOrRecent(inputs.durableMemories, memory => memory.text, 8, 4),
  };
}

export function buildStableMemoryBlock(inputs: {
  groupProfile: string | null;
  personCards: PersonCard[];
  conversationSummary: string | null;
  durableMemories: DurableMemory[];
}, maxChars = 6_500): string | null {
  const sections: string[] = [];
  const filteredProfile = inputs.groupProfile
    ? removeDuplicateMemorySentences(inputs.groupProfile, inputs.durableMemories)
    : '';
  const filteredSummary = inputs.conversationSummary
    ? removeDuplicateMemorySentences(inputs.conversationSummary, inputs.durableMemories)
    : '';
  const filteredPersonCards = inputs.personCards
    .map(card => ({ ...card, notes: card.notes.filter(note => !textIsDuplicateOfMemory(note, inputs.durableMemories)) }))
    .filter(card => card.notes.length > 0 && !textIsDuplicateOfMemory(`${card.name}: ${card.notes.join('; ')}`, inputs.durableMemories));

  if (filteredProfile) sections.push(`## Group profile\nLong-term context about the group's vibe, members, nicknames, in-jokes, and preferences.\n${filteredProfile}`);
  if (filteredPersonCards.length > 0) sections.push(`## People\nSoft memory hints from repeated group behavior - not gospel.\n${formatPersonCards(filteredPersonCards)}`);
  if (filteredSummary) sections.push(`## Summary\nRolling memory; prioritize newer messages when they conflict.\n${filteredSummary}`);
  if (inputs.durableMemories.length > 0) {
    sections.push(`## Explicit memory\nUser-managed durable facts; prefer newer explicit corrections.\n${inputs.durableMemories.map(memory => `- [${memory.id}] ${memory.text}`).join('\n')}`);
  }
  return assembleContextBlock('Durable memory for this chat:', sections, maxChars);
}

export function buildVolatileContextBlock(inputs: {
  currentSubjectHint: string | null;
  seenMembers: SeenMember[];
  activeTopics: ActiveTopic[];
  ambientMessages: string[];
  replyContext: string | null;
}, maxChars = 3_500): string | null {
  const sections: string[] = [];
  if (inputs.currentSubjectHint) sections.push(`## Current subject\n${inputs.currentSubjectHint}`);
  if (inputs.seenMembers.length > 0) sections.push(`## Relevant people\nSoft roster hints; not a guaranteed full member list.\n${formatSeenMembers(inputs.seenMembers, false)}`);
  if (inputs.activeTopics.length > 0) sections.push(`## Relevant topics\nOngoing situational context.\n${formatActiveTopics(inputs.activeTopics, false)}`);
  if (inputs.replyContext) sections.push(`## Reply context\n${inputs.replyContext}`);
  if (inputs.ambientMessages.length > 0) sections.push(`## Relevant ambient\nGroup chatter observed without being directly addressed - soft context only.\n${inputs.ambientMessages.join('\n')}`);
  return assembleContextBlock('Current context for this request:', sections, maxChars);
}

export function describeFreshness(timestamp: string, now = Date.now()): string {
  const seenAt = new Date(timestamp).getTime();
  if (Number.isNaN(seenAt)) return 'unknown';
  const diffMinutes = Math.max(0, Math.floor((now - seenAt) / 60_000));
  if (diffMinutes < 15) return 'just seen';
  if (diffMinutes < 180) return `seen ${Math.max(1, Math.floor(diffMinutes / 60))}h ago`;
  if (diffMinutes < 1_440) return 'seen today';
  if (diffMinutes < 10_080) return `seen ${Math.max(1, Math.floor(diffMinutes / 1_440))}d ago`;
  return 'stale';
}

function relevanceTerms(text: string): string[] {
  const stopWords = new Set([
    'about', 'after', 'before', 'could', 'from', 'have', 'just', 'latest', 'please', 'that',
    'their', 'there', 'these', 'they', 'this', 'what', 'when', 'where', 'which', 'with', 'would',
  ]);
  return [...new Set((text.toLowerCase().match(/[\p{L}\p{N}_@.-]+/gu) || [])
    .filter(term => term.length >= 3 && !stopWords.has(term)))].slice(0, 20);
}

function assembleContextBlock(header: string, sections: string[], maxChars: number): string | null {
  if (sections.length === 0) return null;
  const prefix = `${header}\n\n`;
  let totalChars = prefix.length;
  const includedSections: string[] = [];
  for (const section of sections) {
    const remaining = maxChars - totalChars - 2;
    if (remaining <= 0) break;
    const included = section.slice(0, remaining);
    includedSections.push(included);
    totalChars += included.length + 2;
  }
  return `${prefix}${includedSections.join('\n\n')}`;
}

function parseArray<T>(raw: string | null, label: string, valid: (item: any) => boolean): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(valid) as T[] : [];
  } catch (error) {
    console.error(`Error parsing ${label}:`, error);
    return [];
  }
}
