import { describe, expect, it } from 'vitest';
import {
  BoxRuntimeConfigurationError,
  PI_DEEPSEEK_MODEL,
  PI_GLM_MODEL,
  PI_HARNESS_SOURCE,
  calculateWorstCaseDeepSeekSpend,
  resolvePiModelRoute,
  validateDeepSeekCostBound,
} from './pi_runtime';

const currentRateCard = { inputUsdPerMTokens: 0.14, cachedInputUsdPerMTokens: 0.0028, outputUsdPerMTokens: 0.28 };

function expectBoxError(
  action: () => unknown,
  code: BoxRuntimeConfigurationError['code'],
): void {
  try {
    action();
    throw new Error('Expected BoxRuntimeConfigurationError.');
  } catch (error) {
    expect(error).toBeInstanceOf(BoxRuntimeConfigurationError);
    expect((error as BoxRuntimeConfigurationError).code).toBe(code);
  }
}

describe('Pi Box model routing', () => {
  it('defaults every caller to DeepSeek and exposes only its provider key', () => {
    const route = resolvePiModelRoute({
      actorUserId: 'member-1',
      ownerUserId: 'owner-1',
      deepseekApiKey: 'deepseek-secret',
      zaiCodingPlanApiKey: 'owner-plan-secret',
      deepseekRateCard: currentRateCard,
    });

    expect(route.route).toBe('deepseek');
    expect(route.model).toBe(PI_DEEPSEEK_MODEL);
    expect(route.providerEnv).toEqual({ DEEPSEEK_API_KEY: 'host-injected' });
    expect(route.providerAttachHeaders).toEqual({
      'api.deepseek.com': { Authorization: 'Bearer deepseek-secret' },
    });
    expect(route.providerEnv).not.toHaveProperty('ZAI_API_KEY');
    expect(route.worstCaseSpendUsd).toBeCloseTo(0.64512, 8);
  });

  it('rejects GLM Coding Plan use by a non-owner', () => {
    expectBoxError(() => resolvePiModelRoute({
      requestedRoute: 'glm',
      actorUserId: 'member-1',
      ownerUserId: 'owner-1',
      deepseekApiKey: 'deepseek-secret',
      zaiCodingPlanApiKey: 'owner-plan-secret',
      deepseekRateCard: currentRateCard,
    }), 'BOX_MODEL_FORBIDDEN');
  });

  it('maps the owner Coding Plan secret to Pi without exposing DeepSeek', () => {
    const route = resolvePiModelRoute({
      requestedRoute: 'glm',
      actorUserId: 'owner-1',
      ownerUserId: 'owner-1',
      deepseekApiKey: 'deepseek-secret',
      zaiCodingPlanApiKey: 'owner-plan-secret',
      deepseekRateCard: currentRateCard,
    });

    expect(route.model).toBe(PI_GLM_MODEL);
    expect(route.providerEnv).toEqual({ ZAI_API_KEY: 'host-injected' });
    expect(route.providerAttachHeaders).toEqual({
      'api.z.ai': { Authorization: 'Bearer owner-plan-secret' },
    });
    expect(route.providerEnv).not.toHaveProperty('DEEPSEEK_API_KEY');
  });

  it('does not silently fall back when the explicitly selected provider has no key', () => {
    expectBoxError(() => resolvePiModelRoute({
      requestedRoute: 'glm',
      actorUserId: 'owner-1',
      ownerUserId: 'owner-1',
      deepseekApiKey: 'deepseek-secret',
      deepseekRateCard: currentRateCard,
    }), 'BOX_MODEL_KEY_MISSING');
  });
});

describe('DeepSeek Box cost gate', () => {
  it('calculates the documented cache-miss worst case', () => {
    expect(calculateWorstCaseDeepSeekSpend(currentRateCard)).toBeCloseTo(0.64512, 8);
    expect(validateDeepSeekCostBound(currentRateCard)).toBeCloseTo(0.64512, 8);
  });

  it('fails closed if configured rates make the one-dollar bound unsafe', () => {
    expectBoxError(() => validateDeepSeekCostBound({
      inputUsdPerMTokens: 1,
      outputUsdPerMTokens: 1,
    }), 'BOX_COST_BOUND_UNSAFE');
  });

  it('fails closed on a missing or zero price', () => {
    expectBoxError(() => validateDeepSeekCostBound({
      inputUsdPerMTokens: 0,
      outputUsdPerMTokens: 0.28,
    }), 'BOX_COST_BOUND_UNSAFE');
  });
});

describe('Pi custom harness', () => {
  it('pins one model route and applies context, output, response, and spend guards', () => {
    expect(PI_HARNESS_SOURCE).toContain('@earendil-works/pi-ai/compat');
    expect(PI_HARNESS_SOURCE).toContain('PI_ALLOWED_MODEL');
    expect(PI_HARNESS_SOURCE).toContain('PI_MAX_MODEL_RESPONSES');
    expect(PI_HARNESS_SOURCE).toContain('PI_MAX_CONTEXT_TOKENS');
    expect(PI_HARNESS_SOURCE).toContain('PI_MAX_OUTPUT_TOKENS');
    expect(PI_HARNESS_SOURCE).toContain('PI_MAX_MODEL_SPEND_USD');
    expect(PI_HARNESS_SOURCE).toContain('providerRequestCount > maxModelResponses');
    expect(PI_HARNESS_SOURCE).toContain('worst-case cost could exceed');
    expect(PI_HARNESS_SOURCE).toContain('estimatedInput > maxContextTokens');
    expect(PI_HARNESS_SOURCE).toContain('requestedOutput > maxOutputTokens');
    expect(PI_HARNESS_SOURCE).toContain('DefaultResourceLoader');
    expect(PI_HARNESS_SOURCE).toContain('thinkingLevel: "high"');
    expect(PI_HARNESS_SOURCE).toContain('event: " + event');
  });

  it('contains no provider credential value', () => {
    expect(PI_HARNESS_SOURCE).not.toContain('deepseek-secret');
    expect(PI_HARNESS_SOURCE).not.toContain('owner-plan-secret');
  });
});
