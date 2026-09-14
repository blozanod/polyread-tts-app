import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import "./ui/styles.css";

const host = document.getElementById("root");
if (!host) throw new Error("no #root");

// No StrictMode: its development double-mount would start two pipeline workers
// and two AudioContexts, and the second of each would fight the first over the
// same IndexedDB and the same output device.
createRoot(host).render(<App />);
