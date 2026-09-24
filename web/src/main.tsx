import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import { ensureCrossOriginIsolation } from "./ui/isolation";
import "./ui/styles.css";

const host = document.getElementById("root");
if (!host) throw new Error("no #root");

// Before the app, because the pipeline worker it starts takes the page's
// isolation with it: a worker created before the reload would stay on one
// thread for the life of the session. Only a first visit to a host that cannot
// send the headers itself ever waits here.
void ensureCrossOriginIsolation().then((state) => {
  if (state === "reloading") return;
  // No StrictMode: its development double-mount would start two pipeline
  // workers and two AudioContexts, and the second of each would fight the
  // first over the same IndexedDB and the same output device.
  createRoot(host).render(<App />);
});
