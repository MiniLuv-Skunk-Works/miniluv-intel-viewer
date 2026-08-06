import { isTrustedIpcSource, runAuthorizedIpc } from "../ipc-security";
import { test } from "node:test";
import { ok } from "./support/assertions";

test("IPC source authorization", async () => {
  const mainFrame = {};
  const webContents = { mainFrame };

  console.log("\n=== IPC source authorization ===");
  ok(
    "viewer main frame is trusted",
    isTrustedIpcSource({ sender: webContents, senderFrame: mainFrame }, webContents),
  );
  ok(
    "another webContents is rejected",
    !isTrustedIpcSource({ sender: {}, senderFrame: mainFrame }, webContents),
  );
  ok(
    "a child frame is rejected",
    !isTrustedIpcSource({ sender: webContents, senderFrame: {} }, webContents),
  );
  ok(
    "a missing window is rejected",
    !isTrustedIpcSource({ sender: webContents, senderFrame: mainFrame }, null),
  );

  let mutations = 0;
  const rejected = await runAuthorizedIpc(
    { sender: {}, senderFrame: mainFrame },
    webContents,
    () => "rejected",
    () => {
      mutations += 1;
      return "handled";
    },
  );
  ok("unauthorized handlers cannot mutate state", rejected === "rejected" && mutations === 0);

  const handled = await runAuthorizedIpc(
    { sender: webContents, senderFrame: mainFrame },
    webContents,
    () => "rejected",
    () => {
      mutations += 1;
      return "handled";
    },
  );
  ok("authorized handlers execute", handled === "handled" && mutations === 1);

  const safeFailure = await runAuthorizedIpc(
    { sender: webContents, senderFrame: mainFrame },
    webContents,
    () => "safe error",
    () => {
      throw new Error("private implementation detail");
    },
  );
  ok("handler exceptions become safe results", safeFailure === "safe error");
});
