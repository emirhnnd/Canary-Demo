import { GoogleGenAI } from '@google/genai';
import { sleep, withTimeout } from './util.ts';

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
// Optional comma-separated models to try when the main one is busy (503) or out of quota (429).
const FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODEL || '')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
// Minimum time to wait for one Gemini answer. Busy models can take 30-60s+.
const MIN_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 90_000;

let client: GoogleGenAI | null = null;

export function geminiModel() {
  return MODEL;
}

export function hasGeminiKey(): boolean {
  return Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim());
}

function getClient(): GoogleGenAI {
  if (!hasGeminiKey()) throw new Error('GEMINI_API_KEY is not set in server/.env');
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!.trim() });
  return client;
}

function stripFences(text: string): string {
  const t = text.trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1] : t;
}

type Failure = 'quota' | 'busy' | 'missing' | 'fatal';

/** Classify a Gemini error so we know whether to retry, switch model, or give up. */
function classify(e: unknown): Failure {
  const s = String(e instanceof Error ? e.message : e);
  if (/\b429\b|RESOURCE_EXHAUSTED|quota/i.test(s)) return 'quota'; // daily/minute quota: same model won't work
  if (/\b(503|500|502|504)\b|UNAVAILABLE|overloaded|high demand|INTERNAL|timed out/i.test(s)) return 'busy';
  if (/\b404\b|NOT_FOUND|no longer available/i.test(s)) return 'missing';
  return 'fatal'; // bad key, bad request, unparsable JSON
}

/** Models that ran out of quota, and until when we skip them. */
const exhaustedUntil = new Map<string, number>();

async function callOnce(model: string, prompt: string, timeoutMs: number): Promise<string> {
  const ai = getClient();
  const request = ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      temperature: 0.2,
      // Only 2.5 models accept a zero thinking budget; newer models choose their own.
      ...(model.includes('2.5') ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    },
  });
  const res = await withTimeout(request, timeoutMs, 'Gemini');
  const text = res.text ?? '';
  if (!text.trim()) throw new Error('Gemini returned an empty response');
  return text;
}

/**
 * Ask Gemini for a JSON answer. Tries GEMINI_MODEL, then each model in
 * GEMINI_FALLBACK_MODEL (comma-separated). A busy model (503) gets one retry;
 * a model out of quota (429) or unavailable (404) is skipped immediately so we
 * don't burn quota. Throws if every model fails; callers fall back to heuristics.
 */
export async function askJson<T>(prompt: string, timeoutMs = 60_000): Promise<T> {
  timeoutMs = Math.max(timeoutMs, MIN_TIMEOUT_MS);
  const models = [MODEL, ...FALLBACK_MODELS].filter((m, i, all) => m && all.indexOf(m) === i);
  let lastError: unknown = new Error('all Gemini models are out of quota; try again later');

  for (const model of models) {
    if ((exhaustedUntil.get(model) ?? 0) > Date.now()) continue;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const text = await callOnce(model, prompt, timeoutMs);
        if (model !== MODEL) console.warn(`[gemini] answered by fallback model ${model}`);
        return JSON.parse(stripFences(text)) as T;
      } catch (e) {
        lastError = e;
        const kind = classify(e);
        if (kind === 'fatal') throw e;
        if (kind === 'quota') {
          exhaustedUntil.set(model, Date.now() + 60 * 60 * 1000); // skip it for an hour
          console.warn(`[gemini] ${model} is out of quota, switching model`);
          break;
        }
        if (kind === 'missing') {
          exhaustedUntil.set(model, Date.now() + 24 * 60 * 60 * 1000);
          console.warn(`[gemini] ${model} is not available, switching model`);
          break;
        }
        // timed out: waiting again would double the delay on stage, go to the next model
        if (/timed out/i.test(String(e))) {
          console.warn(`[gemini] ${model} timed out, switching model`);
          break;
        }
        // busy: one more try after a short pause, then next model
        console.warn(`[gemini] ${model} busy${attempt === 1 ? ', retrying in 3s' : ', switching model'}`);
        if (attempt === 1) await sleep(3_000);
      }
    }
  }
  throw lastError;
}
