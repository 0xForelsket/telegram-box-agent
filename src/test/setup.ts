import { afterEach, beforeEach } from 'vitest';

const unexpectedFetches: string[] = [];
const rejectingFetch = async (input: RequestInfo | URL): Promise<Response> => {
  const target = input instanceof Request ? input.url : input.toString();
  unexpectedFetches.push(target);
  throw new Error(
    `Unexpected outbound fetch in test: ${target}. Stub globalThis.fetch or inject fetchImpl explicitly.`,
  );
};

globalThis.fetch = rejectingFetch as typeof fetch;

beforeEach(() => {
  unexpectedFetches.length = 0;
});

afterEach(() => {
  if (unexpectedFetches.length > 0) {
    throw new Error(
      `Test made unmocked outbound fetches:\n${unexpectedFetches.map(url => `- ${url}`).join('\n')}`,
    );
  }
});
