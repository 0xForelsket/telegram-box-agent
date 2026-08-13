import { describe, expect, it } from 'vitest';
import { classifyProtectedShellAction, parseApprovalMarker, PI_EXECUTION_POLICY_EXTENSION_SOURCE } from './execution_policy';

describe('Box protected-action policy', () => {
  it('allows sandbox-local work without approval', () => {
    expect(classifyProtectedShellAction('python report.py && tectonic report.tex')).toBeNull();
    expect(classifyProtectedShellAction('npm install && npm test')).toBeNull();
    expect(classifyProtectedShellAction('rm -rf /workspace/home/tmp-output')).toBeNull();
  });

  it('classifies protected external actions', () => {
    expect(classifyProtectedShellAction('wrangler deploy')).toBe('deployment');
    expect(classifyProtectedShellAction('git push origin main')).toBe('protected_push');
    expect(classifyProtectedShellAction('stripe charge create --amount 100')).toBe('spending');
    expect(classifyProtectedShellAction('curl -X DELETE https://api.example.com/resource/1')).toBe('external_destructive');
    expect(classifyProtectedShellAction('gh pr comment 10 --body hello')).toBe('third_party_communication');
  });

  it('round-trips a bound approval marker and rejects malformed values', () => {
    const pending = {
      nonce: 'approval_nonce_123456789', category: 'deployment', action: 'wrangler deploy',
      actionHash: 'a'.repeat(64), requestedAt: 1234,
    };
    const marker = `failure BOX_APPROVAL_REQUIRED:${base64Url(JSON.stringify(pending))}`;
    expect(parseApprovalMarker(marker)).toEqual(pending);
    expect(parseApprovalMarker('BOX_APPROVAL_REQUIRED:not-valid')).toBeNull();
    expect(PI_EXECUTION_POLICY_EXTENSION_SOURCE).toContain('tool_call');
    expect(PI_EXECUTION_POLICY_EXTENSION_SOURCE).toContain('actionHash');
    expect(PI_EXECUTION_POLICY_EXTENSION_SOURCE).toContain('BOX_APPROVED_ACTION_ALREADY_EXECUTED');
    expect(PI_EXECUTION_POLICY_EXTENSION_SOURCE).toContain('Permanent external-integration credentials are never provided.');
    expect(PI_EXECUTION_POLICY_EXTENSION_SOURCE).not.toContain('BOX_EXTERNAL_WRITE_ALLOWLIST');
  });
});

function base64Url(value: string): string {
  const binary = [...new TextEncoder().encode(value)].map(byte => String.fromCharCode(byte)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
