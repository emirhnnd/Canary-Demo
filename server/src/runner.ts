import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Browser, Page } from 'playwright';
import { askJson } from './gemini.ts';
import { buildSourceContext } from './flows.ts';
import type { SourceFile } from './repo.ts';
import type { Flow, FlowStep, Profile } from './types.ts';
import { browserContextOptions, testGuide } from './profile.ts';
import { errMsg, withTimeout } from './util.ts';

/**
 * Gemini writes the test as a structured list of Playwright actions per step.
 * We execute these with our own small interpreter instead of eval-ing generated
 * code: it is safer, never hangs on a syntax error, and lets us emit a `step`
 * event exactly when each step starts/finishes. A readable .spec.ts is also
 * written to server/generated-tests/ so you can show it.
 */
export type ActionKind = 'goto' | 'click' | 'fill' | 'press' | 'expectVisible' | 'expectText' | 'expectUrl' | 'wait';

export interface Action {
  action: ActionKind;
  selector?: string;
  value?: string;
  url?: string;
}

export interface TestPlan {
  steps: Record<string, Action[]>; // stepId -> actions
  generatedByAi: boolean;
}

const ACTION_KINDS: ActionKind[] = ['goto', 'click', 'fill', 'press', 'expectVisible', 'expectText', 'expectUrl', 'wait'];
const ACTION_TIMEOUT = 8_000;
const NAV_TIMEOUT = 15_000;

export function resolveUrl(appUrl: string, url: string): string {
  try {
    return new URL(url, appUrl.endsWith('/') ? appUrl : `${appUrl}/`).toString();
  } catch {
    return appUrl;
  }
}

// ---------- plan generation ----------

const ACTION_RULES = `Action = { "action": ${ACTION_KINDS.map((k) => `"${k}"`).join(' | ')}, "selector"?: string, "value"?: string, "url"?: string }
- goto: url is a path relative to the app (e.g. "/login")
- click / fill / press / expectVisible: "selector" is ONE Playwright selector. Prefer robust ones that
  exist in the source below: text=..., role=button[name="..."], [data-testid=...], input[name=...], #id.
  Never put several alternatives in one selector separated by commas, and never mix selector engines.
  Use the exact visible text from the source code (including non-English characters).
- fill: "value" is the text to type (use realistic test data, e.g. qa+canary@example.com).
- press: "value" is a key such as "Enter".
- expectText: "value" is visible text that proves the step succeeded.
- expectUrl: "value" is a substring the URL should contain.
Keep 1-4 actions per step. The first step of every flow should start with a goto.`;

/** Turn Gemini's raw step->actions map into a clean plan for one flow. */
function toPlan(flow: Flow, rawSteps: Record<string, unknown> | undefined): TestPlan {
  const steps: Record<string, Action[]> = {};
  for (const step of flow.steps) {
    const raw = rawSteps?.[step.id];
    const actions = Array.isArray(raw) ? raw.map(cleanAction).filter((a): a is Action => a !== null) : [];
    steps[step.id] = actions.length ? actions.slice(0, 6) : fallbackActions(step);
  }
  // Make sure the test navigates somewhere first.
  const first = flow.steps[0];
  if (first && !steps[first.id].some((a) => a.action === 'goto')) {
    steps[first.id].unshift({ action: 'goto', url: first.url });
  }
  const anyAi = flow.steps.some((s) => Array.isArray(rawSteps?.[s.id]));
  return { steps, generatedByAi: anyAi };
}

/**
 * Write the Playwright actions for ALL flows in a single Gemini request.
 * (The free tier allows only ~20 requests per model per day, so one call per
 * flow would use up the quota in two scans.)
 */
export async function generateAllPlans(
  flows: Flow[],
  appUrl: string,
  files: SourceFile[],
  profile: Profile = 'tr',
): Promise<Map<string, TestPlan>> {
  const used = new Set(flows.flatMap((f) => f.files));
  const relevant = files.filter((f) => used.has(f.path));
  const prompt = `You are Canary, an AI QA engineer writing Playwright end-to-end tests.
App under test: ${appUrl}
Flows: ${JSON.stringify(flows.map(({ id, name, steps, region }) => ({ id, name, region, steps })), null, 2)}

For EACH flow and EACH of its step ids, list the Playwright actions that perform and verify that step.
Return JSON: { "flows": { "<flowId>": { "<stepId>": Action[] } } }
${ACTION_RULES}
${testGuide(profile)}

${buildSourceContext(relevant.length ? relevant : files, 45_000)}`;

  const res = await askJson<{ flows?: Record<string, Record<string, unknown>> }>(prompt);
  const plans = new Map<string, TestPlan>();
  for (const flow of flows) plans.set(flow.id, toPlan(flow, res.flows?.[flow.id]));
  return plans;
}

/** Single-flow variant (kept for reuse). */
export async function generatePlan(flow: Flow, appUrl: string, files: SourceFile[]): Promise<TestPlan> {
  return (await generateAllPlans([flow], appUrl, files)).get(flow.id) ?? fallbackPlan(flow);
}

export function cleanAction(a: unknown): Action | null {
  if (!a || typeof a !== 'object') return null;
  const r = a as Record<string, unknown>;
  if (!ACTION_KINDS.includes(r.action as ActionKind)) return null;
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const action: Action = { action: r.action as ActionKind, selector: s(r.selector), value: s(r.value), url: s(r.url) };
  if (['click', 'fill', 'expectVisible'].includes(action.action) && !action.selector) return null;
  if (action.action === 'fill' && action.value === undefined) action.value = 'canary-test';
  return action;
}

function fallbackActions(step: FlowStep): Action[] {
  return [
    { action: 'goto', url: step.url },
    { action: 'expectVisible', selector: 'body' },
  ];
}

export function fallbackPlan(flow: Flow): TestPlan {
  const steps: Record<string, Action[]> = {};
  for (const s of flow.steps) steps[s.id] = fallbackActions(s);
  return { steps, generatedByAi: false };
}

/** Render the plan as a readable Playwright spec and save it (for showing on stage). */
export async function writeSpecFile(flow: Flow, plan: TestPlan, appUrl: string): Promise<string | null> {
  const q = (v: string | undefined) => JSON.stringify(v ?? '');
  const lines: string[] = [
    `// Generated by Canary for flow "${flow.name}"`,
    `import { test, expect } from '@playwright/test';`,
    ``,
    `test(${q(flow.name)}, async ({ page }) => {`,
  ];
  for (const step of flow.steps) {
    lines.push(`  await test.step(${q(step.label)}, async () => {`);
    for (const a of plan.steps[step.id] ?? []) {
      switch (a.action) {
        case 'goto': lines.push(`    await page.goto(${q(resolveUrl(appUrl, a.url ?? step.url))});`); break;
        case 'click': lines.push(`    await page.locator(${q(a.selector)}).first().click();`); break;
        case 'fill': lines.push(`    await page.locator(${q(a.selector)}).first().fill(${q(a.value)});`); break;
        case 'press': lines.push(a.selector
          ? `    await page.locator(${q(a.selector)}).first().press(${q(a.value)});`
          : `    await page.keyboard.press(${q(a.value)});`); break;
        case 'expectVisible': lines.push(`    await expect(page.locator(${q(a.selector)}).first()).toBeVisible();`); break;
        case 'expectText': lines.push(`    await expect(page.getByText(${q(a.value)}).first()).toBeVisible();`); break;
        case 'expectUrl': lines.push(`    await expect(page).toHaveURL(new RegExp(${q(escapeRegex(a.value ?? ''))}));`); break;
        case 'wait': lines.push(`    await page.waitForTimeout(${Number(a.value) || 500});`); break;
      }
    }
    lines.push(`  });`);
  }
  lines.push(`});`, ``);
  try {
    const dir = path.resolve(process.cwd(), 'generated-tests');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${flow.id}.spec.ts`);
    await fs.writeFile(file, lines.join('\n'), 'utf8');
    return path.relative(process.cwd(), file).split(path.sep).join('/');
  } catch {
    return null;
  }
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------- execution ----------

export interface StepRunner {
  mode: 'playwright' | 'http';
  /** Runs one step. Throws an Error describing what went wrong on failure. */
  runStep(step: FlowStep, actions: Action[]): Promise<void>;
  /** Start a fresh browser context for a new flow. */
  newTest(): Promise<void>;
  /** What is on the page right now (accessibility snapshot), for self-healing. Never throws. */
  pageSummary(): Promise<string>;
  /** Real screenshot of the current page (JPEG data URL) + its URL. Never throws. */
  snapshot(): Promise<{ screenshot?: string; pageUrl?: string }>;
  close(): Promise<void>;
}

/** Real headless Chromium. Throws if the browser can't start (e.g. not installed). */
export async function createPlaywrightRunner(appUrl: string, profile: Profile = 'tr'): Promise<StepRunner> {
  const { chromium } = await import('playwright');
  const browser: Browser = await withTimeout(chromium.launch({ headless: true }), 30_000, 'Chromium launch');
  let page: Page | null = null;

  async function newTest() {
    if (page) await page.context().close().catch(() => {});
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...browserContextOptions(profile) });
    page = await context.newPage();
    page.setDefaultTimeout(ACTION_TIMEOUT);
  }

  return {
    mode: 'playwright',
    newTest,
    async pageSummary() {
      if (!page) return '';
      try {
        const snap = await withTimeout(page.locator('body').ariaSnapshot({ timeout: 4_000 }), 5_000, 'ariaSnapshot');
        if (snap.trim()) return snap.slice(0, 9_000);
      } catch {
        /* fall through to a simple element list */
      }
      try {
        const list = await page.evaluate(() =>
          Array.from(document.querySelectorAll('button,a,input,select,textarea,[role=button],h1,h2,h3,label'))
            .slice(0, 300)
            .map((el) => {
              const h = el as HTMLElement;
              const t = (h.innerText || h.getAttribute('aria-label') || h.getAttribute('placeholder') || h.getAttribute('name') || '').trim();
              return `${el.tagName.toLowerCase()}${h.id ? '#' + h.id : ''}${t ? ': ' + t.slice(0, 80) : ''}`;
            })
            .join('\n'),
        );
        return list.slice(0, 9_000);
      } catch {
        return '';
      }
    },
    async snapshot() {
      if (!page) return {};
      try {
        const buf = await withTimeout(page.screenshot({ type: 'jpeg', quality: 55, timeout: 4_000 }), 5_000, 'screenshot');
        return { screenshot: `data:image/jpeg;base64,${buf.toString('base64')}`, pageUrl: page.url() };
      } catch {
        return { pageUrl: page.url() };
      }
    },
    async runStep(step, actions) {
      if (!page) await newTest();
      const p = page!;
      for (const a of actions) await runAction(p, a, step, appUrl);
    },
    async close() {
      await browser.close().catch(() => {});
    },
  };
}

/**
 * Split "a, b, text='c'" on top-level commas (ignoring commas inside quotes,
 * parentheses or brackets). Gemini sometimes lists alternatives this way and
 * mixes selector engines, which Playwright can't parse as one selector.
 */
export function splitSelector(sel: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (const ch of sel) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.length ? parts : [sel];
}

/** A locator that matches any of the comma-separated alternatives. */
function loc(page: Page, sel: string) {
  const [first, ...rest] = splitSelector(sel);
  let l = page.locator(first);
  for (const s of rest) l = l.or(page.locator(s));
  return l.first();
}

async function runAction(page: Page, a: Action, step: FlowStep, appUrl: string): Promise<void> {
  const describe = `${a.action}${a.selector ? ` ${a.selector}` : ''}${a.value ? ` "${a.value}"` : ''}`;
  try {
    switch (a.action) {
      case 'goto': {
        const url = resolveUrl(appUrl, a.url ?? step.url);
        const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        if (res && res.status() >= 400) throw new Error(`HTTP ${res.status()} for ${url}`);
        return;
      }
      case 'click':
        return await loc(page, a.selector!).click({ timeout: ACTION_TIMEOUT });
      case 'fill':
        return await loc(page, a.selector!).fill(a.value ?? '', { timeout: ACTION_TIMEOUT });
      case 'press':
        if (a.selector) return await loc(page, a.selector).press(a.value ?? 'Enter', { timeout: ACTION_TIMEOUT });
        return await page.keyboard.press(a.value ?? 'Enter');
      case 'expectVisible':
        return await loc(page, a.selector!).waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });
      case 'expectText':
        return await page.getByText(a.value ?? '').first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });
      case 'expectUrl': {
        const needle = a.value ?? '';
        await page.waitForURL((u) => u.toString().includes(needle), { timeout: ACTION_TIMEOUT });
        return;
      }
      case 'wait':
        return await page.waitForTimeout(Math.min(Number(a.value) || 500, 3_000));
    }
  } catch (e) {
    throw new Error(`${describe} → ${errMsg(e)}`);
  }
}

/**
 * Fallback when Chromium can't start: a plain HTTP smoke check of each step's URL.
 * Less thorough, but still real and keeps the demo moving.
 */
export function createHttpRunner(appUrl: string): StepRunner {
  return {
    mode: 'http',
    async newTest() {},
    async snapshot() {
      return {};
    },
    async pageSummary() {
      return '';
    },
    async runStep(step, actions) {
      const target = actions.find((a) => a.action === 'goto')?.url ?? step.url;
      const url = resolveUrl(appUrl, target);
      let res: Response;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(NAV_TIMEOUT), redirect: 'follow' });
      } catch (e) {
        throw new Error(`GET ${url} → ${errMsg(e)}`);
      }
      if (res.status >= 400) throw new Error(`GET ${url} → HTTP ${res.status}`);
    },
    async close() {},
  };
}
