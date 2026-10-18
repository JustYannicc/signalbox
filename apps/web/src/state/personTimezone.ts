import { createPersonTimezoneAtoms } from "@t3tools/client-runtime/state/personTimezone";

import { connectionAtomRuntime } from "../connection/runtime";

export const personTimezone = createPersonTimezoneAtoms(connectionAtomRuntime);
