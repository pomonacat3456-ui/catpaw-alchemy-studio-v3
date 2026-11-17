#!/usr/bin/env python3
"""Cheap CANON palette sanity check (heuristic, non-blocking flag for human review).

Segments the character with rembg (u2net), takes the top 35% of the character mask
(head + hair), and measures the share of saturated red pixels vs near-white pixels.
MZ_003 焚天赤焰喵 has long red hair: a low red share or a high white share flags
`palette_drift` (e.g. B run5 turned white-haired). For videos, 3 frames are sampled
(mean red over frames, max white).

usage: palette_check.py <image|video> [...]   -> one JSON line per file
"""
import colorsys, json, os, subprocess, sys, tempfile
import numpy as np
from PIL import Image

RED_MIN, WHITE_MAX = 0.55, 0.08  # calibrated on MZ_003: master .96/.00, B4 .74/.00, B6 .71/.02, B5 (white hair) .46/.12
_S = None

def stats(im):
    global _S
    from rembg import remove, new_session
    _S = _S or new_session("u2net")
    im = im.convert("RGB"); im.thumbnail((360, 640))
    mask = np.array(remove(im, session=_S, only_mask=True)) > 128
    ys, _ = np.where(mask)
    if len(ys) < 500: return None
    top, bot = ys.min(), ys.max()
    band = np.zeros_like(mask); band[top: top + int((bot - top) * 0.35)] = True
    px = (np.array(im) / 255.0)[mask & band][::3]
    hsv = np.array([colorsys.rgb_to_hsv(*c) for c in px])
    red = ((hsv[:, 0] < 0.06) | (hsv[:, 0] > 0.94)) & (hsv[:, 1] > 0.45) & (hsv[:, 2] > 0.25)
    white = (hsv[:, 1] < 0.2) & (hsv[:, 2] > 0.7)
    return {"red": round(float(red.mean()), 3), "white": round(float(white.mean()), 3)}

def frames(path):
    d = tempfile.mkdtemp()
    for i, t in enumerate((0.8, 2.5, 4.2)):
        subprocess.run(["ffmpeg", "-v", "error", "-ss", str(t), "-i", path, "-frames:v", "1", f"{d}/f{i}.png"], check=False)
    return [Image.open(f"{d}/{f}") for f in sorted(os.listdir(d))]

def check(path):
    ims = frames(path) if path.lower().endswith((".mp4", ".mov", ".webm")) else [Image.open(path)]
    per = [stats(im) for im in ims]
    ok = [s for s in per if s]
    red = round(sum(s["red"] for s in ok) / len(ok), 3) if ok else 0.0
    white = max((s["white"] for s in ok), default=1.0)
    return {"file": os.path.basename(path), "palette_ok": bool(ok) and red >= RED_MIN and white <= WHITE_MAX,
            "red_mean": red, "white_max": white, "frames": per,
            "rule": f"head/hair band: mean red>={RED_MIN} and max white<={WHITE_MAX}", "blocking": False}

if __name__ == "__main__":
    for p in sys.argv[1:]: print(json.dumps(check(p), ensure_ascii=False))
