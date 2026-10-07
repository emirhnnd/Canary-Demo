// Kendini onaran testler (self-healing tests) — a Canary TR feature, not in the original Canary.
// When a generated step fails, Canary looks at what is ACTUALLY on the page right now
// (accessibility snapshot), asks the AI to rewrite just that step against the real
// elements, and runs it again. If it passes, the test healed itself and the run goes on;
// if the element really is missing, that is strong evidence of an app bug.

import { askJson } from './gemini.ts';
import { cleanAction, type Action } from './runner.ts';
import type { Flow, FlowStep, Profile } from './types.ts';

export interface HealResult {
  healed: boolean;
  reason: string;
  actions: Action[];
}

export async function healStep(
  flow: Flow,
  step: FlowStep,
  failedActions: Action[],
  error: string,
  pageSnapshot: string,
  profile: Profile,
): Promise<HealResult> {
  const prompt = `You are Canary, an AI QA engineer. A Playwright test step YOU wrote just failed.
Look at what is really on the page now and repair the step if the user's goal is still achievable.

Flow: ${flow.name}
Step goal: "${step.label}"${step.target ? ` (target: ${step.target})` : ''}
Actions that failed: ${JSON.stringify(failedActions)}
Error: ${error}

CURRENT PAGE (Playwright accessibility snapshot; this is the real UI right now):
${pageSnapshot || '(empty page)'}

Rules:
- If an element on this page clearly serves the step's goal (same purpose, maybe different text, language or
  structure — e.g. a "Sign in" link that is now a "Giriş Yap" button), return "healed": true and new actions that use it.
- Selectors must match the snapshot exactly. Prefer role selectors: role=button[name="Giriş Yap"],
  role=link[name="..."], role=textbox[name="..."], or text="...". One selector per action, no commas.
- Actions run from the page's CURRENT state. Use the same Action format:
  { "action": "goto"|"click"|"fill"|"press"|"expectVisible"|"expectText"|"expectUrl"|"wait", "selector"?, "value"?, "url"? }
- If nothing on the page can achieve the goal (missing button, error page, broken feature), return "healed": false.
  Do NOT invent elements that are not in the snapshot.
- "reason": one short sentence${profile === 'tr' ? ' in Turkish' : ''} saying what changed (e.g. '"Log in" butonu arayüzde "Giriş Yap" olarak geçiyor').

Return JSON: { "healed": boolean, "reason": string, "actions": Action[] }`;

  const res = await askJson<{ healed?: boolean; reason?: string; actions?: unknown[] }>(prompt);
  const actions = (Array.isArray(res.actions) ? res.actions : [])
    .map(cleanAction)
    .filter((a): a is Action => a !== null)
    .slice(0, 6);
  const reason = typeof res.reason === 'string' && res.reason.trim() ? res.reason.trim() : '';
  return { healed: Boolean(res.healed) && actions.length > 0, reason, actions };
}

/** Short, human-readable form of a step's actions for the UI ("before → after"). */
export function describeActions(actions: Action[]): string {
  return actions
    .map((a) => {
      switch (a.action) {
        case 'goto':
          return `goto ${a.url ?? ''}`;
        case 'fill':
          return `fill ${a.selector} "${a.value ?? ''}"`;
        case 'press':
          return `press ${a.value ?? ''}`;
        case 'expectText':
          return `expectText "${a.value ?? ''}"`;
        case 'expectUrl':
          return `expectUrl ${a.value ?? ''}`;
        case 'wait':
          return `wait ${a.value ?? ''}`;
        default:
          return `${a.action} ${a.selector ?? ''}`;
      }
    })
    .join(' · ')
    .slice(0, 220);
}
