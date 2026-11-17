-- Line B live (RunningHub AI app, settles in plan 點數) gets its own ledger so it never eats line A's.
INSERT OR IGNORE INTO budgets (scope, limit_credits, reserved, spent) VALUES ('production-live-b', 2000, 0, 0);
