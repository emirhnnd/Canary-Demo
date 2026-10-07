// Shared types. The ScanEvent union is the CONTRACT between UI and backend:
// the backend streams these events (Server-Sent Events, one JSON per `data:` line).

export type FlowStatus = 'pending' | 'running' | 'passed' | 'failed';
export type StepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

/** Which mock page the mini browser should render for a step. */
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

export interface Step {
  id: string;
  label: string;
  url: string;
  view: View;
  /** element id to highlight in the mini browser */
  target?: string;
}

export interface Flow {
  id: string;
  /** 'tr' = Turkey-specific check added by the Türkiye profile (Turkish characters, ₺ format, TC Kimlik, KVKK...) */
  region?: 'tr';
  name: string;
  description: string;
  priority: 'critical' | 'high' | 'medium';
  files: string[];
  steps: Step[];
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

export interface Summary {
  files: number;
  flows: number;
  passed: number;
  failed: number;
  coverage: number;
  durationMs: number;
}

export type LogLevel = 'info' | 'warn' | 'error' | 'success' | 'ai';

export type ScanEvent =
  | { type: 'scan_start'; repo: string; branch: string; totalFiles: number }
  | { type: 'file'; path: string }
  | { type: 'flow'; flow: Flow }
  | { type: 'log'; level: LogLevel; message: string }
  | { type: 'test_start'; flowId: string }
  | { type: 'step'; flowId: string; stepId: string; status: StepStatus; screenshot?: string; pageUrl?: string }
  | { type: 'test_result'; flowId: string; status: 'passed' | 'failed'; durationMs: number; failure?: Failure; healed?: Healing[] }
  | { type: 'tr_audit'; report: TrAuditReport }
  | { type: 'done'; summary: Summary };

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

/** A test step that failed, was rewritten against the real page and then passed (self-healing). */
export interface Healing {
  stepId: string;
  stepLabel: string;
  /** one sentence: what changed on the page */
  reason: string;
  before: string;
  after: string;
}
