const FILE_GENERATION = /\b(?:create|generate|build|make|compile|render|export|produce)\b[\s\S]{0,80}\b(?:pdf|docx?|xlsx?|spreadsheet|csv|pptx?|presentation|archive|zip|image|chart|report|markdown|\.md|latex|tex)\b/i;
const CODE_OR_SHELL = /\b(?:run|execute|install|compile|test|debug|refactor|clone|checkout|script|shell|terminal|playwright|chromium|browser automation)\b/i;
const MULTI_STEP = /\b(?:first|then|after that|next|finally|step[- ]by[- ]step|multiple steps|end[- ]to[- ]end)\b/i;
const COMPLEX_READING = /(?:\.pdf(?:\?|#|$)|\bpdf\b)[\s\S]{0,120}\b(?:extract|compare|analy[sz]e|table|ocr|render|javascript|browser)\b|\b(?:javascript-rendered|dynamic website|browser interaction)\b/i;

export function shouldRouteToBox(request: string): boolean {
  const value = request.trim();
  if (value.length < 8) return false;
  return FILE_GENERATION.test(value)
    || COMPLEX_READING.test(value)
    || (CODE_OR_SHELL.test(value) && (MULTI_STEP.test(value) || value.length >= 120))
    || (MULTI_STEP.test(value) && /\b(?:research|analy[sz]e|download|process|transform|compare|publish)\b/i.test(value));
}

export function isGlmCodingTask(request: string): boolean {
  return /\b(?:code|coding|repository|repo|typescript|javascript|python|rust|golang|java|compile|test|debug|refactor|implementation|pull request|git)\b/i.test(request);
}
