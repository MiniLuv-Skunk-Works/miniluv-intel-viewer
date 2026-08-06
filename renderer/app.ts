import type { ViewerApi } from "../contracts";
import { browserRuntime, startRenderer } from "./controller";

declare global {
  interface Window {
    milf: ViewerApi;
  }
}

export { startRenderer, type RendererRuntime } from "./controller";

if (typeof window !== "undefined" && window.milf) {
  startRenderer(window.milf, document, browserRuntime);
}
