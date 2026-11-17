import type { JobState } from "../types";

/** Unified state machine for all four lines. */
export const TRANSITIONS: Record<JobState, JobState[]> = {
  draft: ["preflight", "cancelled"],
  preflight: ["blocked", "ready"],
  blocked: ["preflight", "cancelled"],
  ready: ["queued", "cancelled"],
  queued: ["running", "cancelled"],
  running: ["qa", "queued", "failed", "cancelled"],
  qa: ["review", "queued", "failed", "cancelled"],
  review: ["approved", "queued", "failed", "cancelled"],
  approved: ["delivered", "cancelled"],
  delivered: [],
  failed: [],
  cancelled: [],
};

export const TERMINAL: JobState[] = ["delivered", "failed", "cancelled"];

export function canTransition(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}
