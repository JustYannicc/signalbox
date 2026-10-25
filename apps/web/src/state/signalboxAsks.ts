import { createSignalboxAskCommand } from "@t3tools/client-runtime/state/signalboxAsks";

import { connectionAtomRuntime } from "../connection/runtime";

export const signalboxAskCommand = createSignalboxAskCommand(connectionAtomRuntime);
