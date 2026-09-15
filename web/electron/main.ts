import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";

/**
 * Point Chromium at the fastest GPU in the machine, before it starts.
 *
 * The renderer can rank the adapters it is offered — `synthesis/gpu.ts` does —
 * but it cannot conjure one Chromium did not initialize. On a laptop with
 * switchable graphics the browser process decides which physical GPU its GPU
 * process talks to, and left alone it decides in favour of battery life. So
 * these are set here, in the only place they can be: before `app.whenReady()`,
 * because Chromium reads its command line once and the GPU process is already
 * running by the time a window exists.
 *
 * What each is for:
 *
 *  - `force_high_performance_gpu` is the one that matters. It is what makes
 *    `requestAdapter({ powerPreference: "high-performance" })` return the
 *    discrete card on macOS and Windows rather than the integrated one.
 *  - `ignore-gpu-blocklist` keeps a driver Chromium distrusts for *rendering*
 *    reasons — the blocklist is largely about video decode and canvas
 *    corruption — from taking compute with it. Synthesis is a compute shader
 *    writing into a buffer we read back; nothing it does reaches the screen.
 *  - `enable-unsafe-webgpu` turns WebGPU on where it is still behind a flag,
 *    which on Linux it may be, and unlocks the adapter toggles Dawn keeps
 *    behind it.
 *  - `allow_unsafe_apis` is Dawn's own gate, and ONNX Runtime's subgroup
 *    kernels — the fast path for every reduction in the model — are behind it.
 *  - `Vulkan` is how Dawn reaches the GPU on Linux at all.
 *
 * `POLYREAD_GPU=off` turns the whole thing off and runs on the CPU, which is
 * what you want on a machine whose driver is the problem.
 */
function configureGpu(): void {
  const preference = (process.env.POLYREAD_GPU ?? "").toLowerCase();
  if (preference === "off" || preference === "cpu") {
    app.disableHardwareAcceleration();
    return;
  }

  app.commandLine.appendSwitch("force_high_performance_gpu");
  app.commandLine.appendSwitch("ignore-gpu-blocklist");
  app.commandLine.appendSwitch("enable-unsafe-webgpu");
  app.commandLine.appendSwitch("enable-dawn-features", "allow_unsafe_apis");
  if (process.platform === "linux") {
    app.commandLine.appendSwitch("enable-features", "Vulkan");
  }

  // A GPU reset — a driver timeout under a long render is the realistic way to
  // get one — otherwise has Chromium blocklist 3D for this origin, and the app
  // spends the rest of its life on the CPU without saying so.
  app.disableDomainBlockingFor3DAPIs();

  // NVIDIA's PRIME offload on Linux is not a Chromium switch: it is three
  // environment variables read by the GLX and Vulkan loaders when the process
  // starts. Without them an Optimus laptop hands out the Intel iGPU and there
  // is no adapter to rank. They are set only where an NVIDIA driver is
  // actually loaded, because on a machine without one they would point the
  // loader at a vendor library that is not there.
  if (process.platform === "linux" && existsSync("/proc/driver/nvidia/version")) {
    process.env.__NV_PRIME_RENDER_OFFLOAD = "1";
    process.env.__GLX_VENDOR_LIBRARY_NAME = "nvidia";
    process.env.__VK_LAYER_NV_optimus = "NVIDIA_only";
  }
}

configureGpu();

/**
 * The desktop shell.
 *
 * ## Why it serves over http rather than loading file://
 *
 * Three things need a real origin:
 *
 *  - **Multi-threaded WebAssembly.** ONNX Runtime only uses more than one thread
 *    when `crossOriginIsolated` is true, which needs COOP and COEP response
 *    headers. Over `file://` there are no headers, so synthesis runs
 *    single-threaded and roughly four times slower.
 *  - **Storage.** IndexedDB on an opaque `file://` origin is unreliable across
 *    platforms, and the whole audio cache lives there.
 *  - **Workers.** The pipeline worker and pdf.js's worker are module workers,
 *    which `file://` refuses to load in Chromium.
 *
 * So the built site is served from 127.0.0.1 on an ephemeral port, to which
 * nothing outside this machine can connect.
 */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".bin": "application/octet-stream",
  ".data": "application/octet-stream",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

const siteRoot = resolve(__dirname, "..", "dist");
let pendingOpen: string | undefined;
let mainWindow: BrowserWindow | undefined;

function serve(): Promise<string> {
  return new Promise((resolveUrl, reject) => {
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      void handle(request, response).catch(() => {
        response.writeHead(500);
        response.end("internal error");
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address) resolveUrl(`http://127.0.0.1:${address.port}/`);
      else reject(new Error("could not bind a local port"));
    });
  });
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const requested = decodeURIComponent(url.pathname);
  // Normalize before joining, and confirm the result is still inside the site
  // root, so a "..%2f" cannot walk out of it.
  const candidate = resolve(siteRoot, `.${normalize(requested)}`);
  const inside = candidate === siteRoot || candidate.startsWith(siteRoot + sep);
  const target = inside ? candidate : siteRoot;

  let file = target;
  try {
    const info = await stat(file);
    if (info.isDirectory()) file = join(file, "index.html");
  } catch {
    // Unknown path: hand back the app shell, as a static host would.
    file = join(siteRoot, "index.html");
  }

  const headers: Record<string, string> = {
    "Content-Type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
    // The two headers the whole local server exists for.
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": "no-cache",
  };

  try {
    const info = await stat(file);
    headers["Content-Length"] = String(info.size);
    response.writeHead(200, headers);
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404, headers);
    response.end("not found");
  }
}

function buildMenu(): void {
  const isMac = process.platform === "darwin";
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Open PDF…",
          accelerator: "CmdOrCtrl+O",
          click: () => void openDialog(),
        },
        { type: "separator" },
        isMac ? { role: "close" as const } : { role: "quit" as const },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      role: "help",
      submenu: [
        {
          label: "PolyRead on GitHub",
          click: () => void shell.openExternal("https://github.com/blozanod/polyread-tts-app"),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function openDialog(): Promise<void> {
  if (!mainWindow) return;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  const path = result.filePaths[0];
  if (path) await sendFile(path);
}

async function sendFile(path: string): Promise<void> {
  if (!mainWindow) {
    pendingOpen = path;
    return;
  }
  const bytes = await readFile(path);
  mainWindow.webContents.send("polyread:open-file", {
    name: path.split(/[\\/]/).pop() ?? "document.pdf",
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });
}

function pdfFromArgv(argv: string[]): string | undefined {
  return argv.slice(1).find((arg) => arg.toLowerCase().endsWith(".pdf") && !arg.startsWith("-"));
}

async function createWindow(url: string): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 420,
    minHeight: 480,
    backgroundColor: "#fbfaf8",
    title: "PolyRead",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Nothing in this app needs to open a second window or navigate away.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, target) => {
    if (!target.startsWith(url)) event.preventDefault();
  });

  await mainWindow.loadURL(url);
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });

  if (pendingOpen) {
    const path = pendingOpen;
    pendingOpen = undefined;
    mainWindow.webContents.once("did-finish-load", () => void sendFile(path));
  }
}

// One instance, so "Open with PolyRead" on an already-running app reuses it.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const path = pdfFromArgv(argv);
    if (path) void sendFile(path);
    mainWindow?.focus();
  });

  app.on("open-file", (event, path) => {
    event.preventDefault();
    void sendFile(path);
  });

  pendingOpen = pdfFromArgv(process.argv);

  void app.whenReady().then(async () => {
    ipcMain.handle("polyread:open-dialog", () => openDialog());
    buildMenu();
    const url = await serve();
    await createWindow(url);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow(url);
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
