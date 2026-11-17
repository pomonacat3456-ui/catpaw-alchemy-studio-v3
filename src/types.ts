export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  ENVIRONMENT: string; // "staging" | "test" | "production"
  PUBLIC_ORIGIN?: string; // e.g. https://catpaw-alchemy-v3.gogototo24.workers.dev (own public CANON path read via R2)
  LIVE_PROVIDERS_ENABLED?: string; // must be exactly "true" AND not staging AND owner approval id set
  OWNER_LIVE_APPROVAL_ID?: string;
  PUBLISH_GATE_ENABLED?: string; // publisher is not implemented in this build; always fail-closed
  BUDGET_SCOPE?: string;
  MAX_ATTEMPTS?: string;
  RUNNING_TIMEOUT_SEC?: string;
  MAX_JOB_CREDITS?: string;
  ADMIN_KEY?: string; // secret
  CALLBACK_HMAC_SECRET?: string; // secret
  // --- live provider (production only, all fail-closed) ---
  RUNNINGHUB_API_KEY?: string; // secret
  RUNNINGHUB_BASE_URL?: string;
  RUNNINGHUB_H3_WORKFLOW_ID?: string;
  LIVE_MAX_SUBMISSIONS?: string; // total live submissions ever allowed per provider (default 1)
  LIVE_MAX_SUBMISSIONS_B?: string; // line B (runninghub-nb) live submissions allowed in total (default 0 = closed)
  LIVE_B_BUDGET_SCOPE?: string; // default production-live-b (RunningHub points)
  LIVE_POINTS_IMAGE?: string; // points estimate per B image (default 20)
  RUNNINGHUB_QWEN_WEBAPP_ID?: string; // default 1977675852563513346 (Qwen Image Edit2509 app)
  RUNNINGHUB_NB_WEBAPP_ID?: string; // default 1960491621961953282 「全能图片V1」
  LIVE_BUDGET_SCOPE?: string; // default production-live (RunningHub coins)
  LIVE_COINS_5S?: string; // estimate per 5s H3 segment
  LIVE_COINS_15S?: string;
  LIVE_POINTS_5S?: string; // plan 點數 estimate per 5s H3 segment (observed 54.23)
  LIVE_POINTS_15S?: string;
  LIVE_MANUAL_POINTS_BALANCE?: string; // only if the API stops returning remainPoint: owner-provided balance
  LIVE_MAX_JOB_COINS?: string;
  LIVE_TIMEOUT_SEC?: string;
  ASSETS_BUCKET?: R2Bucket;
  // --- PixVerse native OpenAPI (production only, fail-closed) ---
  PIXVERSE_API_KEY?: string; // secret
  PIXVERSE_BASE_URL?: string; // default https://app-api.pixverse.ai/openapi/v2
  PIXVERSE_MODEL?: string; // default v6-max
  PIXVERSE_QUALITY?: string; // default 540p
  LIVE_PIXVERSE_CREDITS_5S?: string; // estimate (v6-max 540p 5s audio off = 45 credits, observed 2026-11-17)
  LIVE_PIXVERSE_CREDITS_15S?: string;
  LIVE_PIXVERSE_MAX_CREDITS?: string; // hard cap reported by the provider per job
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
  live_approval_ref?: string | null;
  provider_meta_json?: string | null;
  result_url?: string | null;
  result_r2_key?: string | null;
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
  negative_prompt?: string; // built by the A-line prompt builder; never checked against FORBIDDEN terms (it lists them)
  provider?: string; // optional override for line A: "runninghub-h3" (default) | "pixverse"
  prompt_builder?: string; // e.g. "a-line-v2" / "b-line-v1" when the prompt was built server-side from `look`
  client_ref?: string;
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code);
  }
}
