import type { FolderInstructions } from "@signalbox/runner-protocol/DriveProtocol";

/**
 * What every cloud turn's agent is told about the thread's status line
 * (#670): one level last on its chain's `AGENTS.md`, after its kind's
 * (`CloudThreadService.turnOf`). The Runner serves the tools it names.
 */
export const STATUS_LINE_INSTRUCTIONS: FolderInstructions = {
  label: "Status line",
  text: "Before you finish each turn, call set_thread_status with nextStep (one line: what has to happen next, and who does it) and whereItGotTo (one or two plain sentences on where the work stands, for someone who has never seen this thread). No jargon or shorthand from inside the thread. thread_status reads the line; folder_status tells you what's going on around this thread.",
};
