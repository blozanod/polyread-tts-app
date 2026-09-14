import { contextBridge, ipcRenderer } from "electron";

/**
 * The only thing the renderer gets from Node: a PDF that the operating system
 * asked this app to open, and a way to raise the file dialog from the page's
 * own UI. Everything else — the model, the audio, the cache — is ordinary web
 * platform, which is what keeps the desktop build and the hosted site the same
 * program.
 */
contextBridge.exposeInMainWorld("polyread", {
  isDesktop: true,
  onOpenFile(handler: (file: { name: string; bytes: ArrayBuffer }) => void): () => void {
    const listener = (_event: unknown, file: { name: string; bytes: ArrayBuffer }): void => handler(file);
    ipcRenderer.on("polyread:open-file", listener);
    return () => ipcRenderer.off("polyread:open-file", listener);
  },
  openDialog(): Promise<void> {
    return ipcRenderer.invoke("polyread:open-dialog");
  },
});
