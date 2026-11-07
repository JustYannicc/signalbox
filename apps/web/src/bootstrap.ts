import { showBootError } from "./lib/bootError";

// Bundled dev can move UI code into shared chunks. Load it only after this
// entry runs the React refresh preamble, and catch failures before React mounts.
// signalbox: the capture panel shares UI, never the main renderer's connections.
const capturePanel =
  typeof window !== "undefined" &&
  window.desktopBridge &&
  window.location.hash?.split("?")[0] === "#/capture";
void (capturePanel ? import("./components/capture/desktopCaptureEntry") : import("./main"))
  .then(({ startup }) => startup)
  .catch(showBootError);
