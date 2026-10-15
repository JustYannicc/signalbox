import { threadArchiveDueAtMs } from "@t3tools/client-runtime/state/signalboxThreadKinds";
import { ProviderInstanceId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  archiveChatsAfterDaysChoices,
  chatArchiveRowLabel,
  isThreadKindUndoAction,
  threadKindSummary,
  threadKindUndoText,
  threadLeaveLabel,
} from "./threadKind.logic";
import { threadKindFromMenuId, withThreadKindItems } from "./threadKindMenu.logic";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-15T12:00:00.000Z");

const chat = (archiveDueAtMs: number | null) => ({
  kind: "chat" as const,
  switchedByWork: false,
  workStartedAt: null,
  archiveDueAtMs,
});

describe("threadKindSummary", () => {
  it("counts a chat down to when it archives itself", () => {
    expect(threadKindSummary(chat(NOW + 3 * DAY), NOW)).toBe("Chat, archives in 3d");
    expect(threadKindSummary(chat(NOW + 2 * DAY + HOUR), NOW)).toBe("Chat, archives in 3d");
    expect(threadKindSummary(chat(NOW + 5 * HOUR), NOW)).toBe("Chat, archives in 5h");
    expect(threadKindSummary(chat(NOW + 20 * 60_000), NOW)).toBe("Chat, archives in 20m");
    expect(threadKindSummary(chat(NOW - 1), NOW)).toBe("Chat, archives soon");
  });

  it("says nothing more about a chat that never archives", () => {
    expect(threadKindSummary(chat(null), NOW)).toBe("Chat");
  });

  it("says why a chat became a task", () => {
    const task = {
      kind: "task" as const,
      switchedByWork: true,
      workStartedAt: new Date(NOW - 2 * HOUR).toISOString(),
      archiveDueAtMs: null,
    };
    expect(threadKindSummary(task, NOW)).toBe("Task, started editing files 2h ago");
    expect(threadKindSummary({ ...task, workStartedAt: new Date(NOW).toISOString() }, NOW)).toBe(
      "Task, started editing files just now",
    );
    expect(threadKindSummary({ ...task, switchedByWork: false }, NOW)).toBe("Task");
  });
});

describe("chatArchiveRowLabel", () => {
  it("replaces the row's age only on the last idle day", () => {
    expect(chatArchiveRowLabel(NOW + 2 * DAY, NOW)).toBeNull();
    expect(chatArchiveRowLabel(NOW + DAY, NOW)).toBeNull();
    expect(chatArchiveRowLabel(NOW + DAY - 1, NOW)).toBe("Archives in 24h");
    expect(chatArchiveRowLabel(NOW + 3 * HOUR, NOW)).toBe("Archives in 3h");
    expect(chatArchiveRowLabel(NOW, NOW)).toBe("Archives soon");
    expect(chatArchiveRowLabel(null, NOW)).toBeNull();
  });
});

describe("threadKindUndoText", () => {
  it("names what the flip made of the threads", () => {
    expect(threadKindUndoText("Made a task", 1)).toBe("Made 1 thread a task");
    expect(threadKindUndoText("Made a chat", 3)).toBe("Made 3 threads chats");
  });

  it("leaves every other undoable action to the notice", () => {
    expect(isThreadKindUndoAction("Made a task")).toBe(true);
    expect(isThreadKindUndoAction("Archived")).toBe(false);
    expect(isThreadKindUndoAction("toString")).toBe(false);
  });
});

describe("threadArchiveDueAtMs", () => {
  const idle = {
    updatedAt: new Date(NOW).toISOString(),
    archivedAt: null,
    pinnedAt: null,
    runtime: null,
  };
  const runtime = {
    status: "idle" as const,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: null,
    lastError: null,
    updatedAt: new Date(NOW).toISOString(),
  };

  it("counts an idle chat from its last change", () => {
    expect(threadArchiveDueAtMs(idle, "chat", 7)).toBe(NOW + 7 * DAY);
    expect(threadArchiveDueAtMs({ ...idle, runtime }, "chat", 7)).toBe(NOW + 7 * DAY);
  });

  it("promises nothing the sweep won't do", () => {
    expect(threadArchiveDueAtMs(idle, "task", 7)).toBeNull();
    expect(threadArchiveDueAtMs(idle, "chat", null)).toBeNull();
    expect(threadArchiveDueAtMs({ ...idle, pinnedAt: idle.updatedAt }, "chat", 7)).toBeNull();
    expect(threadArchiveDueAtMs({ ...idle, archivedAt: idle.updatedAt }, "chat", 7)).toBeNull();
    expect(
      threadArchiveDueAtMs({ ...idle, runtime: { ...runtime, status: "running" } }, "chat", 7),
    ).toBeNull();
    expect(
      threadArchiveDueAtMs(
        { ...idle, runtime: { ...runtime, activeRunId: RunId.make("run") } },
        "chat",
        7,
      ),
    ).toBeNull();
  });
});

describe("threadLeaveLabel", () => {
  it("lets tasks leave through Done and everything else through Archive", () => {
    expect(threadLeaveLabel("task")).toBe("Done");
    expect(threadLeaveLabel("chat")).toBe("Archive");
    expect(threadLeaveLabel(null)).toBe("Archive");
  });
});

describe("archiveChatsAfterDaysChoices", () => {
  it("offers a few day counts and Never", () => {
    expect(archiveChatsAfterDaysChoices(7)).toEqual([1, 3, 7, 14, 30, null]);
    expect(archiveChatsAfterDaysChoices(null)).toEqual([1, 3, 7, 14, 30, null]);
  });

  it("keeps an environment's own count in order", () => {
    expect(archiveChatsAfterDaysChoices(5)).toEqual([1, 3, 5, 7, 14, 30, null]);
  });
});

describe("withThreadKindItems", () => {
  const items = [
    { id: "rename", label: "Rename thread" },
    { id: "mark-unread", label: "Mark unread" },
    { id: "archive", label: "Archive thread", icon: "archive" },
  ];

  it("offers the flip after Rename and lets a task leave through Done", () => {
    expect(withThreadKindItems(items, "task")).toEqual([
      { id: "rename", label: "Rename thread" },
      { id: "make-chat", label: "Make it a chat", icon: "message-circle" },
      { id: "mark-unread", label: "Mark unread" },
      { id: "archive", label: "Done", icon: "check" },
    ]);
  });

  it("keeps Archive for a chat", () => {
    expect(withThreadKindItems(items, "chat").map((item) => [item.id, item.label])).toEqual([
      ["rename", "Rename thread"],
      ["make-task", "Make it a task"],
      ["mark-unread", "Mark unread"],
      ["archive", "Archive thread"],
    ]);
  });

  it("leaves menus alone where threads have no kind", () => {
    expect(withThreadKindItems(items, null)).toBe(items);
  });

  it("maps a chosen entry back to the kind it makes", () => {
    expect(threadKindFromMenuId("make-task")).toBe("task");
    expect(threadKindFromMenuId("make-chat")).toBe("chat");
    expect(threadKindFromMenuId("archive")).toBeNull();
  });
});
