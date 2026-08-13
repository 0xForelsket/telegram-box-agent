import { spawnSync } from 'node:child_process';

const secretPattern = [
  'sk-[A-Za-z0-9_-]{24,}',
  'gh[pousr]_[A-Za-z0-9]{20,}',
  'AKIA[0-9A-Z]{16}',
  'AIza[0-9A-Za-z_-]{30,}',
  '[0-9]{8,12}:[A-Za-z0-9_-]{30,}',
  '-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----',
].join('|');

const sensitiveFilename = /(^|\/)(?:\.dev\.vars|\.env|wrangler\.private\.toml|credentials(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|id_rsa|[^/]+\.(?:pem|p12|pfx))$/i;
const commits = git(['rev-list', 'HEAD']).trim().split(/\r?\n/).filter(Boolean);
const findings = [];

const worktreeNames = git(['ls-files', '--cached', '--others', '--exclude-standard']).trim().split(/\r?\n/).filter(Boolean);
for (const path of worktreeNames) {
  if (sensitiveFilename.test(path)) findings.push({ commit: 'WORKTREE', path, reason: 'sensitive filename' });
}
const worktreeGrep = spawnSync('git', ['grep', '--untracked', '-I', '-l', '-E', secretPattern, '--', '.'], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});
if (worktreeGrep.status !== 0 && worktreeGrep.status !== 1) {
  throw new Error(worktreeGrep.stderr.trim() || 'git grep failed for the working tree');
}
for (const path of worktreeGrep.stdout.trim().split(/\r?\n/).filter(Boolean)) {
  findings.push({ commit: 'WORKTREE', path, reason: 'high-confidence credential pattern' });
}

for (const commit of commits) {
  const names = git(['ls-tree', '-r', '--name-only', commit]).trim().split(/\r?\n/).filter(Boolean);
  for (const path of names) {
    if (sensitiveFilename.test(path)) findings.push({ commit, path, reason: 'sensitive filename' });
  }

  const grep = spawnSync('git', ['grep', '-I', '-l', '-E', secretPattern, commit, '--', '.'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (grep.status !== 0 && grep.status !== 1) {
    throw new Error(grep.stderr.trim() || `git grep failed for ${commit}`);
  }
  for (const entry of grep.stdout.trim().split(/\r?\n/).filter(Boolean)) {
    const separator = entry.indexOf(':');
    findings.push({
      commit,
      path: separator >= 0 ? entry.slice(separator + 1) : entry,
      reason: 'high-confidence credential pattern',
    });
  }
}

const unique = [...new Map(findings.map(item => [`${item.commit}\0${item.path}\0${item.reason}`, item])).values()];
if (unique.length > 0) {
  console.error(`Secret scan failed with ${unique.length} finding(s). Values are intentionally not printed.`);
  for (const finding of unique) {
    console.error(`- ${finding.commit.slice(0, 12)} ${finding.path} (${finding.reason})`);
  }
  process.exitCode = 1;
} else {
  console.log(`Secret scan passed for the working tree and ${commits.length} commit(s) reachable from HEAD.`);
}

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  return result.stdout;
}
