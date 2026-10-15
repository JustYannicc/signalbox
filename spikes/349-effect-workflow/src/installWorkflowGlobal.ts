// Imported first so compiled automation modules find `workflow` while they evaluate.
import { installWorkflowGlobal } from "./guest.ts";

installWorkflowGlobal();
