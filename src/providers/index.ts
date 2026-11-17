import type { Env, JobRow } from "../types";
import { liveSubmit } from "../live";

export interface SubmitResult { providerTaskId: string; mock: boolean; meta?: unknown }
export interface ProviderAdapter {
  name: string;
  mock: boolean;
  submit(job: JobRow, attempt: number): Promise<SubmitResult>;
}

/** Provider used per line (RunningHub MiniMax H3 for video, PixVerse for B stills). */
export function providerForLine(line: string): string {
  return line === "B" ? "pixverse" : "runninghub-h3";
}

/** Mock adapter: no network I/O, deterministic task id, completion arrives via signed callback. */
export class MockAdapter implements ProviderAdapter {
  mock = true;
  constructor(public name: string) {}
  async submit(job: JobRow, attempt: number): Promise<SubmitResult> {
    return { providerTaskId: `mock-${this.name}-${job.id}-a${attempt}`, mock: true };
  }
}

/**
 * Live adapter: FAILS CLOSED. Refuses unless ENVIRONMENT=production, LIVE_PROVIDERS_ENABLED=true,
 * OWNER_LIVE_APPROVAL_ID set, the job carries a per-job owner approval, the global live submission cap
 * is not reached, the provider key exists, CANON is live-approved, and the provider balance covers the estimate.
 * Only RunningHub H3 (line A, single segment) is wired.
 */
export class LiveAdapter implements ProviderAdapter {
  mock = false;
  constructor(public name: string, private env: Env) {}
  async submit(job: JobRow, _attempt: number): Promise<SubmitResult> {
    return liveSubmit(this.env, job);
  }
}

export function getAdapter(job: JobRow, env: Env): ProviderAdapter {
  return job.mode === "live" ? new LiveAdapter(job.provider, env) : new MockAdapter(job.provider);
}
