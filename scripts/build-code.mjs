import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = path.join(root, ".build");
const testsOnly = process.argv.includes("--tests");

if (testsOnly) {
  const testEntries = (await readdir(path.join(root, "tests"), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^test-.*\.ts$/.test(entry.name))
    .map((entry) => path.join("tests", entry.name));
  await build({
    absWorkingDir: root,
    entryPoints: testEntries,
    outdir: path.join(outdir, "tests"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    sourcemap: "linked",
    logLevel: "info",
  });
} else {
  await rm(outdir, { recursive: true, force: true });
  await Promise.all([
    build({
      absWorkingDir: root,
      entryPoints: [
        "main.ts",
        "preload.ts",
        "clipboard-filter.ts",
        "contracts.ts",
        "settings-store.ts",
        "window-placement.ts",
      ],
      outdir,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node24",
      external: ["electron"],
      sourcemap: "linked",
      logLevel: "info",
    }),
    build({
      absWorkingDir: root,
      entryPoints: ["renderer/app.ts"],
      outfile: path.join(outdir, "renderer", "app.js"),
      bundle: true,
      platform: "browser",
      format: "iife",
      target: "chrome150",
      sourcemap: "linked",
      logLevel: "info",
    }),
  ]);
}
