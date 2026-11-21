import { createApp } from "vue";
import App from "./App.vue";
import "./system.css";
import "./style.css";
import "./network.css";
import "./jobs.css";
import "./extensions.css";
createApp(App).mount("#app");

// PWA: register the service worker for an installable, offline-capable shell.
// Only in a secure context (https or localhost), so iOS/desktop installs work when
// served over Cloudflare Access HTTPS.
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
