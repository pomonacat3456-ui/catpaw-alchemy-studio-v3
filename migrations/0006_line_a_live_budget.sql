-- Owner 2026-11-17 (t130u 「沒有上限，測順來」): line A automation. Internal ledger only (no money);
-- the real guard is the provider balance check before every paid submit. Held reservations (H3 350 + PixVerse 35)
-- stay until deliver/commit, so the old 400 limit blocked further runs.
UPDATE budgets SET limit_credits = 2000 WHERE scope = 'production-live' AND limit_credits < 2000;
