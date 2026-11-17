import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // Test-only values; real staging secrets live only in Cloudflare + /home/box/secrets (mode 600).
          bindings: { TEST_MIGRATIONS: migrations, ADMIN_KEY: "test-admin-key", CALLBACK_HMAC_SECRET: "test-callback-secret" },
        },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
