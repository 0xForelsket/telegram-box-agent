const OPERATORS: Record<string, { precedence: number; associativity: 'left' | 'right'; apply: (a: number, b: number) => number }> = {
  '+': { precedence: 1, associativity: 'left', apply: (a, b) => a + b },
  '-': { precedence: 1, associativity: 'left', apply: (a, b) => a - b },
  '*': { precedence: 2, associativity: 'left', apply: (a, b) => a * b },
  '/': { precedence: 2, associativity: 'left', apply: (a, b) => a / b },
  '%': { precedence: 2, associativity: 'left', apply: (a, b) => a % b },
  '^': { precedence: 3, associativity: 'right', apply: (a, b) => a ** b },
};

export function calculateExpression(expression: string): number {
  const normalized = expression.replace(/\s+/g, '').replace(/−/g, '-');
  if (!normalized || normalized.length > 200 || /[^0-9.+\-*/%^()]/.test(normalized)) {
    throw new Error('Expression contains unsupported characters');
  }
  const tokens = normalized.match(/(?:\d+(?:\.\d*)?|\.\d+)|[()+\-*/%^]/g) || [];
  if (tokens.join('') !== normalized) throw new Error('Invalid expression');
  const output: string[] = [];
  const operators: string[] = [];
  let previous: string | null = null;
  for (let index = 0; index < tokens.length; index++) {
    let token = tokens[index];
    if (/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) {
      output.push(token);
    } else if (token === '(') {
      operators.push(token);
    } else if (token === ')') {
      while (operators.length > 0 && operators.at(-1) !== '(') output.push(operators.pop()!);
      if (operators.pop() !== '(') throw new Error('Mismatched parentheses');
    } else {
      if ((token === '-' || token === '+') && (previous === null || previous === '(' || previous in OPERATORS)) {
        output.push('0');
      }
      const current = OPERATORS[token];
      while (operators.length > 0 && operators.at(-1)! in OPERATORS) {
        const top = OPERATORS[operators.at(-1)!];
        const shouldPop = current.associativity === 'left'
          ? current.precedence <= top.precedence
          : current.precedence < top.precedence;
        if (!shouldPop) break;
        output.push(operators.pop()!);
      }
      operators.push(token);
    }
    previous = token;
  }
  while (operators.length > 0) {
    const operator = operators.pop()!;
    if (operator === '(') throw new Error('Mismatched parentheses');
    output.push(operator);
  }
  const stack: number[] = [];
  for (const token of output) {
    if (!(token in OPERATORS)) {
      stack.push(Number(token));
      continue;
    }
    const b = stack.pop();
    const a = stack.pop();
    if (a === undefined || b === undefined) throw new Error('Invalid expression');
    const result = OPERATORS[token].apply(a, b);
    if (!Number.isFinite(result)) throw new Error('Result is not finite');
    stack.push(result);
  }
  if (stack.length !== 1) throw new Error('Invalid expression');
  return stack[0];
}

interface UnitDefinition {
  dimension: string;
  toBase: (value: number) => number;
  fromBase: (value: number) => number;
}

const linear = (dimension: string, factor: number): UnitDefinition => ({
  dimension,
  toBase: value => value * factor,
  fromBase: value => value / factor,
});

const UNITS: Record<string, UnitDefinition> = {
  m: linear('length', 1), meter: linear('length', 1), meters: linear('length', 1),
  km: linear('length', 1000), kilometer: linear('length', 1000), kilometers: linear('length', 1000),
  cm: linear('length', 0.01), mm: linear('length', 0.001),
  in: linear('length', 0.0254), inch: linear('length', 0.0254), inches: linear('length', 0.0254),
  ft: linear('length', 0.3048), foot: linear('length', 0.3048), feet: linear('length', 0.3048),
  yd: linear('length', 0.9144), yard: linear('length', 0.9144), yards: linear('length', 0.9144),
  mi: linear('length', 1609.344), mile: linear('length', 1609.344), miles: linear('length', 1609.344),
  g: linear('mass', 1), gram: linear('mass', 1), grams: linear('mass', 1),
  kg: linear('mass', 1000), kilogram: linear('mass', 1000), kilograms: linear('mass', 1000),
  lb: linear('mass', 453.59237), lbs: linear('mass', 453.59237), pound: linear('mass', 453.59237), pounds: linear('mass', 453.59237),
  oz: linear('mass', 28.349523125),
  b: linear('data', 1), byte: linear('data', 1), bytes: linear('data', 1),
  kb: linear('data', 1000), mb: linear('data', 1_000_000), gb: linear('data', 1_000_000_000),
  kib: linear('data', 1024), mib: linear('data', 1024 ** 2), gib: linear('data', 1024 ** 3),
  c: { dimension: 'temperature', toBase: value => value, fromBase: value => value },
  f: { dimension: 'temperature', toBase: value => (value - 32) * 5 / 9, fromBase: value => value * 9 / 5 + 32 },
  k: { dimension: 'temperature', toBase: value => value - 273.15, fromBase: value => value + 273.15 },
};

export function convertUnits(input: string): { value: number; from: string; to: string } {
  const match = input.trim().match(/^(-?\d+(?:\.\d+)?)\s*([a-z]+)\s+(?:to|in)\s+([a-z]+)$/i);
  if (!match) throw new Error('Use: <number> <unit> to <unit>');
  const value = Number(match[1]);
  const fromName = match[2].toLowerCase();
  const toName = match[3].toLowerCase();
  const from = UNITS[fromName];
  const to = UNITS[toName];
  if (!from || !to) throw new Error('Unsupported unit');
  if (from.dimension !== to.dimension) throw new Error('Units are not compatible');
  const result = to.fromBase(from.toBase(value));
  if (!Number.isFinite(result)) throw new Error('Conversion failed');
  return { value: result, from: fromName, to: toName };
}

export function formatNumber(value: number): string {
  return Number.isInteger(value) ? value.toString() : Number(value.toPrecision(12)).toString();
}

export function formatTimeInZone(timeZone: string, date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      dateStyle: 'full',
      timeStyle: 'long',
    }).format(date);
  } catch {
    throw new Error('Unknown IANA timezone, for example Asia/Kuala_Lumpur or Europe/London');
  }
}

export function calculateDate(input: string): string {
  const trimmed = input.trim();
  const difference = trimmed.match(/^(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})$/i);
  if (difference) {
    const start = parseUTCDate(difference[1]);
    const end = parseUTCDate(difference[2]);
    return `${Math.round((end.getTime() - start.getTime()) / 86_400_000)} days`;
  }
  const arithmetic = trimmed.match(/^(\d{4}-\d{2}-\d{2})\s*([+-])\s*(\d+)\s*(days?|weeks?|months?)$/i);
  if (!arithmetic) throw new Error('Use: YYYY-MM-DD + 5 days, or YYYY-MM-DD to YYYY-MM-DD');
  const date = parseUTCDate(arithmetic[1]);
  const amount = Number(arithmetic[3]) * (arithmetic[2] === '-' ? -1 : 1);
  const unit = arithmetic[4].toLowerCase();
  if (unit.startsWith('day')) date.setUTCDate(date.getUTCDate() + amount);
  else if (unit.startsWith('week')) date.setUTCDate(date.getUTCDate() + amount * 7);
  else date.setUTCMonth(date.getUTCMonth() + amount);
  return date.toISOString().slice(0, 10);
}

function parseUTCDate(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('Invalid calendar date');
  return date;
}
