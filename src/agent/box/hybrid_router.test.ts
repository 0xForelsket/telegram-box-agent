import { describe, expect, it } from 'vitest';
import { classifyBoxRoute, isGlmCodingTask, shouldRouteToBox } from './hybrid_router';

describe('Box hybrid router', () => {
  it('routes file generation, multi-step execution, and complex PDF/browser reading', () => {
    expect(shouldRouteToBox('Generate a PDF investment report with charts and a downloadable spreadsheet.')).toBe(true);
    expect(shouldRouteToBox('First clone the repo, then run its tests, fix the failures, and finally compile it.')).toBe(true);
    expect(shouldRouteToBox('Analyze https://example.com/report.pdf, extract its tables, and compare the results.')).toBe(true);
    expect(shouldRouteToBox('Open this JavaScript-rendered site and interact with the browser controls.')).toBe(true);
  });

  it('leaves ordinary conversation on the Worker chatbot', () => {
    expect(shouldRouteToBox('hello there')).toBe(false);
    expect(shouldRouteToBox('What is compound interest?')).toBe(false);
    expect(shouldRouteToBox('Tell me a joke about markets.')).toBe(false);
  });

  it('recognizes coding work for the owner-only GLM route', () => {
    expect(isGlmCodingTask('Refactor this TypeScript repository and run the tests.')).toBe(true);
    expect(isGlmCodingTask('Prepare a general travel itinerary.')).toBe(false);
  });
});

describe('Box route explainability', () => {
  // The rules are loose enough to misfire, so a routed request has to be able
  // to say which rule fired and how to override it.
  it('names the rule that sent a request to Box', () => {
    expect(classifyBoxRoute('Generate a PDF report with charts.')).toMatchObject({
      route: true,
      rule: 'file_generation',
    });
    expect(classifyBoxRoute('Analyze https://example.com/report.pdf and extract its tables.')).toMatchObject({
      route: true,
      rule: 'complex_reading',
    });
    expect(classifyBoxRoute('First clone the repo, then run its tests and finally compile it.')).toMatchObject({
      route: true,
      rule: 'code_or_shell',
    });
    expect(classifyBoxRoute('First research the market, then compare the vendors, and finally publish it.')).toMatchObject({
      route: true,
      rule: 'multi_step_operation',
    });
  });

  it('carries a reason the user can act on', () => {
    const decision = classifyBoxRoute('Generate a PDF report with charts.');

    expect(decision.reason).toBeTruthy();
    expect(decision.reason).not.toMatch(/[A-Z_]{4,}/);
  });

  it('reports no rule for ordinary conversation', () => {
    expect(classifyBoxRoute('What is compound interest?')).toEqual({ route: false });
    expect(classifyBoxRoute('hi')).toEqual({ route: false });
  });

  it('still routes a long request containing a bare execution verb', () => {
    // Documented behaviour rather than endorsed behaviour: this is exactly the
    // false positive the chat fallback exists to absorb.
    const chatty = 'I was reading about how people test their assumptions when markets move, '
      + 'and I wondered what you think about that whole idea in general terms.';

    expect(chatty.length).toBeGreaterThanOrEqual(120);
    expect(classifyBoxRoute(chatty)).toMatchObject({ route: true, rule: 'code_or_shell' });
  });
});
