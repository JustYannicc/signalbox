import { createSignalboxPersonBrowserAtoms } from "@t3tools/client-runtime/state/signalboxPersonBrowser";

import { connectionAtomRuntime } from "../connection/runtime";

export const signalboxPersonBrowser = createSignalboxPersonBrowserAtoms(connectionAtomRuntime);
