import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeSemgrep, parseSemgrep, runSemgrep } from '../src/semgrep.ts';
import { runSecAudit } from '../src/secAudit.ts';

// Shape follows `semgrep --json`; produced by hand, NOT captured from a real run.
const SAMPLE = JSON.stringify({
  results: [
    { check_id: 'javascript.express.security.audit.xss.direct-response-write', path: 'a.js', start: { line: 2 }, extra: { message: 'Yanıta ham girdi yazılıyor', severity: 'ERROR', lines: 'requires login', metadata: { cwe: ['CWE-79: Cross-site Scripting'] } } },
    { check_id: 'javascript.express.security.audit.xss.direct-response-write', path: 'a.js', start: { line: 5 }, extra: { message: 'x', severity: 'ERROR' } },
    { check_id: 'x.y.weak-thing', path: 'b.js', start: { line: 1 }, extra: { message: 'm', severity: 'INFO' } },
    { check_id: 'bad', path: 'c.js' },
  ],
});
const lines: Record<string, string[]> = {
  'a.js': ['x', 'res.send(req.query.q);', '', '', 'const k = "AIzaSyA1234567890abcdefghijklmnopqrstuvw";'],
  'b.js': ['md5(x)'],
};
const read = (f: string, l: number) => lines[f]?.[l - 1] ?? '';

test('parseSemgrep groups by rule, maps severity/CWE and masks secrets in code lines', () => {
  const items = parseSemgrep(SAMPLE, read);
  assert.equal(items.length, 2);
  const xss = items.find((i) => i.id === 'semgrep:direct-response-write')!;
  assert.deepEqual([xss.severity, xss.cwe, xss.count], ['high', 'CWE-79', 2]);
  assert.ok(!JSON.stringify(items).includes('AIza'), 'secret must be masked');
  assert.equal(items.find((i) => i.id === 'semgrep:weak-thing')!.severity, 'low');
});

test('parseSemgrep tolerates garbage', () => {
  assert.deepEqual(parseSemgrep('not json', read), []);
  assert.deepEqual(parseSemgrep('{}', read), []);
});

test('mergeSemgrep adds items, drops locations our rules already reported, lowers score', () => {
  const base = runSecAudit([{ path: 'a.js', content: 'x\nres.redirect(req.query.next);' }]);
  const dupItem = { id: 'semgrep:r', severity: 'medium' as const, title: 't', cwe: 'CWE-601', why: 'w', fix: 'f', count: 1, locations: [{ file: 'a.js', line: 2, text: 'same line' }] };
  assert.equal(mergeSemgrep(base, [dupItem]).items.length, base.items.length, 'duplicate location → nothing new');
  const merged = mergeSemgrep(base, parseSemgrep(SAMPLE, read));
  assert.ok(merged.items.length > base.items.length);
  assert.ok(merged.score <= base.score);
  assert.equal(mergeSemgrep(base, []), base);
});

test('runSemgrep: binary not installed → null, no throw', async () => {
  assert.equal(await runSemgrep('/tmp', 'definitely-not-installed-semgrep'), null);
});
