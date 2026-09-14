import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const loopback = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
if ("serviceWorker" in navigator && !loopback) {
  void navigator.serviceWorker.register("/sw.js");
}

const syncViewport = () => {
  const viewport = window.visualViewport;
  const root = document.documentElement;
  root.style.setProperty(
    "--app-height",
    `${viewport?.height ?? window.innerHeight}px`,
  );
  root.style.setProperty("--app-top", `${viewport?.offsetTop ?? 0}px`);
  root.style.setProperty("--app-left", `${viewport?.offsetLeft ?? 0}px`);
  root.style.setProperty(
    "--app-width",
    `${viewport?.width ?? window.innerWidth}px`,
  );
};
syncViewport();
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", syncViewport);
  window.visualViewport.addEventListener("scroll", syncViewport);
} else {
  window.addEventListener("resize", syncViewport);
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
