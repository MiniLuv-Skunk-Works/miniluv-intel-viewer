import { isTrustedIpcSource, runAuthorizedIpc } from "../ipc-security";

let pass = 0;
let fail = 0;

function ok(name: string, condition: unknown): void {
  if (condition) {
    pass += 1;
    console.log("  PASS  " + name);
  } else {
    fail += 1;
    console.log("  FAIL  " + name);
  }
}

void (async () => {
  const mainFrame = {};
  const webContents = { mainFrame };

  console.log("\n=== IPC source authorization ===");
  ok("viewer main frame is trusted", isTrustedIpcSource({ sender: webContents, senderFrame: mainFrame }, webContents));
  ok("another webContents is rejected", !isTrustedIpcSource({ sender: {}, senderFrame: mainFrame }, webContents));
  ok("a child frame is rejected", !isTrustedIpcSource({ sender: webContents, senderFrame: {} }, webContents));
  ok("a missing window is rejected", !isTrustedIpcSource({ sender: webContents, senderFrame: mainFrame }, null));

  let mutations = 0;
  const rejected = await runAuthorizedIpc(
    { sender: {}, senderFrame: mainFrame },
    webContents,
    () => "rejected",
    () => { mutations += 1; return "handled"; },
  );
  ok("unauthorized handlers cannot mutate state", rejected === "rejected" && mutations === 0);

  const handled = await runAuthorizedIpc(
    { sender: webContents, senderFrame: mainFrame },
    webContents,
    () => "rejected",
    () => { mutations += 1; return "handled"; },
  );
  ok("authorized handlers execute", handled === "handled" && mutations === 1);

  const safeFailure = await runAuthorizedIpc(
    { sender: webContents, senderFrame: mainFrame },
    webContents,
    () => "safe error",
    () => { throw new Error("private implementation detail"); },
  );
  ok("handler exceptions become safe results", safeFailure === "safe error");

  console.log("\n" + (fail === 0 ? "ALL " + pass + " PASSED" : pass + " passed, " + fail + " FAILED"));
  process.exit(fail === 0 ? 0 : 1);
})().catch(() => process.exit(1));
