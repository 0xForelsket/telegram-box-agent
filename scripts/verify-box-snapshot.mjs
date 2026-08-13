import { Box } from '@upstash/box';

const apiKey = requireEnv('UPSTASH_BOX_API_KEY');
const snapshotId = requireEnv('BOX_SNAPSHOT_ID');
const baseUrl = process.env.UPSTASH_BOX_BASE_URL?.trim() || undefined;
const connection = { apiKey, baseUrl };

const box = await withRetries('restore snapshot', () => Box.fromSnapshot(snapshotId, {
  ...connection,
  name: `snapshot-verifier-${Date.now()}`,
  labels: ['telegram-agent', 'snapshot-verify'],
}));

try {
  const result = await withRetries('run restored snapshot checks', () => box.exec.command([
    'set -eu',
    'cd /workspace/home',
    'test -x .venv/bin/python',
    'test -d node_modules',
    'node --input-type=module -e \'await import("@earendil-works/pi-coding-agent"); await import("@earendil-works/pi-ai/compat"); await import("playwright"); await import("pdfkit"); await import("exceljs"); await import("docx"); await import("pptxgenjs"); await import("sharp")\'',
    '.venv/bin/python -c \'import reportlab,pdfplumber,pypdf,pymupdf,PIL,weasyprint,cairosvg,docx,openpyxl,pptx,pandas,polars,pyarrow,duckdb\'',
    'tectonic --version',
    'pandoc --version | head -n 1',
    'qpdf --version',
    'pdftotext -v 2>&1 | head -n 1',
    'libreoffice --headless --version',
    'convert -version | head -n 1',
    'ffprobe -version | head -n 1',
    'dot -V',
    'git --version',
    'go version',
    'rustc --version',
    'javac -version',
    'sqlite3 --version',
    'psql --version',
    'redis-cli --version',
    'PLAYWRIGHT_BROWSERS_PATH=/workspace/home/.playwright node -e \'const { chromium } = require("playwright"); (async()=>{const browser=await chromium.launch({headless:true}); console.log("chromium " + await browser.version()); await browser.close()})()\'',
  ].join(' && ')));

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.exitCode !== 0) throw new Error(`Restored snapshot verification failed with exit code ${result.exitCode}.`);
  console.log(JSON.stringify({ snapshotId, restoredBoxId: box.id, verified: true }, null, 2));
} finally {
  await withRetries('delete snapshot verifier', () => box.delete()).catch(error => {
    console.error(`Snapshot verifier cleanup failed for ${box.id}:`, error);
  });
}

async function withRetries(label, operation, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isTransient(error)) throw error;
      const delayMs = 1500 * attempt;
      console.error(`${label}: transient Upstash error on attempt ${attempt}; retrying in ${delayMs} ms.`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

function isTransient(error) {
  const message = error instanceof Error ? error.message : String(error);
  const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined;
  return statusCode === undefined || statusCode === 408 || statusCode === 429 || (typeof statusCode === 'number' && statusCode >= 500) || /fetch failed|timeout|network/i.test(message);
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
