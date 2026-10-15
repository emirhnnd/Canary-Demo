import assert from 'node:assert/strict';
import { test } from 'node:test';
import { restrictReport, runSecAudit } from '../src/secAudit.ts';

/** Does the audit flag `rule` for this one-file snippet? */
const flagged = (rule: string, code: string, path = 'src/a.ts') =>
  runSecAudit([{ path, content: code }]).items.some((i) => i.id === rule);

interface Case {
  rule: string;
  /** must be flagged (real vulnerability) */
  bad: string[];
  /** must NOT be flagged (safe code) */
  good: string[];
  /** known limits of line-based matching: measured and printed, never fail the build */
  limits?: { code: string; why: string }[];
  /** real vulnerabilities this rule cannot see without data-flow analysis: measured as misses, never fail the build */
  blind?: { code: string; why: string }[];
}

const CASES: Case[] = [
  {
    rule: 'sec-secret',
    bad: [
      'const k = "AIzaSyA1234567890abcdefghijklmnopqrstuvw";',
      "const t = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';",
      'const cfg = { password: "SuperSecret123456" };',
      'const aws = "AKIAJ5Q7N2P4R6T8V0WX";',
      '-----BEGIN RSA PRIVATE KEY-----',
      'cookieSecret: "s3cr3tK3yValue99",',
    ],
    good: [
      'const k = process.env.API_KEY;',
      'const k = import.meta.env.VITE_KEY;',
      'const cfg = { password: "" };',
      'const password = req.body.password;',
      "apiKey: 'your-api-key-here-please',",
      'const label = "Enter your password";',
      '// const k = "AIzaSyA1234567890abcdefghijklmnopqrstuvw";',
    ],
  },
  {
    rule: 'sec-eval',
    bad: ['eval(req.body.expr);', 'const f = new Function("a", code);', 'x = eval (input)'],
    good: ['model.evaluate(x);', 'const v = JSON.parse(text);', 'obj.eval(x);', '// eval(x)', 'const evalScore = 3;'],
    limits: [{ code: 'const msg = "never call eval(x) here";', why: 'eval inside a string literal' }],
  },
  {
    rule: 'sec-xss',
    bad: [
      'el.innerHTML = userInput;',
      '<div dangerouslySetInnerHTML={{ __html: html }} />',
      'document.write(location.hash);',
      'el.insertAdjacentHTML("beforeend", data);',
      'el.innerHTML = `<b>${name}</b>`;',
    ],
    good: ['el.textContent = userInput;', 'const h = el.innerHTML;', 'if (el.innerHTML == "x") {}', "el.innerHTML = '';"],
  },
  {
    rule: 'sec-sqli',
    bad: [
      'db.query(`SELECT * FROM u WHERE id=${id}`);',
      'db.query("SELECT * FROM u WHERE n=\'" + name + "\'");',
      'const q = "SELECT * FROM users WHERE id=" + id;',
      'conn.execute(`DELETE FROM t WHERE id = ${req.params.id}`);',
    ],
    good: ['db.query("SELECT * FROM u WHERE id = $1", [id]);', 'db.query("SELECT * FROM u");', 'const label = "Select all";'],
    limits: [{ code: 'const hint = "Select a file from " + dir;', why: 'English prose that looks like SQL' }],
  },
  {
    rule: 'sec-cmd',
    bad: ['exec(`ls ${dir}`);', 'exec("ls " + dir);', 'child_process.exec(cmd + arg);', 'spawn(cmd, { shell: true });'],
    good: ['execFile("ls", [dir]);', 'const m = re.exec(line);', 'spawn("ls", ["-l"]);'],
  },
  {
    rule: 'sec-nosql',
    bad: [
      'db.collection("users").find({ $where: "this.a == " + x });',
      'users.findOne({ username: req.body.username, password: req.body.password });',
      'collection.find(req.query);',
      'Model.find({ name: { $regex: req.query.q } });',
      'db.users.deleteOne({ _id: req.params.id });',
    ],
    good: [
      'users.findOne({ username: String(req.body.username) });',
      'users.findOne({ id: Number(req.params.id) });',
      'users.find({});',
      'users.findOne({ email: "a@b.com" });',
      'app.get("/", (req, res) => res.send("ok"));',
      'const hits = items.find((x) => x.id === 3);',
    ],
    blind: [{ code: 'const u = req.body.user;\nusers.find({ user: u });', why: 'tainted value reaches the query through a variable (needs data-flow analysis)' }],
  },
  {
    rule: 'sec-open-redirect',
    bad: [
      'res.redirect(req.query.next);',
      'res.redirect(req.body.url);',
      'res.redirect("http://" + req.query.host);',
      'window.location = new URLSearchParams(location.search).get("next");',
      "window.location.href = searchParams.get('redirect');",
    ],
    good: [
      'res.redirect("/home");',
      'res.redirect("/login?next=" + encodeURIComponent(req.originalUrl));',
      'res.redirect(`/users/${req.params.id}`);',
      'window.location.href = "/dashboard";',
      'if (window.location.href == "x") {}',
    ],
    blind: [{ code: 'const to = req.query.next;\nres.redirect(to);', why: 'tainted value reaches the redirect through a variable' }],
  },
  {
    rule: 'sec-cookie-flags',
    bad: ['cookie: { httpOnly: false },', 'session({ cookie: { secure: false } })', 'res.cookie("a", b, { httpOnly:false })'],
    good: ['cookie: { httpOnly: true, secure: true },', 'cookie: { secure: process.env.NODE_ENV === "production" },', 'const secure = false;'],
  },
  {
    rule: 'sec-tls',
    bad: ['{ rejectUnauthorized: false }', "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';"],
    good: ['{ rejectUnauthorized: true }'],
  },
  {
    rule: 'sec-cors',
    bad: ['app.use(cors());', "res.setHeader('Access-Control-Allow-Origin', '*');", "cors({ origin: '*' })", 'cors({ origin: true })'],
    good: ["cors({ origin: ['https://a.com'] })", 'cors({ origin: /^http:\\/\\/localhost/ })'],
  },
  {
    rule: 'sec-weak-hash',
    bad: ["crypto.createHash('md5').update(p)", 'const h = sha1(password);'],
    good: ["crypto.createHash('sha256').update(p)"],
  },
  {
    rule: 'sec-random',
    bad: ['const token = Math.random().toString(36);', 'const sessionId = Math.random();'],
    good: ['const delay = Math.random() * 1000;', 'const color = Math.random() > 0.5;'],
  },
  {
    rule: 'sec-token-storage',
    bad: ["localStorage.setItem('authToken', t);", 'sessionStorage.setItem("jwt", x);'],
    good: ["localStorage.setItem('theme', 'dark');", "localStorage.getItem('authToken');"],
  },
  {
    rule: 'sec-jwt',
    bad: ['const p = jwt.decode(token);', "jwt.verify(t, s, { algorithms: ['none'] });"],
    good: ["jwt.verify(token, secret, { algorithms: ['HS256'] });"],
  },
  {
    rule: 'sec-http',
    bad: ['fetch("http://api.shop.com/x");', "const base = 'http://payments.example.org';"],
    good: [
      'fetch("http://localhost:3000/x");',
      '<svg xmlns="http://www.w3.org/2000/svg">',
      "fetch('https://api.shop.com/x');",
      'const u = "http://127.0.0.1:8787";',
    ],
  },
  {
    rule: 'sec-blank',
    bad: ['<a href="x" target="_blank">go</a>'],
    good: ['<a href="x" target="_blank" rel="noopener noreferrer">go</a>', '<a href="x">go</a>'],
    limits: [{ code: '<a\n  target="_blank"\n  rel="noopener"\n>x</a>', why: 'rel on another line (JSX multi-line)' }],
  },
];

let tp = 0, fn = 0, fp = 0, tn = 0, limitHits = 0, limitTotal = 0, blindMissed = 0, blindTotal = 0;
const rows: string[] = [];

for (const c of CASES) {
  test(`${c.rule}: flags vulnerable code`, () => {
    for (const code of c.bad) assert.equal(flagged(c.rule, code), true, `should flag: ${code}`);
  });
  test(`${c.rule}: ignores safe code`, () => {
    for (const code of c.good) assert.equal(flagged(c.rule, code), false, `should NOT flag: ${code}`);
  });
  test(`${c.rule}: measure`, () => {
    const b = c.bad.filter((x) => flagged(c.rule, x)).length;
    const g = c.good.filter((x) => flagged(c.rule, x)).length;
    tp += b; fn += c.bad.length - b; fp += g; tn += c.good.length - g;
    const lim = (c.limits ?? []).filter((l) => flagged(c.rule, l.code));
    limitHits += lim.length; limitTotal += c.limits?.length ?? 0;
    blindMissed += (c.blind ?? []).filter((l) => !flagged(c.rule, l.code)).length;
    blindTotal += c.blind?.length ?? 0;
    rows.push(`${c.rule.padEnd(18)} recall ${b}/${c.bad.length}  false-alarms ${g}/${c.good.length}${c.limits ? `  known-limit hits ${lim.length}/${c.limits.length}` : ''}`);
  });
}

const ids = (files: { path: string; content: string }[]) => runSecAudit(files).items.map((i) => i.id);
const EXPRESS = "const express = require('express');\nconst app = express();\napp.listen(3000);";

test('sec-helmet: express server without helmet is flagged, with helmet or non-server is not', () => {
  assert.ok(ids([{ path: 'server.js', content: EXPRESS }]).includes('sec-helmet'));
  assert.ok(!ids([{ path: 'server.js', content: EXPRESS + "\nconst helmet = require('helmet'); app.use(helmet());" }]).includes('sec-helmet'));
  assert.ok(!ids([{ path: 'lib.js', content: "const express = require('express'); module.exports = express.Router();" }]).includes('sec-helmet'), 'no listen() = not a server entry');
  assert.ok(!ids([{ path: 'a.ts', content: 'const x = 1;' }]).includes('sec-helmet'));
});

test('sec-csrf: session + state-changing route without CSRF token is flagged', () => {
  const session = "const session = require('express-session');\napp.use(session({ secret: s }));\napp.post('/transfer', (req, res) => {});";
  assert.ok(ids([{ path: 'server.js', content: EXPRESS + '\n' + session }]).includes('sec-csrf'));
  assert.ok(!ids([{ path: 'server.js', content: EXPRESS + '\n' + session + "\napp.use(require('csurf')());" }]).includes('sec-csrf'));
  assert.ok(!ids([{ path: 'server.js', content: EXPRESS + '\n' + session + "\napp.use(session({ cookie: { sameSite: 'lax' } }));" }]).includes('sec-csrf'));
  // pure JSON API without cookies/sessions is not CSRF-prone
  assert.ok(!ids([{ path: 'server.js', content: EXPRESS + "\napp.post('/api/x', (req, res) => {});" }]).includes('sec-csrf'));
  // nothing is flagged for a non-server project
  assert.ok(!ids([{ path: 'a.ts', content: "res.cookie('a','b'); router.post('/x', f);" }]).includes('sec-csrf'));
});

test('project-level: commented-out helmet/csrf does not count as protection', () => {
  const code = EXPRESS + "\n// const helmet = require('helmet'); app.use(helmet());\n// app.use(csrf());\napp.use(require('express-session')({}));\napp.post('/x', f);";
  const found = ids([{ path: 'server.js', content: code }]);
  assert.ok(found.includes('sec-helmet'));
  assert.ok(found.includes('sec-csrf'));
});

test('project-level findings point at a real file and line', () => {
  const r = runSecAudit([{ path: 'server.js', content: EXPRESS }]);
  const h = r.items.find((i) => i.id === 'sec-helmet')!;
  assert.equal(h.locations[0].file, 'server.js');
  assert.equal(h.locations[0].line, 1);
});

test('tracked secret files are flagged, examples are not', () => {
  const r = runSecAudit([], ['.env', '.env.local', 'keys/id_rsa', 'certs/a.pem', 'artifacts/cert/server.key', 'server/.env.example', 'src/env.ts', 'README.md']);
  const item = r.items.find((i) => i.id === 'sec-tracked-secret-file');
  assert.ok(item);
  assert.deepEqual(item.locations.map((l) => l.file).sort(), ['.env', '.env.local', 'artifacts/cert/server.key', 'certs/a.pem', 'keys/id_rsa']);
});

test('secrets are masked in the report', () => {
  const r = runSecAudit([{ path: 'a.ts', content: 'const k = "AIzaSyA1234567890abcdefghijklmnopqrstuvw";' }]);
  const text = JSON.stringify(r);
  assert.ok(!text.includes('1234567890abcdefghijklmnopqrstuvw'), 'secret body leaked');
});

test('restricted report has no files, lines, code or package names', () => {
  const full = runSecAudit([{ path: 'src/secret/config.ts', content: 'el.innerHTML = secretVarName;\nconst k = "AIzaSyA1234567890abcdefghijklmnopqrstuvw";' }]);
  full.dependencies = [{ name: 'left-pad', version: '1.0.0', ids: ['GHSA-xxxx'] }];
  const r = restrictReport(full, { file: '.canary-verify', content: 'canary-verify=abc' });
  const text = JSON.stringify(r);
  for (const leak of ['src/secret', 'config.ts', 'secretVarName', 'AIza', 'left-pad', 'GHSA-xxxx']) assert.ok(!text.includes(leak), `leaked: ${leak}`);
  assert.equal(r.verified, false);
  assert.equal(r.dependencyCount, 1);
  assert.ok(r.items.length > 0 && r.items.every((i) => i.locations.length === 0));
});

test('quality report', { concurrency: false }, () => {
  const total = tp + fn, safe = fp + tn;
  console.log('\n' + rows.join('\n'));
  console.log(`\nrecall ${tp}/${total} (${Math.round((100 * tp) / total)}%) · false alarms ${fp}/${safe} (${Math.round((100 * fp) / safe)}%) · known false-alarm limits still hit ${limitHits}/${limitTotal} · data-flow blind spots missed ${blindMissed}/${blindTotal}`);
});

test('test/fixture files are skipped by code rules but still checked for leaked secrets', () => {
  const evil = 'eval(req.body.x);\nel.innerHTML = userInput;';
  for (const p of ['test/a.ts', 'src/__tests__/a.ts', 'src/a.test.ts', 'e2e/a.js', 'src/a.spec.tsx']) {
    assert.equal(runSecAudit([{ path: p, content: evil }]).items.length, 0, p);
  }
  assert.ok(runSecAudit([{ path: 'src/a.ts', content: evil }]).items.length > 0, 'same code outside tests is flagged');
  const leaked = runSecAudit([{ path: 'test/a.ts', content: 'const k = "AIzaSyA1234567890abcdefghijklmnopqrstuvw";' }]);
  assert.ok(leaked.items.some((i) => i.id === 'sec-secret'), 'a real key committed in a test file is still a leak');
});
