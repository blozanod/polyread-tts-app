import { desktopBridge } from "./desktop";

/**
 * Makes the page cross-origin isolated where the host could not, so ONNX
 * Runtime may use more than one CPU thread. See `public/isolation-sw.js`.
 *
 * The service worker only affects pages it controls, and a page is not
 * controlled by a worker registered after it loaded — so the first visit
 * registers it and reloads once. Every later visit starts controlled and
 * isolated, and pays nothing. A browser that will not isolate a page this way
 * is left as it was: the reload is attempted once per session, never in a
 * loop, and the app works either way, just on fewer threads.
 */
export type IsolationState = "isolated" | "reloading" | "unavailable";

const RELOADED = "polyread.isolation.reloaded";

export async function ensureCrossOriginIsolation(): Promise<IsolationState> {
  if (globalThis.crossOriginIsolated) return "isolated";
  // The desktop build serves itself with the headers already; a page that is
  // not a secure context cannot have a service worker at all.
  if (desktopBridge() || !window.isSecureContext || !("serviceWorker" in navigator)) return "unavailable";

  try {
    const registration = await navigator.serviceWorker.register(new URL("./isolation-sw.js", document.baseURI), {
      scope: "./",
    });
    // Controlled and still not isolated: the browser will not do it this way.
    if (navigator.serviceWorker.controller) return "unavailable";
    if (readFlag()) return "unavailable";
    writeFlag();
    await activated(registration);
    window.location.reload();
    return "reloading";
  } catch {
    return "unavailable";
  }
}

function activated(registration: ServiceWorkerRegistration): Promise<void> {
  const worker = registration.installing ?? registration.waiting ?? registration.active;
  if (!worker || worker.state === "activated") return Promise.resolve();
  return new Promise((resolve) => {
    worker.addEventListener("statechange", () => {
      if (worker.state === "activated") resolve();
    });
    // A worker that never activates must not leave the app unrendered.
    setTimeout(resolve, 3000);
  });
}

function readFlag(): boolean {
  try {
    return sessionStorage.getItem(RELOADED) !== null;
  } catch {
    return true;
  }
}

function writeFlag(): void {
  try {
    sessionStorage.setItem(RELOADED, "1");
  } catch {
    // No session storage means no way to guard the reload; `readFlag` already
    // said not to attempt it.
  }
}
