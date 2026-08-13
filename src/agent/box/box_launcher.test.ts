import { describe, expect, it } from 'vitest';
import { ARTIFACT_PUBLISHER_SOURCE, BOX_NETWORK_POLICY } from './box_launcher';

describe('Box artifact publisher helper', () => {
  it('publishes one filesystem file through job-scoped Worker authorization', () => {
    expect(ARTIFACT_PUBLISHER_SOURCE).toContain('createReadStream(filePath)');
    expect(ARTIFACT_PUBLISHER_SOURCE).toContain('BOX_ARTIFACT_AUTHORIZE_URL');
    expect(ARTIFACT_PUBLISHER_SOURCE).toContain('BOX_ARTIFACT_SESSION_TOKEN');
    expect(ARTIFACT_PUBLISHER_SOURCE).toContain('X-Box-Job-Id');
    expect(ARTIFACT_PUBLISHER_SOURCE).toContain('duplex: "half"');
  });

  it('contains no R2 account credential or bucket API operation', () => {
    expect(ARTIFACT_PUBLISHER_SOURCE).not.toContain('CLOUDFLARE_API_TOKEN');
    expect(ARTIFACT_PUBLISHER_SOURCE).not.toContain('R2_ACCESS_KEY');
    expect(ARTIFACT_PUBLISHER_SOURCE).not.toContain('S3Client');
  });

  it('uses custom mode so Upstash blocks private network ranges', () => {
    expect(BOX_NETWORK_POLICY).toMatchObject({ mode: 'custom' });
    if (BOX_NETWORK_POLICY.mode !== 'custom') throw new Error('Expected a custom network policy.');
    expect(BOX_NETWORK_POLICY.allowedDomains).toEqual(expect.arrayContaining([
      'api.deepseek.com', 'api.z.ai', '*.com', '*.org', '*.dev', '*.gov',
    ]));
  });
});
