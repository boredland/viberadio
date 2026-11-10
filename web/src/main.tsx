import { createRoot } from "react-dom/client";
import { App } from "./App";
import { registerServiceWorker } from "./pwa";
import "./style.css";

registerServiceWorker();
createRoot(document.getElementById("root")!).render(<App />);
