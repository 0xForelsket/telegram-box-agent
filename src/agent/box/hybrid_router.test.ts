import { describe, expect, it } from 'vitest';
import { isGlmCodingTask, shouldRouteToBox } from './hybrid_router';

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
