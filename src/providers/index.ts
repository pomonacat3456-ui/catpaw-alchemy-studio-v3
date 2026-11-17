import { HttpError, type Env, type JobRow } from "../types";
import { liveAllowed } from "../lib/validate";

export interface SubmitResult { providerTaskId: string; mock: boolean }
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
 * Live adapter: FAILS CLOSED. It refuses unless ENVIRONMENT=production, LIVE_PROVIDERS_ENABLED=true
 * and an owner approval id are all present — and even then this rebuild ships NO live HTTP code
 * path (P4: needs a reviewed PR + owner approval for a single paid test).
 */
export class LiveAdapter implements ProviderAdapter {
  mock = false;
  constructor(public name: string, private env: Env) {}
  async submit(_job: JobRow, _attempt: number): Promise<SubmitResult> {
    const gate = liveAllowed(this.env);
    if (!gate.allowed) throw new HttpError(403, "live_provider_blocked", { reason: gate.reason, provider: this.name });
    throw new HttpError(501, "live_provider_not_implemented", { provider: this.name, note: "pending owner-approved P4 integration" });
  }
}

export function getAdapter(job: JobRow, env: Env): ProviderAdapter {
  return job.mode === "live" ? new LiveAdapter(job.provider, env) : new MockAdapter(job.provider);
}
