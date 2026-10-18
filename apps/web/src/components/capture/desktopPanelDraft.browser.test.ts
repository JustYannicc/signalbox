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
