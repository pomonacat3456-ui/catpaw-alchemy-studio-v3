export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  ENVIRONMENT: string; // "staging" | "test" | "production"
  LIVE_PROVIDERS_ENABLED?: string; // must be exactly "true" AND not staging AND owner approval id set
  OWNER_LIVE_APPROVAL_ID?: string;
  PUBLISH_GATE_ENABLED?: string; // publisher is not implemented in this build; always fail-closed
  BUDGET_SCOPE?: string;
  MAX_ATTEMPTS?: string;
  RUNNING_TIMEOUT_SEC?: string;
  MAX_JOB_CREDITS?: string;
  ADMIN_KEY?: string; // secret
  CALLBACK_HMAC_SECRET?: string; // secret
}

export type Line = "A" | "B" | "C" | "D";
export type Mode = "mock" | "live";

export type JobState =
  | "draft"
  | "preflight"
  | "blocked"
  | "ready"
  | "queued"
  | "running"
  | "qa"
  | "review"
  | "approved"
  | "delivered"
  | "failed"
  | "cancelled";

export interface JobRow {
  id: string;
  idempotency_key: string;
  line: Line;
  mode: Mode;
  provider: string;
  state: JobState;
  character_id: string;
  master_url: string | null;
  aspect: string;
  spec_json: string;
  estimated_credits: number;
  reserved_credits: number;
  spent_credits: number;
  paid: number;
  published: number;
  attempts: number;
  max_attempts: number;
  provider_task_id: string | null;
  blocked_reasons: string | null;
  qa_json: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  running_since: string | null;
  last_tx: string | null;
}

export interface JobSpec {
  line: Line;
  mode: Mode;
  title?: string;
  protagonist: string; // canon character id
  cast: string[]; // all canon character ids incl. protagonist
  master_url?: string;
  aspect: string;
  segments: number[]; // seconds per segment (A/C/D)
  images: number; // B only
  audio_ref?: string; // C only
  prompt: string;
  client_ref?: string;
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code);
  }
}
