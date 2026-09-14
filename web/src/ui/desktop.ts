/**
 * The desktop shell's only contribution to the page: PDFs the operating system
 * asked PolyRead to open, from a double-click or an "Open with".
 *
 * Absent in a browser, where the drop zone and the file picker do the same job.
 */
export interface DesktopBridge {
  isDesktop: true;
  onOpenFile(handler: (file: { name: string; bytes: ArrayBuffer }) => void): () => void;
  openDialog(): Promise<void>;
}

export function desktopBridge(): DesktopBridge | undefined {
  const bridge = (window as unknown as { polyread?: DesktopBridge }).polyread;
  return bridge?.isDesktop ? bridge : undefined;
}
