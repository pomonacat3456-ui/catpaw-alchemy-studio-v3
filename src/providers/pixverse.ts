/**
 * PixVerse native OpenAPI v2 client (image-to-video). Mirrors the verified Python adapter
 * ai-music-studio-v2/providers/pixverse_video_adapter.py (paid runs 2026-11-01..04):
 *   balance   GET  /account/balance                      (free)  Resp.credit_monthly + credit_package
 *   upload    POST /image/upload  multipart "image"       (free)  Resp.img_id
 *   generate  POST /video/img/generate  JSON              (PAID)  Resp.video_id, Resp.credits
 *   result    GET  /video/result/{video_id}               (free)  Resp.status 1=done(url) 5=generating 7=moderation 8=failed
 * Headers: API-KEY, Ai-trace-id (fresh UUID per request). The key is never returned, logged or stored.
 */
import { ProviderError, providerDeps } from "./runninghub";

export const PIXVERSE_DEFAULT_BASE = "https://app-api.pixverse.ai/openapi/v2";

export interface PixBalance { credits: number; credit_monthly: number; credit_package: number }
export type PixResult =
  | { status: "running"; code: number }
  | { status: "failed"; code: number; reason: string }
  | { status: "succeeded"; fileUrl: string; credits: number | null; width: number | null; height: number | null; seed: number | null };

export interface PixGenerate {
  model: string; prompt: string; negative_prompt?: string; duration: number; quality: string; img_id: number;
  aspect_ratio?: string; generate_audio_switch: boolean; seed?: number;
}

export function pixGeneratePayload(o: { imgId: number; prompt: string; negative?: string; seconds: number; model?: string; quality?: string }): PixGenerate {
  if (!o.prompt.trim()) throw new ProviderError("pixverse_prompt_required");
  if (!(o.seconds >= 1 && o.seconds <= 15)) throw new ProviderError("pixverse_duration_out_of_range");
  return {
    model: o.model || "v6-max",
    prompt: o.prompt.slice(0, 2048),
    ...(o.negative ? { negative_prompt: o.negative.slice(0, 2048) } : {}),
    duration: o.seconds,
    quality: o.quality || "540p",
    img_id: o.imgId,
    aspect_ratio: "9:16",
    generate_audio_switch: false,
  };
}

export class PixVerseClient {
  constructor(private apiKey: string, private baseUrl = PIXVERSE_DEFAULT_BASE) {
    if (!apiKey) throw new ProviderError("provider_key_missing", { provider: "pixverse" });
  }
  private scrub(s: unknown): string {
    return String(s ?? "").split(this.apiKey).join("***").slice(0, 300);
  }
  private headers(json = false): Record<string, string> {
    return { "API-KEY": this.apiKey, "Ai-trace-id": crypto.randomUUID(), ...(json ? { "content-type": "application/json" } : {}) };
  }
  private async body(r: Response, path: string): Promise<any> {
    if (!r.ok) throw new ProviderError("provider_http_error", { provider: "pixverse", path, status: r.status });
    return r.json();
  }
  async balance(): Promise<PixBalance> {
    const p = await this.body(await providerDeps.fetch(this.baseUrl + "/account/balance", { headers: this.headers() }), "/account/balance");
    if (p?.ErrCode !== 0) throw new ProviderError("provider_balance_error", { provider: "pixverse", code: p?.ErrCode, msg: this.scrub(p?.ErrMsg) });
    const m = Number(p.Resp?.credit_monthly ?? 0), k = Number(p.Resp?.credit_package ?? 0);
    if (!Number.isFinite(m) || !Number.isFinite(k)) throw new ProviderError("provider_balance_unparseable");
    return { credits: m + k, credit_monthly: m, credit_package: k };
  }
  async upload(bytes: ArrayBuffer, filename: string, contentType: string): Promise<number> {
    const fd = new FormData();
    fd.append("image", new Blob([bytes], { type: contentType }), filename);
    const p = await this.body(await providerDeps.fetch(this.baseUrl + "/image/upload", { method: "POST", headers: this.headers(), body: fd }), "/image/upload");
    const id = Number(p?.Resp?.img_id);
    if (p?.ErrCode !== 0 || !id) throw new ProviderError("provider_upload_failed", { provider: "pixverse", code: p?.ErrCode, msg: this.scrub(p?.ErrMsg) });
    return id;
  }
  /** PAID. Only called by the live adapter after every gate passed. */
  async generate(payload: PixGenerate): Promise<{ videoId: string; credits: number | null }> {
    const p = await this.body(await providerDeps.fetch(this.baseUrl + "/video/img/generate", {
      method: "POST", headers: this.headers(true), body: JSON.stringify(payload),
    }), "/video/img/generate");
    const vid = p?.Resp?.video_id;
    if (p?.ErrCode !== 0 || !vid) throw new ProviderError("provider_create_failed", { provider: "pixverse", code: p?.ErrCode, msg: this.scrub(p?.ErrMsg) });
    return { videoId: String(vid), credits: p.Resp.credits != null ? Number(p.Resp.credits) : null };
  }
  async result(videoId: string): Promise<PixResult> {
    if (!/^\d+$/.test(videoId)) throw new ProviderError("pixverse_bad_video_id");
    const p = await this.body(await providerDeps.fetch(`${this.baseUrl}/video/result/${videoId}`, { headers: this.headers() }), "/video/result");
    if (p?.ErrCode !== 0) throw new ProviderError("provider_result_error", { provider: "pixverse", code: p?.ErrCode, msg: this.scrub(p?.ErrMsg) });
    const r = p.Resp ?? {};
    const st = Number(r.status ?? 0);
    if (st === 1) {
      if (!r.url) return { status: "failed", code: st, reason: "no_video_url" };
      const n = (v: unknown) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
      return { status: "succeeded", fileUrl: String(r.url), credits: n(r.credits), width: n(r.outputWidth), height: n(r.outputHeight), seed: n(r.seed) };
    }
    if (st === 7) return { status: "failed", code: st, reason: "moderation_failed" };
    if (st === 8) return { status: "failed", code: st, reason: this.scrub(r.message ?? r.error ?? "generation_failed") };
    return { status: "running", code: st };
  }
}
