import { expect, test, type TestInfo } from "@playwright/test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MockDashboard } from "../support/mock-dashboard";

const root = path.resolve(__dirname, "..", "..");

test.describe.configure({ mode: "serial" });

test("real Electron pairing, containment, reconnect, clipboard, restoration, and shutdown", async ({
  browserName: _browserName,
}, testInfo) => {
  const dashboard = new MockDashboard();
  const profileRoot = await fs.mkdtemp(path.join(os.tmpdir(), "milf-viewer-e2e-"));
  const logs: string[] = [];
  let application: ElectronApplication | null = null;
  let originalClipboard: string;

  try {
    await dashboard.start();
    let page: Page;
    ({ application, page } = await launchApplication(profileRoot, logs));

    originalClipboard = await application.evaluate(({ clipboard }) => clipboard.readText());
    const preferences = await application.evaluate(({ BrowserWindow }) => {
      const webContents = BrowserWindow.getAllWindows()[0]?.webContents as unknown as {
        getLastWebPreferences(): Record<string, unknown>;
      };
      return webContents.getLastWebPreferences();
    });
    expect(preferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    });
    expect(await page.evaluate(() => typeof process)).toBe("undefined");
    expect(await page.evaluate(() => window.open("https://example.invalid"))).toBeNull();
    await expect(page).toHaveURL(/renderer\/index\.html$/);
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("viewer window missing");
      window.setSize(280, 500);
    });
    expect(
      await page
        .locator("#appHeader")
        .evaluate((header) => header.scrollWidth <= header.clientWidth),
    ).toBe(true);
    expect(
      await page
        .locator("#scenarioControls")
        .evaluate((controls) => controls.scrollWidth <= controls.clientWidth),
    ).toBe(true);
    await page.locator("#server").fill(dashboard.url);
    await page.locator("#code").fill("ABCD-EFGH");
    await page.locator("#pairBtn").click();
    await expect(page.locator("#pair")).not.toHaveClass(/show/);
    await expect(page.locator("#scenarioControls")).toHaveAccessibleName(
      "Tank and fleet calculations for every scan",
    );
    await dashboard.waitForFeedCount(1);
    dashboard.sendHello();
    await expect(page.locator("#dot")).toHaveClass(/live/);
    await waitForRequest(dashboard, "/api/viewer/vocabulary");

    const hostile = '<img src=x onerror="document.body.dataset.pwned=1">#[]';
    dashboard.sendScan({
      id: `scan-${hostile}`,
      at: Date.now(),
      hull: hostile,
      system: "Jita",
      pilot: "<script>bad()</script>",
      fitEft: hostile,
    });
    await waitForRequest(dashboard, "/api/viewer/scenario-calculations");
    await expect(page.locator(".hull").first()).toHaveText(hostile);
    await expect(page.locator(".scan").first()).toContainText("600k EHP \u00B7 Void");
    await expect(page.locator(".scan").first()).toContainText("12 Talos");
    const calculationRequestsBeforeToggle = dashboard.requests.filter(
      (request) => request.path === "/api/viewer/scenario-calculations",
    ).length;
    await page.locator("#scenarioTank").selectOption("overheated");
    await waitForRequestCount(
      dashboard,
      "/api/viewer/scenario-calculations",
      calculationRequestsBeforeToggle + 1,
    );
    await expect(page.locator(".scan").first()).toContainText("900k EHP \u00B7 Void");
    await page.locator(".scanOpen").first().click();
    await expect(page.locator("#detailBody")).toContainText("900,000 EHP");
    await expect(page.locator("#detailBody")).toContainText("Overheated tank");
    await page.locator("#detailClose").click();
    await expect(page.locator("img[src='x']")).toHaveCount(0);
    expect(await page.evaluate(() => document.body.dataset.pwned)).toBeUndefined();
    const statusTooltip = page.locator("#status");
    await expect(statusTooltip).not.toBeVisible();
    await page.locator("#dot").hover();
    await expect(statusTooltip).toBeVisible();
    await expect(statusTooltip).toContainText("Live");
    await expect(statusTooltip).toContainText("last event");
    await page.locator("#dot").focus();
    await expect(statusTooltip).toBeVisible();

    await page.locator("#filterBtn").click();
    await page.locator("#filterQuery").fill("Providence");
    await expect(page.locator("#list")).toContainText("No scans match");
    await page.locator("#filterClear").click();
    await expect(page.locator(".hull").first()).toHaveText(hostile);

    await page.locator("#settingsBtn").click();
    await page.locator("#alertsEnabled").check();
    await page.locator("#alertHulls").fill("Obelisk");
    await page.locator("#settingsSave").click();
    await expect(page.locator("#settings")).not.toHaveClass(/show/);
    await page.locator("#muteBtn").click();
    await expect(page.locator("#muteBtn")).toHaveAttribute("aria-pressed", "true");

    await page.locator("#settingsBtn").click();
    await page.locator("#diagBtn").click();
    await expect(page.locator("#diagOrigin")).toHaveText(dashboard.url);
    await expect(page.locator("#diagVersion")).not.toHaveText("—");
    await page.locator("#diagnosticsClose").click();
    await expect(page.locator("#settings")).toHaveClass(/show/);
    await expect(page.locator("#diagBtn")).toBeFocused();
    await page.locator("#settingsClose").click();

    const calculationsBeforeReconnect = dashboard.requests.filter(
      (request) => request.path === "/api/viewer/scenario-calculations",
    ).length;
    dashboard.disconnectFeeds();
    await dashboard.waitForFeedCount(1);
    const feeds = dashboard.requests.filter((request) => request.path === "/api/feed");
    expect(feeds.at(-1)?.lastEventId).toBe(`revision-scan-${hostile}`);
    dashboard.sendHello();
    dashboard.sendScan({ id: `scan-${hostile}`, at: Date.now(), hull: "duplicate" });
    dashboard.sendScan({ id: "scan-after-reconnect", at: Date.now(), hull: "Providence" });
    await waitForRequestCount(
      dashboard,
      "/api/viewer/scenario-calculations",
      calculationsBeforeReconnect + 1,
    );
    await expect(page.locator(".hull", { hasText: "Providence" })).toHaveCount(1);
    await expect(page.locator(".hull", { hasText: "duplicate" })).toHaveCount(0);

    await application.evaluate(({ clipboard }, value) => clipboard.writeText(value), "seeded text");
    await page.locator("#settingsBtn").click();
    await page.locator("#clipBtn").click();
    await expect(page.locator("#clipBtn")).toHaveAttribute("aria-pressed", "true");
    await application.evaluate(
      ({ clipboard }, value) => clipboard.writeText(value),
      "Tritanium\t100\nPyerite\t200",
    );
    await waitForRequest(dashboard, "/api/viewer/clip");
    await page.locator("#clipBtn").click();
    await expect(page.locator("#clipBtn")).toHaveAttribute("aria-pressed", "false");
    await application.evaluate(
      ({ clipboard }, value) => clipboard.writeText(value),
      originalClipboard,
    );
    await page.locator("#settingsClose").click();

    const userData = await application.evaluate(({ app }) => app.getPath("userData"));
    const settingsText = await fs.readFile(path.join(userData, "settings.json"), "utf8");
    expect(settingsText).not.toContain(dashboard.token);
    const credential = await fs.readFile(path.join(userData, "credential.bin"));
    expect(credential.includes(Buffer.from(dashboard.token))).toBe(false);

    const savedBounds = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("viewer window missing");
      const current = window.getBounds();
      const next = { x: Math.max(0, current.x - 40), y: current.y + 12, width: 420, height: 500 };
      window.setBounds(next);
      return window.getBounds();
    });
    await quitFromPage(application, page);
    application = null;
    ({ application, page } = await launchApplication(profileRoot, logs));
    const restoredBounds = await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.getBounds(),
    );
    expect(restoredBounds).toEqual(savedBounds);
    await expect(page.locator("#pair")).not.toHaveClass(/show/);
    await expect(page.locator("#muteBtn")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#scenarioTank")).toHaveValue("overheated");
    await page.locator("#settingsBtn").click();
    await page.locator("#repairBtn").click();
    await expect(page.locator("#pair")).toHaveClass(/show/);
    await expect(page.locator("#pairCancel")).toBeHidden();
    await quitFromMain(application);
    application = null;
  } catch (error) {
    await attachDiagnostics(application, logs, dashboard, testInfo);
    throw error;
  } finally {
    if (application) await application.close().catch(() => undefined);
    await dashboard.close().catch(() => undefined);
    await fs.rm(profileRoot, { recursive: true, force: true });
  }
});

async function launchApplication(
  profileRoot: string,
  logs: string[],
): Promise<{ application: ElectronApplication; page: Page }> {
  await Promise.all(
    ["appdata", "localappdata", "temp", "userdata"].map((directory) =>
      fs.mkdir(path.join(profileRoot, directory), { recursive: true }),
    ),
  );
  const application = await electron.launch({
    cwd: root,
    args: [
      root,
      "--allow-insecure-localhost",
      "--disable-gpu",
      "--disable-gpu-sandbox",
      `--user-data-dir=${path.join(profileRoot, "userdata")}`,
    ],
    env: {
      ...process.env,
      MILF_VIEWER_E2E: "1",
      MILF_VIEWER_E2E_USER_DATA: path.join(profileRoot, "userdata"),
      APPDATA: path.join(profileRoot, "appdata"),
      LOCALAPPDATA: path.join(profileRoot, "localappdata"),
      TEMP: path.join(profileRoot, "temp"),
      TMP: path.join(profileRoot, "temp"),
    },
  });
  application.on("console", (message) => logs.push(`[main:${message.type()}] ${message.text()}`));
  const page = await application.firstWindow();
  page.on("console", (message) => logs.push(`[renderer:${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => logs.push(`[renderer:error] ${error.message}`));
  return { application, page };
}

async function quitFromPage(application: ElectronApplication, page: Page): Promise<void> {
  const closed = application.waitForEvent("close", { timeout: 10_000 });
  await page.locator("#quitBtn").click();
  await closed;
}

async function quitFromMain(application: ElectronApplication): Promise<void> {
  const closed = application.waitForEvent("close", { timeout: 10_000 });
  await application.evaluate(({ app }) => app.quit()).catch(() => undefined);
  await closed;
}

async function waitForRequest(
  dashboard: MockDashboard,
  requestPath: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!dashboard.requests.some((request) => request.path === requestPath)) {
    if (Date.now() >= deadline) throw new Error(`request ${requestPath} was not observed`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForRequestCount(
  dashboard: MockDashboard,
  requestPath: string,
  count: number,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (dashboard.requests.filter((request) => request.path === requestPath).length < count) {
    if (Date.now() >= deadline) {
      throw new Error("request " + requestPath + " did not reach count " + count);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function attachDiagnostics(
  application: ElectronApplication | null,
  logs: string[],
  dashboard: MockDashboard,
  testInfo: TestInfo,
): Promise<void> {
  const page = application?.windows()[0];
  if (page) {
    const screenshot = await page.screenshot().catch(() => null);
    if (screenshot) {
      await testInfo.attach("viewer.png", { body: screenshot, contentType: "image/png" });
    }
  }
  await testInfo.attach("electron.log", {
    body: Buffer.from(logs.join("\n")),
    contentType: "text/plain",
  });
  await testInfo.attach("mock-dashboard.json", {
    body: Buffer.from(JSON.stringify(dashboard.requests, null, 2)),
    contentType: "application/json",
  });
}
