import {
  CredentialStore,
  type AsyncSafeStorage,
  type CredentialFileSystem,
} from "../src/credentials";
import { test } from "node:test";
import { ok } from "./support/assertions";

class MemoryFiles implements CredentialFileSystem {
  readonly files = new Map<string, Buffer>();
  readonly events: string[] = [];

  async mkdir(): Promise<void> {
    this.events.push("mkdir");
  }
  async read(file: string): Promise<Buffer> {
    this.events.push("read");
    const value = this.files.get(file);
    if (!value) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return Buffer.from(value);
  }
  async write(file: string, data: Buffer): Promise<void> {
    this.events.push("write");
    this.files.set(file, Buffer.from(data));
  }
  async remove(file: string): Promise<void> {
    this.events.push("remove");
    if (!this.files.delete(file)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
  }
}

class FakeSafeStorage implements AsyncSafeStorage {
  available = true;
  corrupt = false;
  shouldReEncrypt = false;
  encryptions = 0;

  async isAsyncEncryptionAvailable(): Promise<boolean> {
    return this.available;
  }
  async encryptStringAsync(plainText: string): Promise<Buffer> {
    this.encryptions += 1;
    return Buffer.from([...Buffer.from(plainText)].map((byte) => byte ^ 0xa5));
  }
  async decryptStringAsync(
    encrypted: Buffer,
  ): Promise<{ result: string; shouldReEncrypt: boolean }> {
    if (this.corrupt) throw new Error("cannot decrypt");
    return {
      result: Buffer.from([...encrypted].map((byte) => byte ^ 0xa5)).toString("utf8"),
      shouldReEncrypt: this.shouldReEncrypt,
    };
  }
}

test("encrypted credential lifecycle and migration", async () => {
  const file = "C:\\profile\\credential.bin";

  console.log("\n=== encrypted credential lifecycle ===");
  const files = new MemoryFiles();
  const crypto = new FakeSafeStorage();
  const store = new CredentialStore(file, crypto, files);
  ok(
    "empty profile starts unpaired",
    (await store.initialize(undefined)).status === "empty" && store.get() === null,
  );
  ok(
    "new token is encrypted and retained in memory",
    (await store.set("new-secret")) && store.get() === "new-secret",
  );
  ok(
    "credential file does not contain plaintext",
    files.files.get(file)?.includes(Buffer.from("new-secret")) === false,
  );

  const restarted = new CredentialStore(file, crypto, files);
  ok(
    "restart decrypts the stored credential",
    (await restarted.initialize(undefined)).status === "ready" && restarted.get() === "new-secret",
  );
  ok(
    "unpair clears memory and disk",
    (await restarted.clear()) && restarted.get() === null && !files.files.has(file),
  );

  console.log("\n=== migration and failure handling ===");
  const migrationFiles = new MemoryFiles();
  const migrationStore = new CredentialStore(file, crypto, migrationFiles);
  const migration = await migrationStore.initialize("legacy-secret");
  ok("plaintext token migrates", migration.status === "migrated" && migration.removeLegacyToken);
  ok(
    "migration writes before reporting completion",
    migrationFiles.events.includes("write") && migrationStore.get() === "legacy-secret",
  );

  const unavailableFiles = new MemoryFiles();
  const unavailableCrypto = new FakeSafeStorage();
  unavailableCrypto.available = false;
  const unavailable = new CredentialStore(file, unavailableCrypto, unavailableFiles);
  const unavailableResult = await unavailable.initialize("legacy-secret");
  ok(
    "unavailable encryption fails closed",
    unavailableResult.status === "unavailable" && unavailable.get() === null,
  );
  ok("unavailable migration still requests plaintext removal", unavailableResult.removeLegacyToken);

  const corruptFiles = new MemoryFiles();
  corruptFiles.files.set(file, Buffer.from("broken"));
  const corruptCrypto = new FakeSafeStorage();
  corruptCrypto.corrupt = true;
  const corrupt = new CredentialStore(file, corruptCrypto, corruptFiles);
  ok(
    "corrupt ciphertext requests re-pairing",
    (await corrupt.initialize(undefined)).status === "corrupt" && corrupt.get() === null,
  );
  ok("corrupt ciphertext is removed", !corruptFiles.files.has(file));

  const rotateFiles = new MemoryFiles();
  const rotateCrypto = new FakeSafeStorage();
  const seed = new CredentialStore(file, rotateCrypto, rotateFiles);
  await seed.set("rotate-me");
  const encryptionsBeforeRestart = rotateCrypto.encryptions;
  rotateCrypto.shouldReEncrypt = true;
  const rotated = new CredentialStore(file, rotateCrypto, rotateFiles);
  ok(
    "key rotation rewrites the credential",
    (await rotated.initialize(undefined)).status === "ready" &&
      rotateCrypto.encryptions === encryptionsBeforeRestart + 1 &&
      rotated.get() === "rotate-me",
  );

  ok(
    "oversized replacement tokens are rejected transactionally",
    !(await rotated.set("x".repeat(8_193))) && rotated.get() === "rotate-me",
  );
});
