import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { TorsorApp } from "./App";
import { WebController } from "./controller";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("The Torsor web root element is missing.");
}

const controller = new WebController({
  apiBase: import.meta.env.VITE_TORSOR_API_BASE ?? "",
});
window.addEventListener(
  "pagehide",
  (event) => {
    if (!(event as PageTransitionEvent).persisted) {
      controller.dispose();
    }
  },
);

createRoot(root).render(
  <StrictMode>
    <TorsorApp controller={controller} />
  </StrictMode>,
);
