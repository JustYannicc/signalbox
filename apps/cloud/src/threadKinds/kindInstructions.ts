import type { FolderInstructions } from "@signalbox/runner-protocol/DriveProtocol";
import type { ThreadKind } from "@t3tools/contracts/signalboxThreadKinds";

/**
 * What a thread's agent is told about its kind (#46): one level appended to
 * its chain's `AGENTS.md` (`thread/turnPool.ts`). The kind changes how the
 * agent works, never what it may do, so neither text takes a tool away.
 */

const TEXT: Record<ThreadKind, string> = {
  chat: "This thread is a chat: the person is thinking out loud, asking or researching. Help them think: answer, explore options, research. Every tool you always have is still yours. If they ask you to carry out work, do it; a turn that changes files makes the thread a task on its own.",
  task: "This thread is a task: committed work the person wants done. Carry it through to done, check it works, and say plainly when it's finished or what's left.",
};

export const kindInstructions = (kind: ThreadKind): FolderInstructions => ({
  label: "Thread kind",
  text: TEXT[kind],
});
