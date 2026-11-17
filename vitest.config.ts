import { readFileSync } from "node:fs";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  const seed = readFileSync("./seed/staging-fixtures.sql", "utf8");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // Test-only values; real secrets live only in Cloudflare + /home/box/secrets (mode 600).
          bindings: { TEST_MIGRATIONS: migrations, TEST_SEED: seed, ADMIN_KEY: "test-admin-key", CALLBACK_HMAC_SECRET: "test-callback-secret" },
          r2Buckets: ["ASSETS_BUCKET"],
        },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
