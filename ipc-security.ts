export interface IpcEventLike {
  sender: unknown;
  senderFrame: unknown;
}

export interface WebContentsLike {
  mainFrame: unknown;
}

export function isTrustedIpcSource(event: IpcEventLike, webContents: WebContentsLike | null): boolean {
  return webContents !== null && event.sender === webContents && event.senderFrame === webContents.mainFrame;
}

export async function runAuthorizedIpc<T>(
  event: IpcEventLike,
  webContents: WebContentsLike | null,
  rejected: () => T,
  handler: () => T | Promise<T>,
): Promise<T> {
  if (!isTrustedIpcSource(event, webContents)) return rejected();
  try {
    return await handler();
  } catch {
    return rejected();
  }
}
