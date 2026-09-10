import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, '..');
const sourcePath = resolve(rootDir, 'SOUL.md');
const outputPath = resolve(rootDir, 'src', 'generated', 'soul.ts');

// HTML comments hold maintainer notes. They are stripped so the prompt only
// ever contains text written for the model.
const soulMarkdown = readFileSync(sourcePath, 'utf8')
  .replace(/<!--[\s\S]*?-->\r?\n?/g, '')
  .replace(/\r\n/g, '\n')
  .trim();

const generated = `// Generated from SOUL.md by scripts/generate-soul.mjs. Do not edit manually.\nexport const soulMessage = ${JSON.stringify(soulMarkdown)};\n`;

writeFileSync(outputPath, generated, 'utf8');
