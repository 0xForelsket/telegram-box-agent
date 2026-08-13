/**
 * Redis key layout for per-session state.
 *
 * Collected here so the namespace is visible in one place rather than spread
 * across a dozen one-line methods. Changing any of these strings orphans the
 * data already stored under the old name, so treat them as a storage contract:
 * add a new version prefix rather than editing one in place.
 */

export function isGroupSession(sessionKey: string): boolean {
  return sessionKey.startsWith('group:');
}

export function groupProfileKey(sessionKey: string): string {
  return `group_profile:${sessionKey}`;
}

export function recentTurnsKey(sessionKey: string): string {
  return `recent_turns:${sessionKey}`;
}

export function conversationSummaryKey(sessionKey: string): string {
  return `conversation_summary:${sessionKey}`;
}

export function ambientMessagesKey(sessionKey: string): string {
  return `ambient_messages:${sessionKey}`;
}

export function seenMembersKey(sessionKey: string): string {
  return `seen_members:${sessionKey}`;
}

export function personCardsKey(sessionKey: string): string {
  return `person_cards:${sessionKey}`;
}

export function activeTopicsKey(sessionKey: string): string {
  return `active_topics:${sessionKey}`;
}

export function botSettingsKey(sessionKey: string): string {
  return `bot_settings:${sessionKey}`;
}

export function durableMemoryKey(sessionKey: string): string {
  return `memory:v2:${sessionKey}`;
}

export function lastSourcesKey(sessionKey: string): string {
  return `last_sources:v1:${sessionKey}`;
}

export function lastReadKey(sessionKey: string): string {
  return `last_read:v1:${sessionKey}`;
}

export function bookmarksKey(sessionKey: string): string {
  return `bookmarks:v1:${sessionKey}`;
}

export function feedSubscriptionsKey(sessionKey: string): string {
  return `feeds:v1:${sessionKey}`;
}
