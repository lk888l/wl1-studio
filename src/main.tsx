import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { DesktopLifecycle } from "./components/DesktopLifecycle";
import { StorageBootstrap } from "./components/StorageBootstrap";
import "./styles.css";
import "./components/piano/PianoStudio.css";
import "./components/LiquidGlass.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Application root element was not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <DesktopLifecycle />
    <StorageBootstrap><App /></StorageBootstrap>
  </StrictMode>,
);
