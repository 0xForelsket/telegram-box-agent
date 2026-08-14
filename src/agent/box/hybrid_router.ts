/**
 * Deterministic pre-routing between the ordinary chat path and a Box job.
 *
 * The rules are heuristics over free text, so they will misfire in both
 * directions. Two things make that survivable: a misroute falls back to chat
 * rather than erroring, and every decision reports which rule fired so the
 * user can see why and override it with `/quick`.
 */

export type BoxRouteRule =
  | 'file_generation'
  | 'complex_reading'
  | 'code_or_shell'
  | 'multi_step_operation';

export interface BoxRouteDecision {
  route: boolean;
  rule?: BoxRouteRule;
  /** Short human-readable reason, shown when a request is routed to Box. */
  reason?: string;
}

const MIN_ROUTABLE_LENGTH = 8;
/** Below this, a bare execution verb like "test" or "run" is treated as chat. */
const LONG_REQUEST_LENGTH = 120;

const FILE_GENERATION = /\b(?:create|generate|build|make|compile|render|export|produce)\b[\s\S]{0,80}\b(?:pdf|docx?|xlsx?|spreadsheet|csv|pptx?|presentation|archive|zip|image|chart|report|markdown|\.md|latex|tex)\b/i;
const CODE_OR_SHELL = /\b(?:run|execute|install|compile|test|debug|refactor|clone|checkout|script|shell|terminal|playwright|chromium|browser automation)\b/i;
const MULTI_STEP = /\b(?:first|then|after that|next|finally|step[- ]by[- ]step|multiple steps|end[- ]to[- ]end)\b/i;
const COMPLEX_READING = /(?:\.pdf(?:\?|#|$)|\bpdf\b)[\s\S]{0,120}\b(?:extract|compare|analy[sz]e|table|ocr|render|javascript|browser)\b|\b(?:javascript-rendered|dynamic website|browser interaction)\b/i;
const OPERATIONAL = /\b(?:research|analy[sz]e|download|process|transform|compare|publish)\b/i;

const REASONS: Record<BoxRouteRule, string> = {
  file_generation: 'it asks for a generated file',
  complex_reading: 'it needs PDF or browser-level reading',
  code_or_shell: 'it asks to run or build something',
  multi_step_operation: 'it describes a multi-step operation',
};

export function classifyBoxRoute(request: string): BoxRouteDecision {
  const value = request.trim();
  if (value.length < MIN_ROUTABLE_LENGTH) return { route: false };

  const rule = matchRule(value);
  return rule ? { route: true, rule, reason: REASONS[rule] } : { route: false };
}

function matchRule(value: string): BoxRouteRule | null {
  if (FILE_GENERATION.test(value)) return 'file_generation';
  if (COMPLEX_READING.test(value)) return 'complex_reading';
  if (CODE_OR_SHELL.test(value) && (MULTI_STEP.test(value) || value.length >= LONG_REQUEST_LENGTH)) {
    return 'code_or_shell';
  }
  if (MULTI_STEP.test(value) && OPERATIONAL.test(value)) return 'multi_step_operation';
  return null;
}

export function shouldRouteToBox(request: string): boolean {
  return classifyBoxRoute(request).route;
}

export function isGlmCodingTask(request: string): boolean {
  return /\b(?:code|coding|repository|repo|typescript|javascript|python|rust|golang|java|compile|test|debug|refactor|implementation|pull request|git)\b/i.test(request);
}
