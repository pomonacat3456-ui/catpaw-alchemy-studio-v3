-- STAGING FIXTURES ONLY. These are NOT the real CANON Google Sheet v3 entries.
-- Master URLs use the reserved .invalid TLD on purpose; replace with approved CANON data before any live use.
INSERT INTO budgets (scope, limit_credits, reserved, spent) VALUES ('staging-mock', 200, 0, 0);

INSERT INTO canon_characters (id, display_name, sex, species, master_url, approved, weapon, outfit, source, created_at) VALUES
 ('fixture-fulan',  '縛嵐喵（測試夾具）',   'female', 'cat', 'https://canon-fixtures.invalid/master/fixture-fulan-v1.png',  1, '一杖', '布袋戲偶戰袍', 'staging-fixture', '2026-11-17T00:00:00Z'),
 ('fixture-liuli',  '琉璃喵（測試夾具）',   'female', 'cat', 'https://canon-fixtures.invalid/master/fixture-liuli-v1.png',  1, '琉璃扇', '布袋戲偶長衫', 'staging-fixture', '2026-11-17T00:00:00Z'),
 ('fixture-baidi',  '白帝喵尊（測試夾具）', 'female', 'cat', 'https://canon-fixtures.invalid/master/fixture-baidi-v1.png',  1, '白玉劍', '帝袍', 'staging-fixture', '2026-11-17T00:00:00Z'),
 ('fixture-pending','待審角色（測試夾具）', 'female', 'cat', 'https://canon-fixtures.invalid/master/fixture-pending-v0.png', 0, NULL, NULL, 'staging-fixture', '2026-11-17T00:00:00Z');
