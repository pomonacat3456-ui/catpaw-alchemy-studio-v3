/** Minimal MP4 (ISO-BMFF) probe for automated technical QA: no decoding, just box headers. */
export interface Mp4Info { duration: number; width: number; height: number; brand: string }

function boxes(dv: DataView, start: number, end: number): { type: string; start: number; size: number; hdr: number }[] {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const type = String.fromCharCode(dv.getUint8(p + 4), dv.getUint8(p + 5), dv.getUint8(p + 6), dv.getUint8(p + 7));
    let hdr = 8;
    if (size === 1) { if (p + 16 > end) break; size = Number(dv.getBigUint64(p + 8)); hdr = 16; }
    else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) break;
    out.push({ type, start: p, size, hdr });
    p += size;
  }
  return out;
}

export function probeMp4(buf: ArrayBuffer): Mp4Info | null {
  const dv = new DataView(buf);
  const top = boxes(dv, 0, buf.byteLength);
  const ftyp = top.find((b) => b.type === "ftyp");
  const moov = top.find((b) => b.type === "moov");
  if (!ftyp || !moov) return null;
  const brand = String.fromCharCode(...new Uint8Array(buf, ftyp.start + 8, 4));
  const inner = boxes(dv, moov.start + moov.hdr, moov.start + moov.size);
  const mvhd = inner.find((b) => b.type === "mvhd");
  if (!mvhd) return null;
  const m = mvhd.start + mvhd.hdr, v = dv.getUint8(m);
  const timescale = v === 1 ? dv.getUint32(m + 20) : dv.getUint32(m + 12);
  const dur = v === 1 ? Number(dv.getBigUint64(m + 24)) : dv.getUint32(m + 16);
  let width = 0, height = 0;
  for (const trak of inner.filter((b) => b.type === "trak")) {
    const tb = boxes(dv, trak.start + trak.hdr, trak.start + trak.size);
    const tkhd = tb.find((b) => b.type === "tkhd");
    if (!tkhd) continue;
    const t = tkhd.start + tkhd.hdr, tv = dv.getUint8(t);
    const off = t + (tv === 1 ? 88 : 76);
    if (off + 8 > tkhd.start + tkhd.size) continue;
    const w = dv.getUint32(off) / 65536, h = dv.getUint32(off + 4) / 65536;
    if (w > 0 && h > 0) { width = Math.round(w); height = Math.round(h); break; }
  }
  if (!timescale) return null;
  return { duration: dur / timescale, width, height, brand };
}

/** Technical-only video QA: decodable MP4, duration ~expected, ~9:16, adequate size. */
export function autoVideoQa(buf: ArrayBuffer, opts: { seconds?: number; durTol?: number; minShort?: number; tol?: number } = {}) {
  const { seconds = 5, durTol = 0.6, minShort = 512, tol = 0.04 } = opts;
  const failed: string[] = [];
  const bytes = buf.byteLength;
  const info = bytes >= 50_000 ? probeMp4(buf) : null;
  if (bytes < 50_000) failed.push(`file_too_small:${bytes}`);
  else if (!info || !info.width) failed.push("not_a_decodable_mp4");
  if (info && info.width) {
    if (Math.abs(info.duration - seconds) > durTol) failed.push(`duration_off:${info.duration.toFixed(2)}s`);
    const r = info.width / info.height, want = 9 / 16;
    if (Math.abs(r - want) / want > tol) failed.push(`aspect_not_9:16:${info.width}x${info.height}`);
    if (Math.min(info.width, info.height) < minShort) failed.push(`resolution_too_low:${info.width}x${info.height}`);
  }
  return { ok: failed.length === 0, failed, info, bytes };
}
