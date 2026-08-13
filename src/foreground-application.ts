import * as path from "node:path";
import koffi from "koffi";

export interface ForegroundApplicationProbe {
  isEveClientForeground(): Promise<boolean>;
}

export interface Win32ForegroundBindings {
  getForegroundWindow(): unknown;
  getWindowThreadProcessId(window: unknown, processId: unknown[]): number;
  openProcess(access: number, inheritHandle: boolean, processId: number): unknown;
  queryFullProcessImageName(
    process: unknown,
    flags: number,
    executablePath: Buffer,
    size: unknown[],
  ): boolean;
  closeHandle(handle: unknown): boolean;
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const MAX_WINDOWS_PATH_CHARS = 32_768;
const EVE_CLIENT_EXECUTABLES = new Set(["exefile.exe"]);

export function createWin32ForegroundBindings(): Win32ForegroundBindings | null {
  if (process.platform !== "win32" || process.arch !== "x64") return null;
  try {
    const user32 = koffi.load("user32.dll");
    const kernel32 = koffi.load("kernel32.dll");
    return {
      getForegroundWindow: user32.func("void * __stdcall GetForegroundWindow(void)"),
      getWindowThreadProcessId: user32.func(
        "uint32_t __stdcall GetWindowThreadProcessId(void *window, _Out_ uint32_t *processId)",
      ),
      openProcess: kernel32.func(
        "void * __stdcall OpenProcess(uint32_t access, bool inheritHandle, uint32_t processId)",
      ),
      queryFullProcessImageName: kernel32.func(
        "bool __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, " +
          "_Out_ uint16_t *executablePath, _Inout_ uint32_t *size)",
      ),
      closeHandle: kernel32.func("bool __stdcall CloseHandle(void *handle)"),
    };
  } catch {
    return null;
  }
}

export class WindowsForegroundApplicationProbe implements ForegroundApplicationProbe {
  private readonly bindings: Win32ForegroundBindings | null;
  private readonly allowedExecutables: ReadonlySet<string>;

  constructor(
    bindings: Win32ForegroundBindings | null = createWin32ForegroundBindings(),
    allowedExecutables: ReadonlySet<string> = EVE_CLIENT_EXECUTABLES,
  ) {
    this.bindings = bindings;
    this.allowedExecutables = new Set([...allowedExecutables].map((name) => name.toLowerCase()));
  }

  isAvailable(): boolean {
    return this.bindings !== null;
  }

  isEveClientForeground(): Promise<boolean> {
    return Promise.resolve(this.checkForeground());
  }

  private checkForeground(): boolean {
    const bindings = this.bindings;
    if (!bindings) return false;
    let processHandle: unknown = null;
    try {
      const window = bindings.getForegroundWindow();
      if (!window) return false;
      const processId: unknown[] = [null];
      if (!bindings.getWindowThreadProcessId(window, processId)) return false;
      const pid = processId[0];
      if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;

      processHandle = bindings.openProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
      if (!processHandle) return false;
      const executablePath = Buffer.alloc(MAX_WINDOWS_PATH_CHARS * 2);
      const size: unknown[] = [MAX_WINDOWS_PATH_CHARS];
      if (!bindings.queryFullProcessImageName(processHandle, 0, executablePath, size)) return false;
      const characters = size[0];
      if (
        typeof characters !== "number" ||
        !Number.isSafeInteger(characters) ||
        characters <= 0 ||
        characters > MAX_WINDOWS_PATH_CHARS
      ) {
        return false;
      }
      const resolvedPath = executablePath.subarray(0, characters * 2).toString("utf16le");
      if (!resolvedPath) return false;
      return this.allowedExecutables.has(path.win32.basename(resolvedPath).toLowerCase());
    } catch {
      return false;
    } finally {
      if (processHandle) {
        try {
          bindings.closeHandle(processHandle);
        } catch {
          // Process identity failures always fail closed.
        }
      }
    }
  }
}
