export const BOX_APPROVAL_MARKER = 'BOX_APPROVAL_REQUIRED:';
export const BOX_PENDING_APPROVAL_PATH = '/workspace/home/.box-pending-approval.json';
export const BOX_APPROVAL_GRANT_PATH = '/workspace/home/.box-approval-grant.json';
export const BOX_APPROVAL_NONCE_PATH = '/workspace/home/.box-approval-nonce';

export type ProtectedActionCategory =
  | 'deployment'
  | 'spending'
  | 'external_destructive'
  | 'protected_push'
  | 'third_party_communication';

export interface PendingBoxApproval {
  nonce: string;
  category: ProtectedActionCategory;
  action: string;
  actionHash: string;
  requestedAt: number;
}

export function classifyProtectedShellAction(command: string): ProtectedActionCategory | null {
  const value = command.trim();
  if (!value) return null;
  if (/\b(?:wrangler|vercel|netlify|fly(?:ctl)?|railway|render)\s+(?:deploy|publish|release)\b|\bkubectl\s+(?:apply|create|delete|patch|replace|set)\b|\bterraform\s+(?:apply|destroy|import)\b|\b(?:aws|gcloud|az)\b[^\n;&|]*\b(?:deploy|create|delete|update|put|publish|release)\b|\bdocker\s+(?:push|buildx\s+build[^\n;&|]*--push)\b|\bgh\s+release\s+create\b/i.test(value)) {
    return 'deployment';
  }
  if (/\b(?:stripe|paypal)\b[^\n;&|]*\b(?:charge|payment|invoice|checkout|refund|transfer|payout|create)\b|\b(?:buy|purchase|place\s+order|top\s*up)\b/i.test(value)) {
    return 'spending';
  }
  if (/\bgit\s+push\b/i.test(value)) return 'protected_push';
  if (/\b(?:curl|http|wget)\b[^\n;&|]*(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b|\bgh\s+api\b[^\n;&|]*(?:-X|--method)\s*(?:POST|PUT|PATCH|DELETE)\b|\b(?:aws\s+s3\s+rm|aws\s+s3api\s+delete|rclone\s+(?:delete|purge)|kubectl\s+delete)\b/i.test(value)) {
    return 'external_destructive';
  }
  if (/\b(?:sendmail|mailx?|mutt)\b|\b(?:slack|discord|teams)\b[^\n;&|]*(?:send|post|message|webhook)|\bgh\s+(?:issue|pr)\s+(?:comment|create|close|merge)|\bcurl\b[^\n;&|]*(?:hooks\.slack\.com|discord(?:app)?\.com\/api\/webhooks|api\.telegram\.org)[^\n;&|]*(?:-d|--data|--form)/i.test(value)) {
    return 'third_party_communication';
  }
  return null;
}

export function parseApprovalMarker(value: string | undefined): PendingBoxApproval | null {
  if (!value) return null;
  const index = value.indexOf(BOX_APPROVAL_MARKER);
  if (index < 0) return null;
  const encoded = value.slice(index + BOX_APPROVAL_MARKER.length).trim().split(/\s/, 1)[0];
  try {
    const parsed = JSON.parse(base64UrlDecode(encoded)) as Partial<PendingBoxApproval>;
    if (!parsed || !/^[a-zA-Z0-9_-]{16,128}$/.test(parsed.nonce ?? '')) return null;
    if (!['deployment', 'spending', 'external_destructive', 'protected_push', 'third_party_communication'].includes(parsed.category ?? '')) return null;
    if (typeof parsed.action !== 'string' || !parsed.action.trim() || parsed.action.length > 4_000) return null;
    if (!/^[a-f0-9]{64}$/.test(parsed.actionHash ?? '')) return null;
    if (!Number.isFinite(parsed.requestedAt)) return null;
    return parsed as PendingBoxApproval;
  } catch {
    return null;
  }
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  let binary = '';
  if (typeof atob === 'function') binary = atob(padded);
  else throw new Error('Base64 decoding is unavailable.');
  return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
}

export const PI_EXECUTION_POLICY_EXTENSION_SOURCE = String.raw`
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";

const pendingPath = process.env.BOX_PENDING_APPROVAL_PATH || "/workspace/home/.box-pending-approval.json";
const grantPath = process.env.BOX_APPROVAL_GRANT_PATH || "/workspace/home/.box-approval-grant.json";
const noncePath = process.env.BOX_APPROVAL_NONCE_PATH || "/workspace/home/.box-approval-nonce";
const consumedApprovals = new Set();

function classify(command) {
  if (/\b(?:wrangler|vercel|netlify|fly(?:ctl)?|railway|render)\s+(?:deploy|publish|release)\b|\bkubectl\s+(?:apply|create|delete|patch|replace|set)\b|\bterraform\s+(?:apply|destroy|import)\b|\b(?:aws|gcloud|az)\b[^\n;&|]*\b(?:deploy|create|delete|update|put|publish|release)\b|\bdocker\s+(?:push|buildx\s+build[^\n;&|]*--push)\b|\bgh\s+release\s+create\b/i.test(command)) return "deployment";
  if (/\b(?:stripe|paypal)\b[^\n;&|]*\b(?:charge|payment|invoice|checkout|refund|transfer|payout|create)\b|\b(?:buy|purchase|place\s+order|top\s*up)\b/i.test(command)) return "spending";
  if (/\bgit\s+push\b/i.test(command)) return "protected_push";
  if (/\b(?:curl|http|wget)\b[^\n;&|]*(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b|\bgh\s+api\b[^\n;&|]*(?:-X|--method)\s*(?:POST|PUT|PATCH|DELETE)\b|\b(?:aws\s+s3\s+rm|aws\s+s3api\s+delete|rclone\s+(?:delete|purge)|kubectl\s+delete)\b/i.test(command)) return "external_destructive";
  if (/\b(?:sendmail|mailx?|mutt)\b|\b(?:slack|discord|teams)\b[^\n;&|]*(?:send|post|message|webhook)|\bgh\s+(?:issue|pr)\s+(?:comment|create|close|merge)|\bcurl\b[^\n;&|]*(?:hooks\.slack\.com|discord(?:app)?\.com\/api\/webhooks|api\.telegram\.org)[^\n;&|]*(?:-d|--data|--form)/i.test(command)) return "third_party_communication";
  return null;
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function currentNonce() {
  try { return readFileSync(noncePath, "utf8").trim(); } catch { return (process.env.BOX_APPROVAL_NONCE || "").trim(); }
}
function approved(actionHash, nonce) {
  try {
    const grant = JSON.parse(readFileSync(grantPath, "utf8"));
    if (grant.actionHash !== actionHash || grant.nonce !== nonce || Number(grant.expiresAt) < Date.now()) return false;
    unlinkSync(grantPath);
    try { unlinkSync(pendingPath); } catch {}
    consumedApprovals.add(nonce + ":" + actionHash);
    return true;
  } catch { return false; }
}

export default function (pi) {
  pi.on("before_agent_start", event => ({
    systemPrompt: event.systemPrompt + "\n\nSandbox policy: local shell, files, packages, code, browsers, and artifact creation are allowed. Permanent external-integration credentials are never provided. Read-only public network access is allowed. Do not deploy, spend money, push, destructively mutate external systems, or communicate with third parties unless the exact action has been approved through the Telegram approval gate. Where an action broker is available, request the external write through it instead of attempting the write yourself; no other path has credentials and none will succeed. Never evade a blocked tool call.",
  }));
  pi.on("tool_call", event => {
    if (event.toolName !== "bash") return;
    const action = String(event.input?.command || "").trim();
    const category = classify(action);
    if (!category) return;
    const nonce = currentNonce();
    const actionHash = sha256(action);
    if (consumedApprovals.has(nonce + ":" + actionHash)) {
      return { block: true, reason: "BOX_APPROVED_ACTION_ALREADY_EXECUTED" };
    }
    if (nonce && approved(actionHash, nonce)) return;
    const pending = { nonce, category, action: action.slice(0, 4000), actionHash, requestedAt: Date.now() };
    writeFileSync(pendingPath, JSON.stringify(pending), { mode: 0o600 });
    const marker = "BOX_APPROVAL_REQUIRED:" + Buffer.from(JSON.stringify(pending)).toString("base64url");
    return { block: true, terminate: true, reason: marker };
  });
}
`;
