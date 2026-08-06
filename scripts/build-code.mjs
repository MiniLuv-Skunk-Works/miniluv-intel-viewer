import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = path.join(root, ".build");
const testsOnly = process.argv.includes("--tests");

if (testsOnly) {
  await build({
    absWorkingDir: root,
    entryPoints: [
      "tests/test-viewer.ts",
      "tests/test-security.ts",
      "tests/test-clipboard.ts",
      "tests/test-contracts.ts",
      "tests/test-dashboard-url.ts",
      "tests/test-credentials.ts",
      "tests/test-ipc-security.ts",
      "tests/test-dashboard-client.ts",
      "tests/test-feed-connection.ts",
      "tests/test-renderer.ts"
    ],
    outdir: path.join(outdir, "tests"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    logLevel: "info"
  });
} else {
  await rm(outdir, { recursive: true, force: true });
  await Promise.all([
    build({
      absWorkingDir: root,
      entryPoints: ["main.ts", "preload.ts", "clipboard-filter.ts", "contracts.ts"],
      outdir,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node24",
      external: ["electron"],
      logLevel: "info"
    }),
    build({
      absWorkingDir: root,
      entryPoints: ["renderer/app.ts"],
      outfile: path.join(outdir, "renderer", "app.js"),
      bundle: true,
      platform: "browser",
      format: "iife",
      target: "chrome150",
      logLevel: "info"
    })
  ]);
}
