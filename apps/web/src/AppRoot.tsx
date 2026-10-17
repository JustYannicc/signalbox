import { RouterProvider } from "@tanstack/react-router";

import { BrowserProfileReporter } from "./browser/BrowserProfileReporter";
import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { PersonTimezoneReporter } from "./connection/PersonTimezoneReporter";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

/**
 * The Electron browser host intentionally sits outside the router so its
 * webviews survive route transitions, but it must share the same atom registry
 * as routed UI.
 */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <PersonTimezoneReporter />
      <RouterProvider router={router} />
      <ElectronBrowserHost />
      <BrowserProfileReporter />
      <QuitHoldOverlay />
    </AppAtomRegistryProvider>
  );
}
