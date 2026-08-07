import { expect, test } from "@playwright/test";
import { chromium, type Browser } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = path.resolve(__dirname, "..", "..");

test("portable executable launches, renders, and quits", async ({
  browserName: _browserName,
}, testInfo) => {
  const executable = await findPortableExecutable();
  const profileRoot = await fs.mkdtemp(path.join(os.tmpdir(), "milf-viewer-package-"));
  const port = await freePort();
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let child: ChildProcess | null = null;
  let browser: Browser | null = null;

  try {
    await Promise.all(
      ["appdata", "localappdata", "temp", "userdata"].map((directory) =>
        fs.mkdir(path.join(profileRoot, directory), { recursive: true }),
      ),
    );
    child = spawn(
      executable,
      [
        `--remote-debugging-address=127.0.0.1`,
        `--remote-debugging-port=${port}`,
        "--disable-gpu",
        "--disable-gpu-sandbox",
        `--user-data-dir=${path.join(profileRoot, "userdata")}`,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          MILF_VIEWER_E2E: "1",
          MILF_VIEWER_E2E_USER_DATA: path.join(profileRoot, "userdata"),
          APPDATA: path.join(profileRoot, "appdata"),
          LOCALAPPDATA: path.join(profileRoot, "localappdata"),
          TEMP: path.join(profileRoot, "temp"),
          TMP: path.join(profileRoot, "temp"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    await waitForDebugger(port, child);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = browser.contexts()[0]?.pages()[0];
    if (!page) throw new Error("packaged viewer did not expose its window");
    await expect(page).toHaveTitle("M.I.L.F Viewer");
    await expect(page.locator("#pairTitle")).toHaveText("Pair this viewer");
    await expect(page.locator("#pair")).toHaveClass(/show/);

    const exited = new Promise<void>((resolve, reject) => {
      child?.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    });
    await page.evaluate(() => window.close());
    await Promise.race([
      exited,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("packaged viewer did not exit")), 15_000),
      ),
    ]);
    child = null;
  } catch (error) {
    await testInfo.attach("portable-stdout.log", {
      body: Buffer.concat(stdout),
      contentType: "text/plain",
    });
    await testInfo.attach("portable-stderr.log", {
      body: Buffer.concat(stderr),
      contentType: "text/plain",
    });
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
    child?.kill();
    await fs.rm(profileRoot, { recursive: true, force: true });
  }
});

async function findPortableExecutable(): Promise<string> {
  const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof manifest.version !== "string") throw new Error("package version is missing");
  const executable = path.join(root, "dist", `MILF-Viewer-${manifest.version}.exe`);
  await fs.access(executable);
  return executable;
}

async function freePort(): Promise<number> {
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to reserve debug port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitForDebugger(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`portable executable exited with ${child.exitCode}`);
    try {
      await new Promise<void>((resolve, reject) => {
        const request = http.get(`http://127.0.0.1:${port}/json/version`, (response) => {
          response.resume();
          if (response.statusCode === 200) resolve();
          else reject(new Error(`HTTP ${response.statusCode}`));
        });
        request.on("error", reject);
        request.setTimeout(500, () => request.destroy(new Error("debug endpoint timeout")));
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("portable debugging endpoint did not start");
}
