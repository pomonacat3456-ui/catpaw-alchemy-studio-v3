#!/usr/bin/env python3
"""Owner-approved live automation runner (production). One paid job per invocation.

balance check -> single-use CANON override -> create live job -> live-approve -> enqueue -> run (paid)
-> poll -> Worker downloads + stores in R2 + automated technical QA -> review (or failed)
-> local copy + palette sanity flag (non-blocking).

usage: autorun.py A <n> <approver> <approval_ref>          (PixVerse, a-line-v2)
       autorun.py B <n> <approver> <approval_ref> "<scene>"  (RunningHub Qwen edit, b-line-v1)
Admin key is read from $CATPAW_ADMIN_KEY_FILE and passed to curl via a 0600 config file (never argv/logs).
"""
import json, os, subprocess, sys, tempfile, time
BASE = os.environ.get("CATPAW_BASE", "https://catpaw-alchemy-v3.gogototo24.workers.dev")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MASTER = BASE + "/public/canon/MZ_003-master.png"
LOOK = {"name": "焚天赤焰喵", "fur": "白色長毛，臉頰赤焰紋", "eyes": "赤金色細長眼", "crown_hair": "赤金火焰王冠，長赤紅波浪髮",
        "costume": "黑金赤紅華麗女王戰袍，紅色長飄帶、金飾與紅寶石", "weapon": "未確認實體武器；火系術法", "magic": "fire magic"}

def adm(method, path, body=None, out=None):
    key = open(os.environ["CATPAW_ADMIN_KEY_FILE"]).read().strip()
    fd, cfg = tempfile.mkstemp(); os.chmod(cfg, 0o600); os.write(fd, f'header = "x-admin-key: {key}"\n'.encode()); os.close(fd)
    cmd = ["curl", "-sS", "-K", cfg, "-X", method, BASE + path]
    if body is not None: cmd += ["-H", "content-type: application/json", "--data", json.dumps(body, ensure_ascii=False)]
    if out: cmd += ["-o", out, "-w", "%{http_code}"]
    try: r = subprocess.run(cmd, capture_output=True, text=True, timeout=180).stdout
    finally: os.remove(cfg)
    return r if out else json.loads(r)

def main():
    line, n, approver, ref = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
    outdir = os.path.join(ROOT, "live-test", "lineA" if line == "A" else "lineB"); os.makedirs(outdir, exist_ok=True)
    logf = os.path.join(outdir, "run.log")
    def log(o):
        with open(logf, "a") as f: f.write(json.dumps(o, ensure_ascii=False) + "\n")
    prov = "pixverse" if line == "A" else "runninghub-qwen"
    bal = adm("GET", "/api/provider/balance" + ("?provider=pixverse" if line == "A" else ""))
    b = bal.get("balance", bal); before = b.get("credits") if line == "A" else b.get("remainPoint")
    need = 45 if line == "A" else 25
    print("balance_before", before)
    if before is None or float(before) < need: log({"run": n, "stop": "insufficient_or_unknown_balance", "balance": before}); sys.exit(4)
    ov = adm("POST", "/api/admin/canon/live-override", {"character_id": "MZ_003", "master_url": MASTER, "approver": approver,
             "reason": f"line {line} automation run {n}: {ref}", "ttl_hours": 1})
    body = {"line": line, "mode": "live", "protagonist": "MZ_003", "master_url": MASTER, "auto_preflight": True, "provider": prov,
            "look": LOOK, "client_ref": f"line{line}-auto-2026-11-17-{n}"}
    body.update({"segments": [5], "images": 0} if line == "A" else {"images": 1, "scene": sys.argv[5]})
    j = adm("POST", "/api/jobs", body); job = j.get("job", j); jid = job.get("jobId")
    print("job", jid, job.get("state"), job.get("blocked_reasons"), j.get("error"))
    log({"run": n, "override": (ov.get("override") or ov).get("id"), "jobId": jid, "state": job.get("state"), "blocked": job.get("blocked_reasons")})
    if job.get("state") != "ready": sys.exit(2)
    adm("POST", f"/api/jobs/{jid}/live-approve", {"approval_ref": ref})
    adm("POST", f"/api/jobs/{jid}/enqueue")
    r = adm("POST", f"/api/jobs/{jid}/run"); rj = r.get("job", r)
    print("run", rj.get("state"), rj.get("provider_task_id"), r.get("error"), r.get("detail"))
    if rj.get("state") != "running": log({"run": n, "jobId": jid, "run_error": r.get("error"), "detail": r.get("detail")}); sys.exit(3)
    for _ in range(60):
        time.sleep(15)
        p = adm("POST", f"/api/jobs/{jid}/poll")
        if p.get("status") != "running": break
    d = adm("GET", f"/api/jobs/{jid}"); m = d.get("provider_meta") or {}
    bb, ba = m.get("balance_before") or {}, m.get("balance_after") or {}
    info = {"run": n, "line": line, "jobId": jid, "task": d.get("provider_task_id"), "state": d.get("state"), "r2": d.get("result_r2_key"),
            "last_error": d.get("last_error"), "auto_qa": m.get("auto_qa"), "costs": [c for c in d.get("costs", []) if c.get("paid")],
            "balance_before": bb.get("credits", bb.get("remainPoint")), "balance_after": ba.get("credits", ba.get("remainPoint")),
            "credits": m.get("credits", m.get("charged_point"))}
    if d.get("result_r2_key"):
        ext = d["result_r2_key"].rsplit(".", 1)[-1]
        path = os.path.join(outdir, f"MZ_003_{line}_run{n}_{d['provider_task_id']}.{ext}")
        info["http"] = adm("GET", "/api/assets/r2/" + d["result_r2_key"], out=path); info["path"] = path
        pc = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "palette_check.py"), path], capture_output=True, text=True)
        try: info["palette"] = json.loads(pc.stdout.strip().splitlines()[-1])
        except Exception: info["palette"] = {"error": pc.stderr[-300:]}
    log(info); print(json.dumps(info, ensure_ascii=False))

if __name__ == "__main__":
    main()
