/**
 * RunningHub OpenAPI client (MiniMax H3 image-to-video, workflow mode).
 * Mirrors the verified Python adapter in ai-music-studio-v2 (providers/runninghub_h3_adapter.py):
 *   accountStatus  POST /uc/openapi/accountStatus {apikey}           (free, read-only)
 *   upload         POST /task/openapi/upload multipart {apiKey,file,fileType=input}
 *   create         POST /task/openapi/create {apiKey, workflowId, nodeInfoList}   (PAID)
 *   outputs        POST /task/openapi/outputs {apiKey, taskId}  code 0=done, 804/813=running/queued, 805=failed
 * The API key is never returned, logged or stored; error messages are scrubbed.
 */
export const DEFAULT_H3_WORKFLOW_ID = "2114090140428013570"; // 「貓掌江湖｜H3 API 單圖｜5秒低解析測試」
export const VIDEO_TYPES = ["mp4", "mov", "webm"];
export const IMAGE_TYPES = ["png", "jpg", "jpeg", "webp"];
/** RunningHub AI app 「全能图片V1」 (Nano Banana single-image edit), callable with consumer-member keys (points). */
export const DEFAULT_NB_WEBAPP_ID = "1960491621961953282";
export function nbNodeInfo(fileName: string, prompt: string, width = 900, height = 1600) {
  return [
    { nodeId: "4", fieldName: "image", fieldValue: fileName },
    { nodeId: "17", fieldName: "text", fieldValue: prompt },
    { nodeId: "13", fieldName: "height", fieldValue: String(height) },
    { nodeId: "13", fieldName: "width", fieldValue: String(width) },
  ];
}

/** Swappable for tests (mocked fetch). Production uses global fetch. */
export const providerDeps: { fetch: typeof fetch } = { fetch: (...a: Parameters<typeof fetch>) => fetch(...a) };

export class ProviderError extends Error {
  constructor(public code: string, public detail?: unknown) { super(code); }
}

/** remainCoins (RH幣) and remainPoint (plan 點數) are SEPARATE pools; NORMAL (consumer) keys settle workflow tasks in POINT. */
export interface Balance { remainCoins: number; remainPoint?: number | null; remainMoney: string | null; currency: string | null; currentTaskCounts: number | null; apiType?: string | null }
export type OutputsResult =
  | { status: "running"; code: number }
  | { status: "failed"; code: number; reason: string }
  | { status: "succeeded"; fileUrl: string; fileType: string; consumeCoins: number | null; taskCostTime: string | null;
      settleMode?: string | null; chargedPoint?: number | null; consumeMoney?: string | null };

export function h3NodeInfo(fileName: string, prompt: string, durationSec: number) {
  const [w, h] = [768, 1344]; // 9:16
  const length = Math.max(24, Math.round(durationSec * 24));
  return [
    { nodeId: "241", fieldName: "image", fieldValue: fileName },
    { nodeId: "213", fieldName: "value", fieldValue: prompt },
    { nodeId: "197", fieldName: "value", fieldValue: String(durationSec) },
    { nodeId: "199", fieldName: "width", fieldValue: String(w) },
    { nodeId: "199", fieldName: "height", fieldValue: String(h) },
    { nodeId: "199", fieldName: "length", fieldValue: String(length) },
  ];
}

export class RunningHubClient {
  constructor(private apiKey: string, private baseUrl = "https://www.runninghub.ai") {
    if (!apiKey) throw new ProviderError("provider_key_missing");
  }
  private scrub(s: unknown): string {
    return String(s ?? "").split(this.apiKey).join("***").slice(0, 300);
  }
  private async postJson(path: string, body: Record<string, unknown>): Promise<any> {
    const r = await providerDeps.fetch(this.baseUrl + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new ProviderError("provider_http_error", { path, status: r.status });
    return r.json();
  }
  async accountStatus(): Promise<Balance> {
    const p = await this.postJson("/uc/openapi/accountStatus", { apikey: this.apiKey });
    if (p?.code !== 0 || !p.data) throw new ProviderError("provider_balance_error", { code: p?.code, msg: this.scrub(p?.msg) });
    const n = Number(p.data.remainCoins);
    if (!Number.isFinite(n)) throw new ProviderError("provider_balance_unparseable");
    return {
      remainCoins: n,
      remainPoint: p.data.remainPoint != null && Number.isFinite(Number(p.data.remainPoint)) ? Number(p.data.remainPoint) : null,
      remainMoney: p.data.remainMoney ?? null,
      apiType: p.data.apiType ?? null,
      currency: p.data.currency ?? null,
      currentTaskCounts: p.data.currentTaskCounts != null ? Number(p.data.currentTaskCounts) : null,
    };
  }
  async upload(bytes: ArrayBuffer, filename: string): Promise<string> {
    const fd = new FormData();
    fd.append("apiKey", this.apiKey);
    fd.append("fileType", "input");
    fd.append("file", new Blob([bytes]), filename);
    const r = await providerDeps.fetch(this.baseUrl + "/task/openapi/upload", { method: "POST", body: fd });
    if (!r.ok) throw new ProviderError("provider_upload_http_error", { status: r.status });
    const p: any = await r.json();
    const name = p?.data?.fileName;
    if (p?.code !== 0 || !name) throw new ProviderError("provider_upload_failed", { code: p?.code, msg: this.scrub(p?.msg) });
    return String(name);
  }
  /** PAID. Only called by the live adapter after every gate passed. */
  async createTask(workflowId: string, nodeInfoList: unknown[]): Promise<string> {
    const p = await this.postJson("/task/openapi/create", { apiKey: this.apiKey, workflowId, nodeInfoList, addMetadata: true });
    const taskId = p?.data?.taskId;
    if (p?.code !== 0 || !taskId) throw new ProviderError("provider_create_failed", { code: p?.code, msg: this.scrub(p?.msg) });
    return String(taskId);
  }
  /** PAID. Run a RunningHub AI app (webapp) task. */
  async runApp(webappId: string, nodeInfoList: unknown[]): Promise<string> {
    const p = await this.postJson("/task/openapi/ai-app/run", { apiKey: this.apiKey, webappId, nodeInfoList });
    const taskId = p?.data?.taskId;
    if (p?.code !== 0 || !taskId) throw new ProviderError("provider_create_failed", { code: p?.code, msg: this.scrub(p?.msg) });
    return String(taskId);
  }
  async outputs(taskId: string, types: string[] = VIDEO_TYPES): Promise<OutputsResult> {
    const p = await this.postJson("/task/openapi/outputs", { apiKey: this.apiKey, taskId });
    const code = Number(p?.code);
    if (code === 805) {
      const fr = p?.data?.failedReason;
      const reason = fr && typeof fr === "object"
        ? [fr.node_name, fr.exception_message].filter(Boolean).join(": ") || JSON.stringify(fr).slice(0, 300)
        : fr ?? p?.msg ?? "failed";
      return { status: "failed", code, reason: this.scrub(reason) };
    }
    if (code === 0 && Array.isArray(p.data) && p.data.length) {
      const v = p.data.find((d: any) => types.includes(String(d.fileType ?? "").toLowerCase()) ||
        types.some((e) => String(d.fileUrl ?? "").toLowerCase().split("?")[0].endsWith("." + e)));
      if (!v) return { status: "failed", code, reason: types === VIDEO_TYPES ? "no_video_output" : "no_image_output" };
      return {
        status: "succeeded",
        fileUrl: String(v.fileUrl),
        fileType: String(v.fileType ?? (types === VIDEO_TYPES ? "mp4" : "png")),
        consumeCoins: v.consumeCoins != null ? Number(v.consumeCoins) : null,
        taskCostTime: v.taskCostTime != null ? String(v.taskCostTime) : null,
        settleMode: v.settleMode != null ? String(v.settleMode) : null,
        chargedPoint: v.chargedPoint != null && Number.isFinite(Number(v.chargedPoint)) ? Number(v.chargedPoint) : null,
        consumeMoney: v.consumeMoney != null ? String(v.consumeMoney) : null,
      };
    }
    return { status: "running", code };
  }
}
