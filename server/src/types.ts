// Mirror of canary-demo/src/types.ts — keep in sync with the frontend.
// If the frontend file differs, paste its contents over this file.

export type View =
  | 'login'
  | 'signup'
  | 'search'
  | 'product'
  | 'cart'
  | 'checkout'
  | 'checkout-error'
  | 'orders'
  | 'reset';

export type Priority = 'critical' | 'high' | 'medium';
export type LogLevel = 'info' | 'warn' | 'error' | 'success' | 'ai';
export type StepStatus = 'running' | 'passed' | 'failed' | 'skipped';

export interface FlowStep {
  id: string;
  label: string;
  url: string;
  view: View;
  target?: string;
}

export type Profile = 'tr' | 'global';

export interface Flow {
  id: string;
  /** 'tr' = Turkey-specific check added by the Türkiye profile (Turkish characters, ₺ format, TC Kimlik, KVKK...) */
  region?: 'tr';
  name: string;
  description: string;
  priority: Priority;
  files: string[];
  steps: FlowStep[];
}

export interface CodeLine {
  n: number;
  text: string;
  bad?: boolean;
}

export interface Failure {
  flowId: string;
  stepId: string;
  title: string;
  expected: string;
  actual: string;
  file: string;
  line: number;
  code: CodeLine[];
  explanation: string;
  commit: { sha: string; message: string; author: string; when: string };
  fix: { before: string; after: string };
  /** live mode only: was this a real app bug or a problem with Canary's own generated test? */
  kind?: 'app_bug' | 'test_issue';
  /** live mode only: priority of the flow that failed, and its name */
  severity?: 'critical' | 'high' | 'medium';
  flowName?: string;
  /** live mode only: real Playwright screenshot (data URL) and page URL at the moment of failure */
  screenshot?: string;
  pageUrl?: string;
}

export interface ScanSummary {
  files: number;
  flows: number;
  passed: number;
  failed: number;
  coverage: number;
  durationMs: number;
}

export type ScanEvent =
  | { type: 'scan_start'; repo: string; branch: string; totalFiles: number }
  | { type: 'file'; path: string }
  | { type: 'flow'; flow: Flow }
  | { type: 'log'; level: LogLevel; message: string }
  | { type: 'test_start'; flowId: string }
  | { type: 'step'; flowId: string; stepId: string; status: StepStatus; screenshot?: string; pageUrl?: string }
  | { type: 'test_result'; flowId: string; status: 'passed' | 'failed'; durationMs: number; failure?: Failure; healed?: Healing[] }
  | { type: 'tr_audit'; report: TrAuditReport }
  | { type: 'sec_audit'; report: SecAuditReport }
  | { type: 'done'; summary: ScanSummary };

export const VIEWS: View[] = [
  'login',
  'signup',
  'search',
  'product',
  'cart',
  'checkout',
  'checkout-error',
  'orders',
  'reset',
];

/* ---- Türkiye Uyum Tarayıcısı (Canary TR) ---- */
export type TrSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface TrAuditItem {
  id: string;
  severity: TrSeverity;
  title: string;
  /** why this breaks for users in Turkey */
  why: string;
  /** suggested fix (code or instruction) */
  fix: string;
  /** total occurrences found */
  count: number;
  /** first few occurrences */
  locations: { file: string; line: number; text: string }[];
}

export interface TrAuditReport {
  /** 0–100, higher is better */
  score: number;
  filesScanned: number;
  items: TrAuditItem[];
}

/* ---- Güvenlik Tarayıcısı (pasif, statik analiz — canlı sisteme saldırı yapmaz) ---- */
export interface SecAuditItem {
  id: string;
  severity: TrSeverity;
  title: string;
  /** CWE reference, e.g. "CWE-79" */
  cwe: string;
  why: string;
  fix: string;
  count: number;
  /** secrets are masked before they get here; verdict/reason are set by the AI review (when it ran) */
  locations: { file: string; line: number; text: string; verdict?: 'real' | 'false_positive' | 'unsure'; reason?: string }[];
}

export interface SecAuditReport {
  /** 0–100, higher is better */
  score: number;
  filesScanned: number;
  items: SecAuditItem[];
  /** known-vulnerable dependencies (OSV.dev); undefined = lookup was not possible */
  dependencies?: { name: string; version: string; ids: string[] }[];
  /** AI second opinion on the findings (absent = review did not run) */
  aiReview?: { checked: number; falsePositives: number; model: string };
  /** true = repo owner proved control (.canary-verify); false = restricted report (no files/lines/code/package names) */
  verified: boolean;
  /** only when unverified: how the owner can unlock the full report */
  verify?: { file: string; content: string };
  /** only when restricted: number of vulnerable dependencies (names hidden) */
  dependencyCount?: number;
}

/** A test step that failed, was rewritten against the real page and then passed (self-healing). */
export interface Healing {
  stepId: string;
  stepLabel: string;
  /** one sentence: what changed on the page */
  reason: string;
  before: string;
  after: string;
}
