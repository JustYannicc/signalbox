import React from "react";
import ReactDOM from "react-dom/client";
import "../../index.css";
import { DesktopCapturePanel } from "./DesktopCapturePanel";

export const startup = Promise.resolve().then(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <DesktopCapturePanel />
    </React.StrictMode>,
  );
});
