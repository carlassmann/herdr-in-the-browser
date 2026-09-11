import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const loopback = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
if ("serviceWorker" in navigator && !loopback) {
  void navigator.serviceWorker.register("/sw.js");
}

const syncViewportHeight = () => {
  const height = window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${height}px`);
};
syncViewportHeight();
window.visualViewport?.addEventListener("resize", syncViewportHeight);
window.visualViewport?.addEventListener("scroll", syncViewportHeight);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
