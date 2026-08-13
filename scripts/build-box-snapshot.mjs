import { Box } from '@upstash/box';

const apiKey = requireEnv('UPSTASH_BOX_API_KEY');
const baseUrl = process.env.UPSTASH_BOX_BASE_URL?.trim() || undefined;
const resumeBoxId = process.env.BOX_SNAPSHOT_RESUME_BOX_ID?.trim() || undefined;
const snapshotName = process.argv[2]?.trim() || `telegram-agent-runtime-v1-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`;

const aptPackages = [
  // Shell, source control, archives, networking, and inspection.
  'bash', 'ca-certificates', 'curl', 'wget', 'git', 'git-lfs', 'openssh-client', 'rsync',
  'jq', 'file', 'tree', 'ripgrep', 'fd-find', 'less', 'zip', 'unzip', 'p7zip-full',
  'tar', 'xz-utils', 'zstd', 'shellcheck', 'dnsutils', 'iputils-ping', 'netcat-openbsd',
  // Native and polyglot build/runtime support.
  'build-essential', 'pkg-config', 'cmake', 'ninja-build', 'python3', 'python3-venv',
  'python3-dev', 'golang-go', 'rustc', 'cargo', 'default-jdk-headless',
  // Local data/query clients without bundled database servers.
  'sqlite3', 'postgresql-client', 'redis-tools',
  // Documents, PDF validation/conversion, OCR, fonts, and diagrams.
  'pandoc', 'poppler-utils', 'qpdf', 'ghostscript', 'libreoffice-writer',
  'libreoffice-calc', 'libreoffice-impress', 'antiword', 'catdoc', 'tesseract-ocr',
  'tesseract-ocr-eng', 'graphviz', 'fonts-dejavu-core', 'fonts-liberation2',
  'fonts-noto-core', 'fonts-noto-cjk', 'fonts-noto-color-emoji', 'fonts-texgyre',
  // Images, SVG, metadata, and media inspection/transcoding.
  'imagemagick', 'librsvg2-bin', 'optipng', 'pngquant', 'jpegoptim', 'webp',
  'libimage-exiftool-perl', 'ffmpeg',
  // Native libraries used by Python HTML/SVG/PDF tooling.
  'libcairo2', 'libpango-1.0-0', 'libpangoft2-1.0-0', 'libffi-dev',
].join(' ');

const pythonRequirements = `
reportlab==5.0.0
pypdf==6.15.0
pdfplumber==0.11.10
pymupdf==1.28.2
pillow==12.3.0
weasyprint==69.0
cairosvg==2.9.0
python-docx==1.2.0
openpyxl==3.1.5
xlsxwriter==3.2.9
odfpy==1.4.1
python-pptx==1.0.2
pandas==3.0.5
polars==1.43.2
pyarrow==25.0.1
duckdb==1.5.5
matplotlib==3.11.1
seaborn==0.13.2
plotly==6.9.0
nbformat==5.11.0
nbconvert==7.17.1
jupyter-client==8.9.1
beautifulsoup4==4.15.0
lxml==6.1.1
httpx==0.28.1
jsonschema==4.26.0
`.trim();

const piPackages = [
  '@earendil-works/pi-coding-agent@0.84.1',
  '@earendil-works/pi-ai@0.84.1',
].join(' ');

const nodePackages = [
  'pnpm@11.21.0', 'typescript@7.0.2', 'tsx@4.23.12', 'esbuild@0.28.2',
  'playwright@1.62.1', 'pdfkit@0.19.1', 'exceljs@4.4.0', 'docx@9.7.1',
  'pptxgenjs@4.0.1', 'sharp@0.35.3', 'markdown-it@15.0.0',
  'prettier@3.9.6', 'eslint@10.8.1',
].join(' ');

const connection = { apiKey, baseUrl };
const box = resumeBoxId
  ? await withRetries('load snapshot builder', () => Box.get(resumeBoxId, connection))
  : await withRetries('create snapshot builder', () => Box.create({
      ...connection,
      name: `snapshot-builder-${Date.now()}`,
      labels: ['telegram-agent', 'snapshot-builder', 'pi'],
      runtime: 'node',
      size: 'small',
      browser: true,
    }));
let snapshotCreated = false;

try {
  if (resumeBoxId) {
    await withRetries('resume snapshot builder', () => box.resume());
    console.log(`Resuming prepared snapshot builder ${box.id}; bootstrap package stages are skipped.`);
  } else {
    await run('identity and capacity', 'id && uname -a && df -h /workspace/home && node --version && python3 --version && sudo -n true && echo SUDO_OK');
    await run('Debian packages', `export DEBIAN_FRONTEND=noninteractive; sudo apt-get update && sudo apt-get install -y --no-install-recommends ${aptPackages}`);

    await withRetries('write Python requirements', () => box.files.write({ path: '/workspace/home/snapshot-python-requirements.txt', content: pythonRequirements }));
    await run('Python document/data environment', [
      'python3 -m venv /workspace/home/.venv',
      '/workspace/home/.venv/bin/python -m pip install --upgrade pip setuptools wheel',
      '/workspace/home/.venv/bin/pip install --no-cache-dir -r /workspace/home/snapshot-python-requirements.txt',
    ].join(' && '));
  }

  await run('Pinned Pi tooling', `cd /workspace/home && npm install --no-save --silent --ignore-scripts ${piPackages}`);
  await run('Pinned Node tooling', `cd /workspace/home && npm install --no-save --silent ${nodePackages}`);
  await run('Pinned Chromium for shell-level Playwright', 'cd /workspace/home && PLAYWRIGHT_BROWSERS_PATH=/workspace/home/.playwright npx playwright install --with-deps chromium');

  await run('Tectonic 0.17.0', [
    'cd /tmp',
    'case "$(uname -m)" in aarch64|arm64) TECTONIC_TARGET=aarch64-unknown-linux-musl ;; x86_64|amd64) TECTONIC_TARGET=x86_64-unknown-linux-gnu ;; *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;; esac',
    'curl -fsSLo tectonic.tar.gz "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.17.0/tectonic-0.17.0-${TECTONIC_TARGET}.tar.gz"',
    'tar -xzf tectonic.tar.gz',
    'sudo install -m 0755 tectonic /usr/local/bin/tectonic',
    'rm -f tectonic tectonic.tar.gz',
  ].join(' && '));

  await withRetries('write LaTeX smoke source', () => box.files.write({
    path: '/workspace/home/snapshot-smoke.tex',
    content: String.raw`\documentclass{article}
\usepackage{hyperref}
\title{Box Snapshot Smoke Test}
\author{Telegram Box Agent}
\begin{document}
\maketitle
LaTeX, Markdown, PDF, tables, Unicode, and artifacts are ready.
\end{document}
`,
  }));
  await withRetries('write Markdown smoke source', () => box.files.write({
    path: '/workspace/home/snapshot-smoke.md',
    content: '# Box Snapshot Smoke Test\n\nMarkdown to PDF through Pandoc and Tectonic.\n',
  }));
  await run('Document compiler smoke tests', [
    'cd /workspace/home',
    'tectonic snapshot-smoke.tex',
    'pandoc snapshot-smoke.md --pdf-engine=tectonic -o snapshot-markdown.pdf',
    'qpdf --check snapshot-smoke.pdf',
    'qpdf --check snapshot-markdown.pdf',
    'pdftotext snapshot-smoke.pdf - | grep -q "Box Snapshot Smoke Test"',
    '/workspace/home/.venv/bin/python -c "import reportlab,pdfplumber,pypdf,docx,openpyxl,pptx,pandas,polars,pyarrow,duckdb"',
    'libreoffice --headless --version',
    'magick -version || convert -version',
    'ffprobe -version | head -n 1',
    'dot -V',
    'git --version && go version && rustc --version && javac -version',
    "PLAYWRIGHT_BROWSERS_PATH=/workspace/home/.playwright node -e 'const { chromium } = require(\"playwright\"); (async()=>{const b=await chromium.launch({headless:true}); console.log(await b.version()); await b.close()})()'",
  ].join(' && '));

  await run('Snapshot cleanup and inventory', [
    'rm -f /workspace/home/snapshot-smoke.tex /workspace/home/snapshot-smoke.aux /workspace/home/snapshot-smoke.log /workspace/home/snapshot-smoke.pdf /workspace/home/snapshot-markdown.pdf',
    'sudo rm -rf /root/.cache/pip /workspace/home/.cache/pip',
    'sudo apt-get clean',
    'sudo rm -rf /var/lib/apt/lists/*',
    'df -h /workspace/home',
  ].join(' && '));

  const snapshot = await withRetries('create snapshot', () => box.snapshot({ name: snapshotName }));
  snapshotCreated = true;
  console.log(JSON.stringify({
    snapshotId: snapshot.id,
    snapshotName: snapshot.name,
    sourceBoxId: box.id,
    status: snapshot.status,
    sizeBytes: snapshot.size_bytes,
  }, null, 2));
} finally {
  if (snapshotCreated) {
    await withRetries('delete completed snapshot builder', () => box.delete()).catch(error => console.error('Snapshot builder cleanup failed:', error));
  } else {
    await withRetries('pause incomplete snapshot builder', () => box.pause()).catch(error => console.error('Snapshot builder pause failed:', error));
    console.error(`Snapshot builder ${box.id} was preserved. Resume with BOX_SNAPSHOT_RESUME_BOX_ID=${box.id}.`);
  }
}

async function run(label, command) {
  console.log(`\n[${label}]`);
  const result = await withRetries(label, () => box.exec.command(command));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.exitCode !== 0) throw new Error(`${label} failed with exit code ${result.exitCode}.`);
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
