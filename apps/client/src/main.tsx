import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./ui-surfaces.css";

const root = document.getElementById("root")!;
// Developer prototype (docs/host-browser.md): the Vite dev server only. In a production build this branch is
// removed with its import, so no host browser code or entry point ships.
if (import.meta.env.DEV && new URLSearchParams(location.search).get("hostBrowserDev") === "1") {
  void import("./hostBrowser/HostBrowserDev").then(({ mountHostBrowserDev }) => mountHostBrowserDev(root));
} else {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
