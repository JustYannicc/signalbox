import { ThreadId } from "@t3tools/contracts";
import { type TrashEntry, TrashEntryId } from "@t3tools/contracts/signalboxTrash";
import { describe, expect, it } from "vite-plus/test";

import {
  serverConfigSupportsSignalboxTrash,
  trashEmptyConfirmation,
  trashEntriesShown,
  trashEntryState,
  trashEntryRestorable,
  trashEntrySummary,
  trashHasPendingWork,
  threadDeleteConfirmationMessage,
} from "./signalboxTrash.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;

const entry = (id: string, extra: Partial<TrashEntry> = {}): TrashEntry => ({
  id: TrashEntryId.make(id),
  kind: "thread",
  targetId: id,
  title: id,
  deletedAt: NOW - DAY,
  purgeAfter: NOW + 29 * DAY,
  status: "trashed",
  threadIds: [ThreadId.make(id)],
  removals: [],
  error: null,
  ...extra,
});

const folder = (id: string, threads: number) =>
  entry(id, {
    kind: "folder",
    threadIds: Array.from({ length: threads }, (_, index) => ThreadId.make(`${id}-${index}`)),
  });

describe("signalboxTrash", () => {
  it("uses the folders capability to identify cloud Trash", () => {
    expect(serverConfigSupportsSignalboxTrash(null)).toBe(false);
    expect(
      serverConfigSupportsSignalboxTrash({ environment: { capabilities: { folders: true } } }),
    ).toBe(true);
    expect(
      serverConfigSupportsSignalboxTrash({ environment: { capabilities: { folders: false } } }),
    ).toBe(false);
  });

  it("uses Trash copy for cloud deletion and explains mixed bulk deletion", () => {
    expect(threadDeleteConfirmationMessage({ cloud: true, other: false, scope: "thread" })).toBe(
      "This thread will move to Trash and can be restored for 30 days.",
    );
    expect(threadDeleteConfirmationMessage({ cloud: true, other: true, scope: "threads" })).toBe(
      "Cloud threads will move to Trash and can be restored for 30 days. Threads in other environments will be permanently deleted.",
    );
    expect(threadDeleteConfirmationMessage({ cloud: false, other: true, scope: "thread" })).toBe(
      "This permanently clears conversation history for this thread.",
    );
  });

  it("shows what's still in Trash, newest first", () => {
    const shown = trashEntriesShown({
      purgeEnabled: true,
      entries: [
        entry("old", { deletedAt: NOW - 3 * DAY }),
        entry("back", { status: "restored" }),
        entry("gone", { status: "purged" }),
        entry("new", { deletedAt: NOW }),
        entry("going", { status: "purging" }),
      ],
    });
    expect(shown.map((item) => item.id)).toEqual(["new", "going", "old"]);
  });

  it("only polls while something is restoring or purging", () => {
    expect(trashHasPendingWork({ purgeEnabled: true, entries: [entry("a")] })).toBe(false);
    expect(
      trashHasPendingWork({ purgeEnabled: true, entries: [entry("a", { status: "restoring" })] }),
    ).toBe(true);
  });

  it("says when an item goes for good only while that's switched on", () => {
    expect(trashEntrySummary(folder("work", 3), true, NOW)).toBe(
      "Folder · 3 threads · Deleted for good in 29 days",
    );
    expect(trashEntrySummary(folder("work", 1), false, NOW)).toBe(
      "Folder · 1 thread · Restorable for 29 days",
    );
    expect(trashEntrySummary(entry("late", { purgeAfter: NOW - 1 }), true, NOW)).toBe(
      "Thread · Deleted for good soon",
    );
  });

  it("ends restore availability at the deadline even while cleanup is disabled", () => {
    const expiring = entry("late", { purgeAfter: NOW });
    expect(trashEntryRestorable(expiring, NOW - 1)).toBe(true);
    expect(trashEntryRestorable(expiring, NOW)).toBe(false);
    expect(trashEntrySummary(expiring, false, NOW)).toBe("Thread · Restore window ended");
  });

  it("names an entry's state when it isn't just waiting", () => {
    expect(trashEntryState(entry("a"))).toBeNull();
    expect(trashEntryState(entry("a", { status: "restoring" }))).toEqual({
      text: "Restoring…",
      failed: false,
    });
    expect(trashEntryState(entry("a", { error: "Its folder is gone" }))).toEqual({
      text: "Its folder is gone",
      failed: true,
    });
    expect(
      trashEntryState(
        entry("a", { status: "purging", error: "Storage is unavailable. Cleanup will retry." }),
      ),
    ).toEqual({
      text: "Storage is unavailable. Cleanup will retry.",
      failed: true,
    });
  });

  it("asks before deleting for good, naming what goes", () => {
    expect(trashEmptyConfirmation([folder("Work", 2)], false)).toEqual({
      title: "Delete “Work” forever?",
      message:
        "“Work” and everything in it will be deleted for good, including history and files. This can't be undone.",
      confirmText: "Delete forever",
    });
    expect(trashEmptyConfirmation([folder("Work", 2), entry("Plan")], true)).toEqual({
      title: "Empty Trash?",
      message:
        "2 items, with 3 threads, will be deleted for good, including history and files. This can't be undone.",
      confirmText: "Empty Trash",
    });
  });
});
