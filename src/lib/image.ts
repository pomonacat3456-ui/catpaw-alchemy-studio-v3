/** Minimal image sniffing for automated B-line QA (no decoding): format + dimensions from the header. */
export interface ImageInfo { format: "png" | "jpeg" | "webp"; width: number; height: number }

export function sniffImage(buf: ArrayBuffer): ImageInfo | null {
  const b = new Uint8Array(buf);
  const dv = new DataView(buf);
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return { format: "png", width: dv.getUint32(16), height: dv.getUint32(20) };
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      const len = dv.getUint16(i + 2);
      if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
        return { format: "jpeg", height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      i += 2 + len;
    }
    return null;
  }
  if (b.length >= 30 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") {
    const chunk = String.fromCharCode(...b.slice(12, 16));
    if (chunk === "VP8X") return { format: "webp", width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (chunk === "VP8 ") return { format: "webp", width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
    if (chunk === "VP8L") { const v = dv.getUint32(21, true); return { format: "webp", width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 }; }
  }
  return null;
}

/**
 * Automated B-line QA (owner 2026-11-17: content accepted as-is for MZ_003; check only technical faults):
 * decodable header, min short side, 9:16 within tolerance, sane byte size.
 */
export function autoImageQa(buf: ArrayBuffer, opts: { minShort?: number; tol?: number } = {}) {
  const failed: string[] = [];
  const info = sniffImage(buf);
  if (buf.byteLength < 10 * 1024) failed.push("file_too_small");
  if (!info) failed.push("not_a_decodable_image");
  else {
    if (Math.min(info.width, info.height) < (opts.minShort ?? 512)) failed.push(`resolution_too_low_${info.width}x${info.height}`);
    const r = info.width / info.height;
    if (Math.abs(r - 9 / 16) / (9 / 16) > (opts.tol ?? 0.03)) failed.push(`aspect_not_9:16_${info.width}x${info.height}`);
  }
  return { ok: failed.length === 0, failed, info, bytes: buf.byteLength };
}
