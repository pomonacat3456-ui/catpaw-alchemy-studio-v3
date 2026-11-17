-- Single-job, single-use owner override that releases ONE character for ONE live test without editing the CANON Sheet.
CREATE TABLE canon_live_overrides (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL REFERENCES canon_characters(id),
  master_url TEXT NOT NULL,          -- publicly readable copy of the sheet-approved Master
  approver TEXT NOT NULL,            -- e.g. 'owner 2026-11-17 11:50'
  reason TEXT,
  max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses = 1),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count BETWEEN 0 AND 1),
  job_id TEXT,                       -- bound at preflight; only this job may use it
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX idx_overrides_char ON canon_live_overrides(character_id, used_count);
