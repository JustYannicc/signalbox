import { createAutomationAtoms } from "@t3tools/client-runtime/state/automations";

import { connectionAtomRuntime } from "../connection/runtime";

export const automationState = createAutomationAtoms(connectionAtomRuntime);
