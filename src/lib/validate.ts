import { HttpError, type Env, type JobSpec, type Line, type Mode } from "../types";

export const LINES: Record<Line, { name: string; kind: "video" | "image"; minSeg: number; maxSeg: number }> = {
  A: { name: "A 短影音（貓掌江湖／喵台灣）", kind: "video", minSeg: 1, maxSeg: 3 },
  B: { name: "B 寫真圖片", kind: "image", minSeg: 0, maxSeg: 0 },
  C: { name: "C 音樂 MV", kind: "video", minSeg: 1, maxSeg: 16 },
  D: { name: "D 長片漫劇", kind: "video", minSeg: 2, maxSeg: 40 },
};

export const ALLOWED_SEGMENT_SECONDS = [5, 15];
export const REQUIRED_ASPECT = "9:16";

/** Terms that violate the character spec (no human faces/hands, no extra fingers, no male cats). */
export const FORBIDDEN_PROMPT_TERMS = [
  "人臉", "人手", "真人", "多指", "六指", "公貓", "雄貓", "男性", "male", "human face", "human hand", "extra fingers", "tomcat",
];

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Shape validation only (400 on malformed input). Business rules are checked in preflight. */
export function parseSpec(body: any): JobSpec {
  if (!body || typeof body !== "object") throw new HttpError(400, "invalid_json_body");
  const line = body.line as Line;
  if (!["A", "B", "C", "D"].includes(line)) throw new HttpError(400, "invalid_line", { allowed: ["A", "B", "C", "D"] });
  const mode = (body.mode ?? "mock") as Mode;
  if (!["mock", "live"].includes(mode)) throw new HttpError(400, "invalid_mode");
  const protagonist = str(body.protagonist);
  if (!protagonist) throw new HttpError(400, "missing_protagonist");
  const castIn = Array.isArray(body.cast) ? body.cast.filter((x: unknown) => typeof x === "string" && x.trim()).map((x: string) => x.trim()) : [];
  const cast = [...new Set([protagonist, ...castIn])].sort();
  const segments = Array.isArray(body.segments) ? body.segments.map((n: unknown) => Number(n)) : [];
  if (segments.some((n: number) => !Number.isFinite(n))) throw new HttpError(400, "invalid_segments");
  const images = body.images === undefined ? 0 : Number(body.images);
  if (!Number.isInteger(images) || images < 0) throw new HttpError(400, "invalid_images");
  const prompt = str(body.prompt) ?? "";
  if (prompt.length > 4000) throw new HttpError(400, "prompt_too_long");
  return {
    line,
    mode,
    title: str(body.title),
    protagonist,
    cast,
    master_url: str(body.master_url),
    aspect: str(body.aspect) ?? REQUIRED_ASPECT,
    segments,
    images,
    audio_ref: str(body.audio_ref),
    prompt,
    client_ref: str(body.client_ref),
  };
}

export interface CanonRow {
  id: string;
  display_name: string;
  sex: string;
  species: string;
  master_url: string;
  approved: number;
  source: string;
}

/** Duration / format rules per line. Returns list of blocking reasons. */
export function checkFormat(spec: JobSpec): string[] {
  const r: string[] = [];
  const L = LINES[spec.line];
  if (spec.aspect !== REQUIRED_ASPECT) r.push(`aspect_must_be_9:16`);
  if (L.kind === "image") {
    if (spec.segments.length) r.push("line_B_has_no_video_segments");
    if (spec.images < 1 || spec.images > 8) r.push("line_B_images_must_be_1_to_8");
  } else {
    if (spec.images) r.push(`line_${spec.line}_images_not_allowed`);
    if (spec.segments.length < L.minSeg || spec.segments.length > L.maxSeg)
      r.push(`line_${spec.line}_segment_count_${L.minSeg}_to_${L.maxSeg}`);
    for (const s of spec.segments) if (!ALLOWED_SEGMENT_SECONDS.includes(s)) { r.push(`invalid_duration_${s}s_allowed_5_or_15`); break; }
    if (spec.line === "C" && !spec.audio_ref) r.push("line_C_requires_audio_ref");
  }
  return r;
}

/**
 * CANON gate: every cast member must be a registered, approved, female cat;
 * the job must carry the protagonist's approved Master URL exactly; prompt must not
 * request forbidden features.
 */
export function checkCanon(spec: JobSpec, canon: Map<string, CanonRow>): string[] {
  const r: string[] = [];
  for (const id of spec.cast) {
    const c = canon.get(id);
    if (!c) { r.push(`canon_unregistered_character:${id}`); continue; }
    if (c.sex !== "female") r.push(`canon_all_female_rule_violated:${id}`);
    if (c.species !== "cat") r.push(`canon_not_a_cat:${id}`);
    if (!c.approved) r.push(`canon_character_not_approved:${id}`);
  }
  const p = canon.get(spec.protagonist);
  if (!spec.master_url) r.push("canon_missing_master_url");
  else if (!/^https:\/\//.test(spec.master_url)) r.push("canon_master_url_must_be_https");
  else if (p && p.master_url !== spec.master_url) r.push("canon_master_url_not_the_approved_master");
  const lower = spec.prompt.toLowerCase();
  for (const t of FORBIDDEN_PROMPT_TERMS) if (lower.includes(t.toLowerCase())) r.push(`canon_forbidden_term:${t}`);
  return r;
}

export function liveAllowed(env: Env): { allowed: boolean; reason?: string } {
  if (env.ENVIRONMENT !== "production") return { allowed: false, reason: `live_providers_disabled_in_${env.ENVIRONMENT || "unknown"}` };
  if (env.LIVE_PROVIDERS_ENABLED !== "true") return { allowed: false, reason: "live_providers_not_enabled" };
  if (!env.OWNER_LIVE_APPROVAL_ID) return { allowed: false, reason: "owner_live_approval_missing" };
  return { allowed: true };
}
