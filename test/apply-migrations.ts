import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

const e = env as any;
await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
// staging fixtures (seed/staging-fixtures.sql) — idempotent per test file
const has = await e.DB.prepare("SELECT COUNT(*) n FROM canon_characters WHERE source = 'staging-fixture'").first();
if (!has.n) {
  const sql = (e.TEST_SEED as string).split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  for (const stmt of sql.split(/;\s*(?:\n|$)/).map((x) => x.trim()).filter(Boolean)) await e.DB.prepare(stmt).run();
}
