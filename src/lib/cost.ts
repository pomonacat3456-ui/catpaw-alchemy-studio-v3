import type { Env, JobSpec } from "../types";

/**
 * MOCK jobs: staging/prod accounting unit "mock-credit" (NOT money).
 *   5s segment = 1, 15s segment = 3, B image = 1 each, C music track +2.
 * LIVE jobs: RunningHub coins (prepaid provider credits) estimate per H3 segment,
 *   defaults from observed past H3 runs (~322 coins / 5s, ~900 / 15s), rounded up.
 */
export function estimateCredits(spec: JobSpec, env?: Partial<Env>): number {
  if (spec.mode === "live" && spec.provider === "pixverse") {
    const c5 = Number(env?.LIVE_PIXVERSE_CREDITS_5S || 45);
    const c15 = Number(env?.LIVE_PIXVERSE_CREDITS_15S || 135);
    return spec.segments.reduce((a, s) => a + (s === 15 ? c15 : c5), 0);
  }
  if (spec.mode === "live") {
    const c5 = Number(env?.LIVE_COINS_5S || 350);
    const c15 = Number(env?.LIVE_COINS_15S || 950);
    return spec.segments.reduce((a, s) => a + (s === 15 ? c15 : c5), 0);
  }
  if (spec.line === "B") return spec.images;
  let c = 0;
  for (const s of spec.segments) c += s === 15 ? 3 : 1;
  if (spec.line === "C") c += 2;
  return c;
}

export function creditUnit(mode: string, provider?: string) {
  if (mode === "live" && provider === "pixverse") return "pixverse-credit";
  return mode === "live" ? "runninghub-coin" : "mock-credit";
}
