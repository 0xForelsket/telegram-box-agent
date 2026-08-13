import { describe, expect, it } from 'vitest';
import {
  activeTopicsKey,
  ambientMessagesKey,
  bookmarksKey,
  botSettingsKey,
  conversationSummaryKey,
  durableMemoryKey,
  feedSubscriptionsKey,
  groupProfileKey,
  isGroupSession,
  lastReadKey,
  lastSourcesKey,
  personCardsKey,
  recentTurnsKey,
  seenMembersKey,
} from './session_keys';

const GROUP = 'group:-100123';
const PRIVATE = '42';

describe('isGroupSession', () => {
  it('recognises a group session key', () => {
    expect(isGroupSession(GROUP)).toBe(true);
  });

  it('treats a bare user id as private', () => {
    expect(isGroupSession(PRIVATE)).toBe(false);
    expect(isGroupSession('')).toBe(false);
  });

  it('does not match a key that merely contains "group:"', () => {
    expect(isGroupSession('user:group:1')).toBe(false);
  });
});

describe('session key layout', () => {
  const builders = [
    groupProfileKey, recentTurnsKey, conversationSummaryKey, ambientMessagesKey,
    seenMembersKey, personCardsKey, activeTopicsKey, botSettingsKey,
    durableMemoryKey, lastSourcesKey, lastReadKey, bookmarksKey, feedSubscriptionsKey,
  ];

  it('gives every namespace a distinct prefix', () => {
    const keys = builders.map(build => build(PRIVATE));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('scopes every key to the session', () => {
    for (const build of builders) {
      expect(build(GROUP).endsWith(GROUP), build.name).toBe(true);
      expect(build(PRIVATE).endsWith(PRIVATE), build.name).toBe(true);
    }
  });

  it('keeps group and private sessions in separate keys', () => {
    for (const build of builders) {
      expect(build(GROUP), build.name).not.toBe(build(PRIVATE));
    }
  });

  // These strings are a storage contract: changing one orphans the data
  // already written under the old name. Pinned so a rename is a deliberate act.
  it('pins the stored key names', () => {
    expect(groupProfileKey(PRIVATE)).toBe('group_profile:42');
    expect(recentTurnsKey(PRIVATE)).toBe('recent_turns:42');
    expect(conversationSummaryKey(PRIVATE)).toBe('conversation_summary:42');
    expect(ambientMessagesKey(PRIVATE)).toBe('ambient_messages:42');
    expect(seenMembersKey(PRIVATE)).toBe('seen_members:42');
    expect(personCardsKey(PRIVATE)).toBe('person_cards:42');
    expect(activeTopicsKey(PRIVATE)).toBe('active_topics:42');
    expect(botSettingsKey(PRIVATE)).toBe('bot_settings:42');
    expect(durableMemoryKey(PRIVATE)).toBe('memory:v2:42');
    expect(lastSourcesKey(PRIVATE)).toBe('last_sources:v1:42');
    expect(lastReadKey(PRIVATE)).toBe('last_read:v1:42');
    expect(bookmarksKey(PRIVATE)).toBe('bookmarks:v1:42');
    expect(feedSubscriptionsKey(PRIVATE)).toBe('feeds:v1:42');
  });
});
