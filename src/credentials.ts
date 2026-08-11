import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { VALIDATION_LIMITS, boundedString } from "./validation";

export interface AsyncSafeStorage {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  decryptStringAsync(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}

export interface CredentialFileSystem {
  mkdir(directory: string): Promise<void>;
  read(file: string): Promise<Buffer>;
  write(file: string, data: Buffer): Promise<void>;
  remove(file: string): Promise<void>;
}

export type CredentialInitializationStatus =
  "ready" | "empty" | "migrated" | "unavailable" | "corrupt";

export interface CredentialInitialization {
  status: CredentialInitializationStatus;
  removeLegacyToken: boolean;
}

const nodeFileSystem: CredentialFileSystem = {
  async mkdir(directory) {
    await nodeFs.mkdir(directory, { recursive: true });
  },
  read: nodeFs.readFile,
  async write(file, data) {
    await nodeFs.writeFile(file, data, { mode: 0o600 });
  },
  async remove(file) {
    await nodeFs.unlink(file);
  },
};

function missingFile(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

export class CredentialStore {
  private token: string | null = null;

  constructor(
    private readonly file: string,
    private readonly safeStorage: AsyncSafeStorage,
    private readonly fileSystem: CredentialFileSystem = nodeFileSystem,
  ) {}

  get(): string | null {
    return this.token;
  }

  private validToken(value: unknown): string | null {
    return boundedString(value, VALIDATION_LIMITS.token, 1);
  }

  private async encryptionAvailable(): Promise<boolean> {
    try {
      return await this.safeStorage.isAsyncEncryptionAvailable();
    } catch {
      return false;
    }
  }

  private async writeEncrypted(token: string): Promise<boolean> {
    if (!(await this.encryptionAvailable())) return false;
    try {
      const encrypted = await this.safeStorage.encryptStringAsync(token);
      if (encrypted.length === 0) return false;
      await this.fileSystem.mkdir(path.dirname(this.file));
      await this.fileSystem.write(this.file, encrypted);
      return true;
    } catch {
      return false;
    }
  }

  private async removeFile(): Promise<void> {
    try {
      await this.fileSystem.remove(this.file);
    } catch (error) {
      if (!missingFile(error)) throw error;
    }
  }

  async initialize(legacyToken: unknown): Promise<CredentialInitialization> {
    const legacy = this.validToken(legacyToken);
    const removeLegacyToken = legacyToken !== undefined;
    if (!(await this.encryptionAvailable())) {
      this.token = null;
      try {
        await this.removeFile();
      } catch {
        // Best effort: unavailable encryption already forces an unpaired state.
      }
      return { status: "unavailable", removeLegacyToken };
    }

    let encrypted: Buffer | null = null;
    try {
      encrypted = await this.fileSystem.read(this.file);
    } catch (error) {
      if (!missingFile(error)) {
        this.token = null;
        return { status: "corrupt", removeLegacyToken };
      }
    }

    if (encrypted !== null) {
      try {
        const decrypted = await this.safeStorage.decryptStringAsync(encrypted);
        const token = this.validToken(decrypted.result);
        if (token === null) throw new Error("invalid credential");
        this.token = token;
        if (decrypted.shouldReEncrypt && !(await this.writeEncrypted(token))) {
          this.token = null;
          await this.removeFile();
          return { status: "unavailable", removeLegacyToken };
        }
        return { status: "ready", removeLegacyToken };
      } catch {
        try {
          await this.removeFile();
        } catch {
          // Best effort: corrupt ciphertext is never retained in memory.
        }
        if (legacy !== null && (await this.writeEncrypted(legacy))) {
          this.token = legacy;
          return { status: "migrated", removeLegacyToken: true };
        }
        this.token = null;
        return { status: "corrupt", removeLegacyToken };
      }
    }

    if (legacy !== null) {
      if (await this.writeEncrypted(legacy)) {
        this.token = legacy;
        return { status: "migrated", removeLegacyToken: true };
      }
      this.token = null;
      return { status: "unavailable", removeLegacyToken: true };
    }

    this.token = null;
    return { status: "empty", removeLegacyToken };
  }

  async set(value: unknown): Promise<boolean> {
    const token = this.validToken(value);
    if (token === null || !(await this.writeEncrypted(token))) return false;
    this.token = token;
    return true;
  }

  async clear(): Promise<boolean> {
    this.token = null;
    try {
      await this.removeFile();
      return true;
    } catch {
      return false;
    }
  }
}
