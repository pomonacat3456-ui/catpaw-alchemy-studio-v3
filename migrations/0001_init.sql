-- CatPaw Alchemy Studio v3 — fresh rebuild schema (NOT restored from the lost ZIP).
-- paid / published are hard-pinned to 0 by CHECK constraints in this build.

CREATE TABLE canon_characters (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  sex TEXT NOT NULL CHECK (sex = 'female'),          -- all-female cats rule, enforced at DB level too
  species TEXT NOT NULL DEFAULT 'cat' CHECK (species = 'cat'),
  master_url TEXT NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0 CHECK (approved IN (0, 1)),
  weapon TEXT,
  outfit TEXT,
  source TEXT NOT NULL,                               -- 'staging-fixture' | 'canon-sheet-v3'
  created_at TEXT NOT NULL
);

CREATE TABLE jobs (
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
  paid INTEGER NOT NULL DEFAULT 0 CHECK (paid = 0),
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
  last_tx TEXT                     -- token of the last applied transition (guards side effects)
);
CREATE INDEX idx_jobs_state ON jobs(state);
CREATE INDEX idx_jobs_line ON jobs(line, created_at);

CREATE TABLE steps (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  idx INTEGER NOT NULL,
  kind TEXT NOT NULL,              -- 'segment' | 'image' | 'music'
  duration_sec INTEGER,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (job_id, idx)
);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  step_idx INTEGER NOT NULL,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  url TEXT NOT NULL,
  provider_task_id TEXT NOT NULL,
  mock INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (job_id, step_idx, version)
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT,
  type TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  detail_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_events_job ON events(job_id, id);

CREATE TABLE budgets (
  scope TEXT PRIMARY KEY,
  limit_credits INTEGER NOT NULL,
  reserved INTEGER NOT NULL DEFAULT 0,
  spent INTEGER NOT NULL DEFAULT 0,
  paid INTEGER NOT NULL DEFAULT 0 CHECK (paid = 0),
  CHECK (reserved >= 0 AND spent >= 0 AND reserved + spent <= limit_credits)
);

CREATE TABLE costs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  kind TEXT NOT NULL CHECK (kind IN ('estimate','reserve','commit','release')),
  credits INTEGER NOT NULL,
  scope TEXT NOT NULL,
  paid INTEGER NOT NULL DEFAULT 0 CHECK (paid = 0),
  batch_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (job_id, kind)            -- one reserve / one commit / one release per job => no double charge
);

CREATE TABLE callback_events (
  event_id TEXT PRIMARY KEY,       -- dedupe key
  job_id TEXT,
  provider_task_id TEXT,
  status TEXT,
  received_at TEXT NOT NULL
);
