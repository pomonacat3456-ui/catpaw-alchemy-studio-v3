#!/usr/bin/env bash
# Live verification of the STAGING worker with curl. Secrets are read from files and never printed.
# Usage: BASE=https://catpaw-alchemy-v3-staging.<sub>.workers.dev scripts/verify-staging.sh | tee verify/staging-curl-<date>.log
set -euo pipefail
BASE="${BASE:?set BASE}"
ADMIN_FILE="${ADMIN_FILE:-/home/box/secrets/catpaw_alchemy_v3_admin_key}"
HMAC_FILE="${HMAC_FILE:-/home/box/secrets/catpaw_alchemy_v3_callback_hmac_secret}"
PASS=0; FAIL=0
log() { printf '%s\n' "$*"; }
check() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); log "  ✅ $1 (got $2)"; else FAIL=$((FAIL+1)); log "  ❌ $1 (expected $3, got $2)"; fi; }
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);v=eval('d'+sys.argv[1]);print(json.dumps(v) if isinstance(v,(dict,list,bool)) or v is None else v)" "$1"; }
# req METHOD PATH [JSON] -> sets CODE and BODY
req() {
  local m="$1" p="$2" data="${3:-}" out
  local cfg; cfg=$(mktemp); chmod 600 "$cfg"
  printf 'header = "x-admin-key: %s"\n' "$(tr -d '\n' < "$ADMIN_FILE")" > "$cfg"
  if [ -n "$data" ]; then
    out=$(curl -sS -K "$cfg" -X "$m" -H 'content-type: application/json' --data "$data" -w '\n%{http_code}' "$BASE$p")
  else
    out=$(curl -sS -K "$cfg" -X "$m" -w '\n%{http_code}' "$BASE$p")
  fi
  rm -f "$cfg"
  CODE="${out##*$'\n'}"; BODY="${out%$'\n'*}"
  log "→ $m $p ${data:+body=$data}"; log "← HTTP $CODE $(printf '%s' "$BODY" | python3 -c 'import sys,json;d=json.load(sys.stdin);j=d.get("job",d);print(json.dumps({k:j.get(k) for k in ["jobId","state","mock","paid","published","attempts","provider_task_id","blocked_reasons","error","deduplicated"] if k in j} | ({"deduplicated":d["deduplicated"]} if "deduplicated" in d else {}) | ({"error":d["error"],"detail":d.get("detail")} if "error" in d else {}), ensure_ascii=False))' 2>/dev/null || printf '%s' "$BODY" | head -c 300)"
}
# callback PAYLOAD [secret-override] -> signed POST
callback() {
  local payload="$1" ts sig secret
  ts=$(date +%s)
  if [ -n "${2:-}" ]; then secret="$2"; else secret=$(tr -d '\n' < "$HMAC_FILE"); fi
  sig=$(printf '%s' "$ts.$payload" | openssl dgst -sha256 -hmac "$secret" -r | cut -d' ' -f1)
  local out; out=$(curl -sS -X POST -H 'content-type: application/json' -H "x-catpaw-timestamp: $ts" -H "x-catpaw-signature: sha256=$sig" --data "$payload" -w '\n%{http_code}' "$BASE/api/callbacks/runninghub-h3")
  CODE="${out##*$'\n'}"; BODY="${out%$'\n'*}"
  log "→ POST /api/callbacks/runninghub-h3 (signed${2:+ with WRONG secret}) body=$payload"
  log "← HTTP $CODE $(printf '%s' "$BODY" | python3 -c 'import sys,json;d=json.load(sys.stdin);j=d.get("job") or {};print(json.dumps({"duplicate":d.get("duplicate"),"error":d.get("error"),"detail":d.get("detail"),"state":j.get("state")},ensure_ascii=False))')"
}
RUN="verify-$(date +%Y%m%d%H%M%S)"
log "# CatPaw Alchemy v3 staging live verification  base=$BASE  run=$RUN  at=$(date '+%F %T %Z')"

log "## 1. /health"
out=$(curl -sS -w '\n%{http_code}' "$BASE/health"); CODE="${out##*$'\n'}"; BODY="${out%$'\n'*}"; log "$BODY"
check "health 200" "$CODE" 200
check "health mock" "$(printf '%s' "$BODY" | jget '["mock"]')" true
check "health paid" "$(printf '%s' "$BODY" | jget '["paid"]')" false
check "health published" "$(printf '%s' "$BODY" | jget '["published"]')" false

log "## 2. auth"
out=$(curl -sS -o /dev/null -w '%{http_code}' -H 'x-admin-key: wrong' "$BASE/api/jobs"); check "wrong admin key -> 401" "$out" 401

MASTER='https://canon-fixtures.invalid/master/fixture-fulan-v1.png'
declare -A EXTRA=( [A]='"segments":[5,15]' [B]='"images":3' [C]='"segments":[15,15],"audio_ref":"mock://audio/theme.wav"' [D]='"segments":[15,15,5]' )
declare -A QA=( [A]='{"safe_area":true,"audio":true,"image_quality":true,"character_consistency":true,"tail_frame":true}' [B]='{"safe_area":true,"image_quality":true,"character_consistency":true}' )
QA[C]="${QA[A]}"; QA[D]="${QA[A]}"
for L in A B C D; do
  log "## 3.$L line $L full mock flow"
  BODYJ="{\"line\":\"$L\",\"mode\":\"mock\",\"protagonist\":\"fixture-fulan\",\"master_url\":\"$MASTER\",${EXTRA[$L]},\"prompt\":\"$RUN line $L 全母喵布袋戲偶\"}"
  req POST /api/jobs "$BODYJ"; check "$L create 201" "$CODE" 201
  ID=$(printf '%s' "$BODY" | jget '["job"]["jobId"]'); log "  jobId=$ID"; echo "$L $ID" >> "${JOBS_FILE:-/dev/null}"
  req POST "/api/jobs/$ID/preflight"; check "$L preflight ready" "$(printf '%s' "$BODY" | jget '["job"]["state"]')" ready
  req POST "/api/jobs/$ID/enqueue";  check "$L queued" "$(printf '%s' "$BODY" | jget '["job"]["state"]')" queued
  req POST "/api/jobs/$ID/run";      check "$L running" "$(printf '%s' "$BODY" | jget '["job"]["state"]')" running
  TASK=$(printf '%s' "$BODY" | jget '["job"]["provider_task_id"]')
  callback "{\"event_id\":\"$RUN-$L-ok\",\"job_id\":\"$ID\",\"provider_task_id\":\"$TASK\",\"status\":\"succeeded\"}"
  check "$L signed callback -> qa" "$(printf '%s' "$BODY" | jget '["job"]["state"]')" qa
  req POST "/api/jobs/$ID/qa" "{\"checks\":${QA[$L]}}"; check "$L review" "$(printf '%s' "$BODY" | jget '["job"]["state"]')" review
  req POST "/api/jobs/$ID/approve" '{}'; check "$L approved" "$(printf '%s' "$BODY" | jget '["job"]["state"]')" approved
  req POST "/api/jobs/$ID/deliver";  check "$L delivered" "$(printf '%s' "$BODY" | jget '["job"]["state"]')" delivered
  check "$L mock:true" "$(printf '%s' "$BODY" | jget '["job"]["mock"]')" true
  check "$L paid:false" "$(printf '%s' "$BODY" | jget '["job"]["paid"]')" false
  check "$L published:false" "$(printf '%s' "$BODY" | jget '["job"]["published"]')" false
  req GET "/api/jobs/$ID"; check "$L read-back delivered" "$(printf '%s' "$BODY" | jget '["state"]')" delivered
  log "  events: $(printf '%s' "$BODY" | python3 -c 'import sys,json;print(" -> ".join(e["to_state"] for e in json.load(sys.stdin)["events"] if e["type"]=="transition"))')"
  log "  costs: $(printf '%s' "$BODY" | python3 -c 'import sys,json;print(json.load(sys.stdin)["costs"])')"
  [ "$L" = A ] && { A_ID="$ID"; A_BODY="$BODYJ"; }
done

log "## 4. idempotency (repeat line A request)"
req POST /api/jobs "$A_BODY"; check "repeat -> 200" "$CODE" 200
check "repeat deduplicated" "$(printf '%s' "$BODY" | jget '["deduplicated"]')" true
check "repeat same jobId" "$(printf '%s' "$BODY" | jget '["job"]["jobId"]')" "$A_ID"

log "## 5. CANON rejection"
req POST /api/jobs "{\"line\":\"A\",\"protagonist\":\"fixture-fulan\",\"segments\":[5],\"prompt\":\"$RUN no master\",\"auto_preflight\":true}"
check "missing master URL -> blocked" "$(printf '%s' "$BODY" | jget '["job"]["state"]')" blocked
C1=$(printf '%s' "$BODY" | jget '["job"]["jobId"]')
req POST /api/jobs "{\"line\":\"A\",\"protagonist\":\"random-tomcat\",\"master_url\":\"https://example.com/x.png\",\"segments\":[5],\"prompt\":\"$RUN unregistered\",\"auto_preflight\":true}"
check "unregistered protagonist -> blocked" "$(printf '%s' "$BODY" | jget '["job"]["state"]')" blocked
req POST /api/jobs "{\"line\":\"A\",\"protagonist\":\"fixture-fulan\",\"master_url\":\"$MASTER\",\"segments\":[10],\"prompt\":\"$RUN 10s\",\"auto_preflight\":true}"
check "10s segment -> blocked" "$(printf '%s' "$BODY" | jget '["job"]["state"]')" blocked
req POST "/api/jobs/$C1/enqueue"; check "blocked job enqueue -> 409" "$CODE" 409
req POST /api/jobs "{\"line\":\"A\",\"mode\":\"live\",\"protagonist\":\"fixture-fulan\",\"master_url\":\"$MASTER\",\"segments\":[5],\"prompt\":\"$RUN live\",\"auto_preflight\":true}"
check "live mode -> blocked (paid block)" "$(printf '%s' "$BODY" | jget '["job"]["state"]')" blocked

log "## 6. forged / duplicate callbacks"
req POST /api/jobs "{\"line\":\"B\",\"protagonist\":\"fixture-fulan\",\"master_url\":\"$MASTER\",\"images\":1,\"prompt\":\"$RUN cb\",\"auto_preflight\":true}"
F_ID=$(printf '%s' "$BODY" | jget '["job"]["jobId"]')
req POST "/api/jobs/$F_ID/enqueue"; req POST "/api/jobs/$F_ID/run"; F_TASK=$(printf '%s' "$BODY" | jget '["job"]["provider_task_id"]')
callback "{\"event_id\":\"$RUN-forged\",\"job_id\":\"$F_ID\",\"provider_task_id\":\"$F_TASK\",\"status\":\"succeeded\"}" "attacker-secret"
check "forged signature -> 401" "$CODE" 401
out=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data '{"event_id":"x"}' "$BASE/api/callbacks/runninghub-h3"); check "unsigned callback -> 401" "$out" 401
req GET "/api/jobs/$F_ID"; check "job still running after forged cb" "$(printf '%s' "$BODY" | jget '["state"]')" running
callback "{\"event_id\":\"$RUN-fail1\",\"job_id\":\"$F_ID\",\"provider_task_id\":\"$F_TASK\",\"status\":\"failed\",\"error\":\"mock_failure\"}"
check "provider failure -> retry queued" "$(printf '%s' "$BODY" | jget '["job"]["state"]')" queued
callback "{\"event_id\":\"$RUN-fail1\",\"job_id\":\"$F_ID\",\"provider_task_id\":\"$F_TASK\",\"status\":\"failed\",\"error\":\"mock_failure\"}"
check "duplicate event ignored" "$(printf '%s' "$BODY" | jget '["duplicate"]')" true
req POST "/api/jobs/$F_ID/cancel" '{"reason":"verify cleanup"}'; check "cancel -> cancelled" "$(printf '%s' "$BODY" | jget '["job"]["state"]')" cancelled

log "## 7. publish blocked"
req POST "/api/jobs/$A_ID/publish" '{}'; check "publish delivered job -> 403" "$CODE" 403
check "publish error code" "$(printf '%s' "$BODY" | jget '["error"]')" publish_blocked

log "## 8. budget (mock credits)"
req GET /api/budget; log "$BODY"

log "# RESULT pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
