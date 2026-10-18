import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Atom, AsyncResult } from "effect/reactivity";

const storage = vi.hoisted(() => {
  const entries = new Map<string, string>();
  const value = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, item: string) => {
      entries.set(key, item);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
    clear: () => entries.clear(),
  };
  vi.stubGlobal("localStorage", value);
  return value;
});

const mocks = vi.hoisted(() => ({
  connectionStateAtom: vi.fn(),
  createAssetUrl: vi.fn(),
  createUploadUrl: Symbol("create-upload-url"),
  executeAtomQuery: vi.fn(),
  removeUpload: Symbol("remove-upload"),
  runAtomCommand: vi.fn(),
  readEnvironmentScope: vi.fn(),
  readPreparedConnection: vi.fn(),
}));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  executeAtomQuery: mocks.executeAtomQuery,
  runAtomCommand: mocks.runAtomCommand,
  squashAtomCommandFailure: (result: { readonly error: unknown }) => result.error,
}));

vi.mock("../../rpc/atomRegistry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});

vi.mock("../../connection/catalog", () => ({
  environmentCatalog: { stateAtom: mocks.connectionStateAtom },
}));

vi.mock("../../state/assets", () => ({
  assetEnvironment: { createUrl: mocks.createAssetUrl },
}));

vi.mock("../../state/attachments", () => ({
  attachmentEnvironment: {
    createUploadUrl: mocks.createUploadUrl,
    remove: mocks.removeUpload,
  },
}));

vi.mock("../../state/session", () => ({
  readEnvironmentScope: mocks.readEnvironmentScope,
  readPreparedConnection: mocks.readPreparedConnection,
}));

import {
  DraftId,
  useComposerDraftStore,
  type ComposerFileAttachment,
} from "../../composerDraftStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  releaseAttachmentUpload,
  readAttachmentUpload,
  useAttachmentUploadStore,
} from "../../lib/attachmentUploadQueue";
import { startCaptureUploadsAndPersistFiles } from "./captureUploadPersistence";

class TestXmlHttpRequest {
  static requests: TestXmlHttpRequest[] = [];
  static waiters: Array<(request: TestXmlHttpRequest) => void> = [];

  status = 0;
  timeout = 0;
  readonly listeners = new Map<string, () => void>();
  readonly upload = {
    addEventListener: (_event: string, _listener: (event: unknown) => void) => {},
  };

  constructor() {
    TestXmlHttpRequest.requests.push(this);
    TestXmlHttpRequest.waiters.shift()?.(this);
  }

  open(_method: string, _url: string): void {}
  setRequestHeader(_name: string, _value: string): void {}
  send(_file: File): void {}
  abort(): void {
    this.listeners.get("abort")?.();
  }
  addEventListener(event: string, listener: () => void): void {
    this.listeners.set(event, listener);
  }
  complete(status = 204): void {
    this.status = status;
    this.listeners.get("load")?.();
  }
}

const environmentId = EnvironmentId.make("capture-upload-environment");
const projectRef = scopeProjectRef(environmentId, ProjectId.make("capture-upload-project"));
const connectionStates = Atom.family((_environmentId: EnvironmentId) =>
  Atom.make(AsyncResult.success({ phase: "connected" })),
);

function resetDraftStore() {
  useComposerDraftStore.setState({
    rewindingThreadKeys: new Set(),
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyOptionsByModelByProvider: {},
    stickyActiveProvider: null,
  });
}

function waitForRequest(): Promise<TestXmlHttpRequest> {
  return new Promise((resolve) => TestXmlHttpRequest.waiters.push(resolve));
}

describe("capture upload persistence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    storage.clear();
    resetDraftStore();
    vi.runOnlyPendingTimers();
    storage.clear();

    mocks.connectionStateAtom.mockImplementation(connectionStates);
    appAtomRegistry.set(
      connectionStates(environmentId),
      AsyncResult.success({ phase: "connected" }),
    );
    mocks.createAssetUrl.mockReset().mockImplementation((target: unknown) => target);
    mocks.executeAtomQuery.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
    mocks.readEnvironmentScope.mockReset().mockReturnValue(true);
    mocks.readPreparedConnection.mockReset().mockReturnValue({
      httpBaseUrl: "https://capture-upload.test/",
    });
    mocks.runAtomCommand.mockReset().mockImplementation(
      async (
        _registry: unknown,
        command: unknown,
        target: {
          readonly environmentId: EnvironmentId;
          readonly input: { readonly name?: string };
        },
      ) => {
        if (command === mocks.createUploadUrl) {
          const attachmentId = `uploaded-${target.input.name}-${
            TestXmlHttpRequest.requests.length + 1
          }`;
          return {
            _tag: "Success",
            value: {
              attachmentId,
              relativeUrl: `/api/attachments/upload/${attachmentId}`,
              expiresAt: 1,
            },
          };
        }
        return { _tag: "Success", value: undefined };
      },
    );
    TestXmlHttpRequest.requests = [];
    TestXmlHttpRequest.waiters = [];
    vi.stubGlobal("XMLHttpRequest", TestXmlHttpRequest);
  });

  afterEach(() => {
    for (const imageId of Object.keys(useAttachmentUploadStore.getState().uploadsByImageId)) {
      releaseAttachmentUpload(imageId);
    }
    resetDraftStore();
    vi.runOnlyPendingTimers();
    storage.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("retries a failed file upload in the same environment", async () => {
    const draftId = DraftId.make("capture-upload-draft");
    const fileContents = new File(["pdf bytes"], "report.pdf", { type: "application/pdf" });
    const file: ComposerFileAttachment = {
      type: "file",
      id: "capture:file:report",
      name: fileContents.name,
      mimeType: fileContents.type,
      sizeBytes: fileContents.size,
      file: fileContents,
    };
    useComposerDraftStore.getState().setProjectDraftThreadId(projectRef, draftId, {
      threadId: ThreadId.make("capture-upload-thread"),
    });
    useComposerDraftStore.getState().addFiles(draftId, [file], { appendReference: true });
    await useComposerDraftStore.getState().syncPersistedAttachments(draftId, []);

    const input = {
      draftId,
      environmentId,
      files: [file],
      uploadsSupported: true,
      maxFileBytes: 1024,
    };
    const firstRequest = waitForRequest();
    const firstAttempt = startCaptureUploadsAndPersistFiles(input);
    (await firstRequest).complete(503);
    await expect(firstAttempt).resolves.toBe(false);
    expect(readAttachmentUpload(file.id)).toMatchObject({
      status: "failed",
      environmentId,
    });

    const retryRequest = waitForRequest();
    const retryAttempt = startCaptureUploadsAndPersistFiles(input);
    (await retryRequest).complete();
    await expect(retryAttempt).resolves.toBe(true);
    expect(readAttachmentUpload(file.id)).toMatchObject({
      status: "ready",
      environmentId,
      attachmentId: "uploaded-report.pdf-2",
    });
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.files[0]).toMatchObject({
      uploadedAttachmentId: "uploaded-report.pdf-2",
      uploadEnvironmentId: environmentId,
    });
    expect(TestXmlHttpRequest.requests).toHaveLength(2);
  });
});
