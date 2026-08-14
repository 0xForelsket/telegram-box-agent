/**
 * The allowlist of external writes a Box job may ask the Worker to perform.
 *
 * The shell classifier in `execution_policy.ts` inspects bash strings, which is
 * defence in depth and nothing more: `x="git push"; $x` defeats it, and a
 * script's internal network calls are invisible to it. This catalog inverts
 * that model. The Box cannot perform the write at all — it can only *ask* for
 * one of these named operations with structured parameters. The Worker holds
 * the credential, validates the parameters, shows the owner exactly what will
 * happen, and then performs the operation itself.
 *
 * The consequence worth stating plainly: what the owner approves is what
 * executes, because the approved parameters are the only thing the executor
 * ever sees. The Box never gets a chance to substitute anything.
 *
 * Adding an action means adding an entry here. Keep each one narrow — a
 * parameter that accepts a whole URL or a raw command re-opens the gap this
 * closes.
 */

export type ActionName =
  | 'github.issue_comment'
  | 'github.create_issue';

export interface ActionRequest {
  action: ActionName;
  params: Record<string, string | number>;
}

export interface ActionDefinition {
  /** One line shown to the owner above the parameters. */
  summary: string;
  /** Credential the Worker must hold for this action to be offered at all. */
  credential: 'github';
  validate(raw: Record<string, unknown>): Record<string, string | number>;
  /** Human-readable preview of the exact effect, shown in the approval prompt. */
  describe(params: Record<string, string | number>): string;
}

export const ACTION_CATALOG: Record<ActionName, ActionDefinition> = {
  'github.issue_comment': {
    summary: 'Post a comment on a GitHub issue or pull request',
    credential: 'github',
    validate: raw => ({
      owner: requireSlug(raw.owner, 'owner'),
      repo: requireSlug(raw.repo, 'repo'),
      issue_number: requirePositiveInt(raw.issue_number, 'issue_number'),
      body: requireText(raw.body, 'body', 60_000),
    }),
    describe: params =>
      `Comment on ${params.owner}/${params.repo}#${params.issue_number}:\n${truncate(String(params.body), 800)}`,
  },
  'github.create_issue': {
    summary: 'Open a new GitHub issue',
    credential: 'github',
    validate: raw => ({
      owner: requireSlug(raw.owner, 'owner'),
      repo: requireSlug(raw.repo, 'repo'),
      title: requireText(raw.title, 'title', 250),
      body: requireText(raw.body, 'body', 60_000),
    }),
    describe: params =>
      `Open issue in ${params.owner}/${params.repo}: ${truncate(String(params.title), 120)}\n${truncate(String(params.body), 700)}`,
  },
};

export function isActionName(value: unknown): value is ActionName {
  return typeof value === 'string' && value in ACTION_CATALOG;
}

/**
 * Parses an untrusted request into a validated one.
 *
 * Every field is re-derived rather than spread from the input, so an unexpected
 * key cannot ride along into the executor.
 */
export function parseActionRequest(raw: unknown): ActionRequest {
  if (!raw || typeof raw !== 'object') throw new Error('Action request must be an object.');
  const body = raw as Record<string, unknown>;
  if (!isActionName(body.action)) throw new Error('Unknown or unsupported action.');
  const params = body.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('Action params must be an object.');
  }
  return {
    action: body.action,
    params: ACTION_CATALOG[body.action].validate(params as Record<string, unknown>),
  };
}

/**
 * Stable fingerprint of an action and its exact parameters.
 *
 * The owner approves this hash, and the executor recomputes it before running.
 * Sorting the keys keeps it independent of JSON key order so an equivalent
 * request cannot present a different hash.
 */
export async function hashAction(request: ActionRequest): Promise<string> {
  const canonical = JSON.stringify([
    request.action,
    Object.keys(request.params).sort().map(key => [key, request.params[key]]),
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function describeAction(request: ActionRequest): string {
  const definition = ACTION_CATALOG[request.action];
  return `${definition.summary}\n${definition.describe(request.params)}`;
}

function requireSlug(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  // GitHub owner and repo names; anything else would let a path segment escape
  // into the API URL the executor builds.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(text)) {
    throw new Error(`Action parameter "${label}" is not a valid GitHub name.`);
  }
  return text;
}

function requirePositiveInt(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Action parameter "${label}" must be a positive integer.`);
  }
  return parsed;
}

function requireText(value: unknown, label: string, maxLength: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`Action parameter "${label}" is required.`);
  if (text.length > maxLength) throw new Error(`Action parameter "${label}" exceeds ${maxLength} characters.`);
  return text;
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}
