import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "package-smoke.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  outputDir: "output/playwright/package",
  reporter: [
    ["list"],
    ["html", { outputFolder: "output/playwright/package-report", open: "never" }],
  ],
});
