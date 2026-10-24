import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { captureDestinationAvailable } from "./captureInput";
import { createDesktopPanelDraftStorage, type DesktopPanelDraft } from "./desktopPanelDraft";

const destination = {
  key: "account-one:top",
  environmentId: EnvironmentId.make("environment"),
  ownerProjectId: ProjectId.make("account-one"),
  folderId: null,
  label: "Top level",
  detail: null,
  inPlace: "at the top level",
};
const draft = (text: string): DesktopPanelDraft => ({
  id: "capture-id",
  capture: { text, destination, files: [] },
});
const storage = () => createDesktopPanelDraftStorage(indexedDB);

beforeEach(async () => {
  await storage().write(null);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("desktop panel draft persistence", () => {
  it("restores text, destination, identity and stopped voice/file bytes from a new storage instance", async () => {
    const original = {
      ...draft("Keep this before quitting"),
      capture: {
        ...draft("Keep this before quitting").capture,
        files: [
          {
            id: "voice",
            file: new File([new Uint8Array([0, 255, 42])], "voice.webm", { type: "audio/webm" }),
          },
          { id: "file", file: new File(["hello"], "note.txt", { type: "text/plain" }) },
        ],
      },
    };
    await storage().write(original);
    const restored = await storage().read();
    expect(restored).toMatchObject({
      id: original.id,
      capture: { text: original.capture.text, destination },
    });
    expect(restored?.capture.files.map(({ id, file }) => [id, file.name, file.type])).toEqual([
      ["voice", "voice.webm", "audio/webm"],
      ["file", "note.txt", "text/plain"],
    ]);
    expect(new Uint8Array(await restored!.capture.files[0]!.file.arrayBuffer())).toEqual(
      new Uint8Array([0, 255, 42]),
    );
    expect(await restored!.capture.files[1]!.file.text()).toBe("hello");
    expect(
      captureDestinationAvailable(restored!.capture.destination, [
        { ...destination, ownerProjectId: ProjectId.make("account-two") },
      ]),
    ).toBe(false);
  });

  it("keeps the newest edit and drains it before removing a submitted draft", async () => {
    const current = storage();
    const first = current.write(draft("first"));
    const second = current.write(draft("second"));
    const third = current.write(draft("latest"));
    await Promise.all([first, second, third, current.flush()]);
    expect((await storage().read())?.capture.text).toBe("latest");
    const edit = current.write(draft("last edit"));
    const remove = current.write(null);
    await Promise.all([edit, remove]);
    expect(await storage().read()).toBeNull();
  });

  it("retains the prior snapshot when a write exceeds the text bound", async () => {
    const current = storage();
    await current.write(draft("recover me"));
    await expect(current.write(draft("x".repeat(100_001)))).rejects.toThrow("too large");
    await expect(current.flush()).rejects.toThrow("too large");
    expect((await storage().read())?.capture.text).toBe("recover me");
  });

  it("does not report request success as durability when the transaction aborts", async () => {
    const current = storage();
    await current.write(draft("recover me"));
    const put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      value,
      key,
    ) {
      const request = put.call(this, value, key);
      request.addEventListener("success", () => this.transaction.abort());
      return request;
    });
    await expect(current.write(draft("interrupted"))).rejects.toThrow("interrupted");
    await expect(current.flush()).rejects.toThrow("interrupted");
    spy.mockRestore();
    expect((await storage().read())?.capture.text).toBe("recover me");
    await current.write(draft("retry"));
    await expect(current.flush()).resolves.toBeUndefined();
    expect((await storage().read())?.capture.text).toBe("retry");
  });
});

describe("desktop panel draft commits", () => {
  it("does not block flush when deleting an already submitted draft fails", async () => {
    const current = storage();
    await current.write(draft("already queued"));
    const spy = vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(() => {
      throw new Error("delete failed");
    });
    await expect(current.write(null)).rejects.toThrow("delete failed");
    await expect(current.flush()).resolves.toBeUndefined();
    spy.mockRestore();
    expect(await storage().read()).toEqual(draft("already queued"));
  });

  it("debounces text snapshots but flush commits the latest text without waiting for the timer", async () => {
    vi.useFakeTimers();
    try {
      const put = vi.spyOn(IDBObjectStore.prototype, "put");
      const current = storage();
      const first = current.write(draft("first"));
      const latest = current.write(draft("latest"));
      expect(put).not.toHaveBeenCalled();
      await current.flush();
      await Promise.all([first, latest]);
      expect(put.mock.calls.filter(([, key]) => key === "current")).toHaveLength(1);
      expect((await storage().read())?.capture.text).toBe("latest");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reuses committed attachment bytes across text edits and rewrites them when files change", async () => {
    const current = storage();
    const files = [{ id: "file", file: new File(["original bytes"], "note.txt") }];
    const withFiles = (text: string): DesktopPanelDraft => ({
      ...draft(text),
      capture: { ...draft(text).capture, files },
    });
    const put = vi.spyOn(IDBObjectStore.prototype, "put");
    await current.write(withFiles("first"));
    await current.write(withFiles("edited"));
    expect(put.mock.calls.filter(([, key]) => key === "files")).toHaveLength(1);
    const reopened = storage();
    const restored = await reopened.read();
    if (!restored) throw new Error("Expected the saved draft");
    await reopened.write({ ...restored, capture: { ...restored.capture, text: "after restart" } });
    expect(put.mock.calls.filter(([, key]) => key === "files")).toHaveLength(1);
    await reopened.write({
      ...restored,
      capture: {
        ...restored.capture,
        files: [{ id: "file", file: new File(["new bytes"], "note.txt") }],
      },
    });
    expect(put.mock.calls.filter(([, key]) => key === "files")).toHaveLength(2);
    expect(await (await storage().read())?.capture.files[0]?.file.text()).toBe("new bytes");
  });

  it("reads a legacy v1 snapshot without rewriting or deleting it", async () => {
    const legacy = {
      ...draft("legacy text"),
      capture: {
        ...draft("legacy text").capture,
        files: [{ id: "legacy-file", file: new File(["legacy bytes"], "old.txt") }],
      },
    };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("signalbox:desktop-capture", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction("draft", "readwrite");
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
        transaction.objectStore("draft").put(legacy, "current");
      });
    } finally {
      db.close();
    }
    const put = vi.spyOn(IDBObjectStore.prototype, "put");
    const current = storage();
    const restored = await current.read();
    expect(restored?.id).toBe(legacy.id);
    expect(restored?.capture.text).toBe("legacy text");
    expect(await restored?.capture.files[0]?.file.text()).toBe("legacy bytes");
    expect(put).not.toHaveBeenCalled();
    if (!restored) throw new Error("Expected the legacy draft");
    put.mockImplementation(() => {
      throw new Error("disk full");
    });
    await expect(
      current.write({ ...restored, capture: { ...restored.capture, text: "edit" } }),
    ).rejects.toThrow("disk full");
    put.mockRestore();
    const retained = await storage().read();
    expect(retained?.capture.text).toBe("legacy text");
    expect(await retained?.capture.files[0]?.file.text()).toBe("legacy bytes");
  });
});
