import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { historyItem, parseHistoryDiff, removedFromHead, scanGitHistory, withHistory } from '../src/gitHistory.ts';
import { runSecAudit } from '../src/secAudit.ts';

const KEY = 'AIzaSyA1234567890abcdefghijklmnopqrstuvw';
const H = 'a'.repeat(40);

test('parseHistoryDiff: finds added secrets with file, line and short commit; ignores removed/context lines', () => {
  const diff = [
    `commit ${H}`, 'diff --git a/c.js b/c.js', '--- a/c.js', '+++ b/c.js', '@@ -1,2 +1,3 @@',
    ' const a = 1;', `+const k = "${KEY}";`, `-const old = "${KEY}";`,
  ].join('\n');
  const hits = parseHistoryDiff(diff);
  assert.equal(hits.length, 1);
  assert.deepEqual([hits[0].file, hits[0].line, hits[0].commit, hits[0].kind], ['c.js', 2, 'aaaaaaa', 'Google API anahtarı']);
});

test('parseHistoryDiff: placeholders and env reads are not secrets', () => {
  const diff = [`commit ${H}`, '+++ b/c.js', '@@ -0,0 +1,2 @@', '+const k = process.env.GOOGLE_API_KEY;', `+const e = "your-key ${KEY}";`].join('\n');
  assert.equal(parseHistoryDiff(diff).length, 0);
});

test('removedFromHead keeps only values that are gone, once each', async () => {
  const hits = parseHistoryDiff([`commit ${H}`, '+++ b/a.js', '@@ -0,0 +1,2 @@', `+x = "${KEY}"`, `+y = "${KEY}"`].join('\n'));
  assert.equal((await removedFromHead(hits, async () => false)).length, 1);
  assert.equal((await removedFromHead(hits, async () => true)).length, 0);
});

test('history item never contains any part of the secret', () => {
  const hits = parseHistoryDiff([`commit ${H}`, '+++ b/a.js', '@@ -0,0 +1 @@', `+x = "${KEY}"`].join('\n'));
  const item = historyItem(hits)!;
  const json = JSON.stringify(item);
  assert.ok(!json.includes(KEY.slice(0, 4) + KEY.slice(4, 8)), 'not even a prefix beyond the key-type marker');
  assert.ok(!json.includes('AIza'), 'no first 4 characters');
  assert.equal(item.severity, 'critical');
});

test('withHistory adds the item and lowers the score', () => {
  const base = runSecAudit([{ path: 'a.ts', content: 'const x = 1;' }]);
  const item = historyItem(parseHistoryDiff([`commit ${H}`, '+++ b/a.js', '@@ -0,0 +1 @@', `+x = "${KEY}"`].join('\n')));
  const r = withHistory(base, item);
  assert.equal(r.items[0].id, 'sec-history-secret');
  assert.ok(r.score < base.score);
  assert.equal(withHistory(base, null), base);
});

test('scanGitHistory: real repo — deleted secret is found, kept one is not, nothing leaks', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'canary-hist-'));
  const origin = path.join(dir, 'origin');
  const clone = path.join(dir, 'clone');
  const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'protocol.file.allow=always', ...a], { cwd, stdio: 'pipe' });
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', origin]);
    writeFileSync(path.join(origin, 'config.js'), `const k = "${KEY}";\n`);
    writeFileSync(path.join(origin, 'keep.js'), 'const t = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\n');
    g(origin, 'add', '.'); g(origin, 'commit', '-qm', 'one');
    writeFileSync(path.join(origin, 'config.js'), 'const k = process.env.K;\n');
    g(origin, 'commit', '-qam', 'two');
    execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', '--depth', '1', '--single-branch', `file://${origin}`, clone]);
    const item = await scanGitHistory(clone, 'main');
    assert.ok(item, 'history finding expected');
    assert.equal(item.count, 1, 'only the removed key; the GitHub token is still in HEAD (sec-secret reports that)');
    assert.equal(item.locations[0].file, 'config.js');
    assert.ok(!JSON.stringify(item).includes('AIza'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scanGitHistory: no origin / unreachable → null, never throws', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'canary-hist-'));
  try {
    assert.equal(await scanGitHistory(dir, 'main'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
