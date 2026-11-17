import type { JobSpec } from "../types";

/**
 * Mock credit estimate (staging-only accounting unit, NOT real money).
 * 5s segment = 1 credit (cheap test), 15s segment = 3 credits (formal),
 * B line image = 1 credit each, C line music track +2.
 */
export function estimateCredits(spec: JobSpec): number {
  if (spec.line === "B") return spec.images;
  let c = 0;
  for (const s of spec.segments) c += s === 15 ? 3 : 1;
  if (spec.line === "C") c += 2;
  return c;
}
