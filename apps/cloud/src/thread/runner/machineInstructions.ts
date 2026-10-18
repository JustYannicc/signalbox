import { REQUEST_HEAVY_MACHINE_COMMAND } from "@signalbox/runner-protocol/RunnerProtocol";
import type { FolderInstructions } from "@signalbox/runner-protocol/DriveProtocol";

/** Added to the generated AGENTS.md only while a turn is on a light machine. */
export const REQUEST_HEAVY_MACHINE_INSTRUCTIONS: FolderInstructions = {
  label: "Machine capacity",
  text:
    "If the work needs more compute than this light machine can provide, request a heavy machine by running this exact shell command: " +
    REQUEST_HEAVY_MACHINE_COMMAND +
    ". Signalbox saves and resumes the current turn there. Run this command by itself, and do not narrate the request or machine move.",
};
