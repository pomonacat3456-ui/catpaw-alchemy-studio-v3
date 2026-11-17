-- 0003: real CANON sync provenance + live-provider columns.
-- jobs / costs are rebuilt because 0001 pinned paid = 0 with CHECKs; a live job consumes prepaid provider credits,
-- so paid may now be 1 but ONLY for mode = 'live'. published stays hard-pinned to 0.
PRAGMA defer_foreign_keys = true;

ALTER TABLE canon_characters ADD COLUMN mock_eligible INTEGER NOT NULL DEFAULT 0;
ALTER TABLE canon_characters ADD COLUMN canon_status TEXT;
ALTER TABLE canon_characters ADD COLUMN production_gate TEXT;      -- sheet「製片准入（公式）」verbatim
ALTER TABLE canon_characters ADD COLUMN master_asset_id TEXT;
ALTER TABLE canon_characters ADD COLUMN master_readable TEXT;      -- sheet「外部模型可讀」verbatim
ALTER TABLE canon_characters ADD COLUMN approval_reasons TEXT;     -- JSON list of why (not) approved
ALTER TABLE canon_characters ADD COLUMN sheet_id TEXT;
ALTER TABLE canon_characters ADD COLUMN sheet_tab TEXT;
ALTER TABLE canon_characters ADD COLUMN sheet_row INTEGER;
ALTER TABLE canon_characters ADD COLUMN synced_at TEXT;

-- staging fixtures that were approved stay usable for MOCK jobs only (production never has fixtures).
UPDATE canon_characters SET mock_eligible = 1 WHERE source = 'staging-fixture' AND approved = 1;

CREATE TABLE jobs_new (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  line TEXT NOT NULL CHECK (line IN ('A','B','C','D')),
  mode TEXT NOT NULL CHECK (mode IN ('mock','live')),
  provider TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft','preflight','blocked','ready','queued','running','qa','review','approved','delivered','failed','cancelled')),
  character_id TEXT NOT NULL,
  master_url TEXT,
  aspect TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  estimated_credits INTEGER NOT NULL DEFAULT 0,
  reserved_credits INTEGER NOT NULL DEFAULT 0 CHECK (reserved_credits >= 0),
  spent_credits INTEGER NOT NULL DEFAULT 0,
  paid INTEGER NOT NULL DEFAULT 0 CHECK (paid IN (0,1)),
  published INTEGER NOT NULL DEFAULT 0 CHECK (published = 0),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  provider_task_id TEXT,
  blocked_reasons TEXT,
  qa_json TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  running_since TEXT,
  last_tx TEXT,
  live_approval_ref TEXT,            -- per-job owner approval (required for live submit)
  provider_meta_json TEXT,           -- balance before/after, consumeCoins, raw provider status (no secrets)
  result_url TEXT,                   -- provider result URL
  result_r2_key TEXT,                -- copy in R2 (if bucket bound)
  CHECK (paid = 0 OR mode = 'live')
);
INSERT INTO jobs_new (id, idempotency_key, line, mode, provider, state, character_id, master_url, aspect, spec_json, estimated_credits,
  reserved_credits, spent_credits, paid, published, attempts, max_attempts, provider_task_id, blocked_reasons, qa_json, last_error,
  created_at, updated_at, running_since, last_tx)
SELECT id, idempotency_key, line, mode, provider, state, character_id, master_url, aspect, spec_json, estimated_credits,
  reserved_credits, spent_credits, paid, published, attempts, max_attempts, provider_task_id, blocked_reasons, qa_json, last_error,
  created_at, updated_at, running_since, last_tx FROM jobs;
DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;
CREATE INDEX idx_jobs_state ON jobs(state);
CREATE INDEX idx_jobs_line ON jobs(line, created_at);
CREATE INDEX idx_jobs_mode ON jobs(mode, provider_task_id);

CREATE TABLE costs_new (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  kind TEXT NOT NULL CHECK (kind IN ('estimate','reserve','commit','release','provider_charge')),
  credits INTEGER NOT NULL,
  scope TEXT NOT NULL,
  paid INTEGER NOT NULL DEFAULT 0 CHECK (paid IN (0,1)),
  batch_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (job_id, kind)
);
INSERT INTO costs_new SELECT id, job_id, kind, credits, scope, paid, batch_token, created_at FROM costs;
DROP TABLE costs;
ALTER TABLE costs_new RENAME TO costs;

-- Budgets for production. Live budget is in RunningHub coins and capped for ONE 5s H3 test.
INSERT OR IGNORE INTO budgets (scope, limit_credits, reserved, spent) VALUES ('production-mock', 1000, 0, 0);
INSERT OR IGNORE INTO budgets (scope, limit_credits, reserved, spent) VALUES ('production-live', 400, 0, 0);

PRAGMA defer_foreign_keys = false;
