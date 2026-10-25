// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - a real child process reads checkpoint files and performs the held local fetch.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import { readPlainGitWorkspaceSnapshot } from "./checkpointFiles.ts";

type NativeState = {
  readonly nativeSessionId: string;
  readonly turn: number;
  readonly transcript: readonly string[];
};

type WorkspaceState = { readonly files: Readonly<Record<string, string>> };

type ParentMessage =
  | { readonly type: "step"; readonly requestId: string; readonly input: string }
  | { readonly type: "checkpoint-committed"; readonly requestId: string }
  | { readonly type: "release-callback"; readonly requestId: string }
  | { readonly type: "stop"; readonly requestId: string };

const nativePath = process.argv[2];
const workspacePath = process.argv[3];
const fetchUrl = process.argv[4];
const gitWorkspacePath = process.argv[5];
if (!nativePath || !workspacePath || !fetchUrl || !gitWorkspacePath || !process.send)
  throw new Error("Plain process fixture requires checkpoint paths and an IPC channel.");

const nativeBytes = NodeFS.readFileSync(nativePath);
const workspaceBytes = NodeFS.readFileSync(workspacePath);
let native = JSON.parse(nativeBytes.toString("utf8")) as NativeState;
let workspace = JSON.parse(workspaceBytes.toString("utf8")) as WorkspaceState;
const processNonce = NodeCrypto.randomUUID();
const digest = NodeCrypto.createHash("sha256")
  .update(nativeBytes)
  .update("\0")
  .update(workspaceBytes)
  .digest("hex");

const gates = new Map<string, () => void>();
const waitFor = (requestId: string) =>
  new Promise<void>((resolve) => gates.set(requestId, resolve));
const release = (requestId: string) => {
  const resolve = gates.get(requestId);
  if (!resolve) return false;
  gates.delete(requestId);
  resolve();
  return true;
};

let active = false;
let stopRequested = false;
const send = (message: unknown) =>
  new Promise<void>((resolve, reject) => {
    if (!process.send) return reject(new Error("Plain process IPC is closed."));
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });

const close = async () => {
  if (!process.connected) return;
  await send({ type: "stopped", processNonce });
  process.disconnect();
};

const runStep = async (message: Extract<ParentMessage, { type: "step" }>) => {
  if (active) throw new Error("Plain process fixture admits one step at a time.");
  active = true;
  native = {
    ...native,
    turn: native.turn + 1,
    transcript: [...native.transcript, message.input],
  };
  workspace = {
    files: {
      ...workspace.files,
      "transcript.txt": native.transcript.join("\n"),
    },
  };
  const checkpointGate = waitFor(message.requestId);
  await send({ type: "checkpoint", requestId: message.requestId, native, workspace });
  await checkpointGate;

  await send({ type: "fetch-started", requestId: message.requestId });
  const response = await fetch(`${fetchUrl}?requestId=${encodeURIComponent(message.requestId)}`);
  if (!response.ok) throw new Error(`Local fetch failed with ${response.status}.`);
  const fetchResult = (await response.json()) as { readonly requestId: string };
  await send({ type: "fetch-settled", requestId: message.requestId, fetchResult });
  const callbackGate = waitFor(message.requestId);
  await send({ type: "callback", requestId: message.requestId, fetchResult });
  await callbackGate;
  active = false;
  await send({ type: "step-result", requestId: message.requestId, native, workspace });
  if (stopRequested) await close();
};

void send({
  type: "ready",
  processId: process.pid,
  processNonce,
  nativeSessionId: native.nativeSessionId,
  native,
  workspace,
  checkpointDigest: digest,
  gitWorkspace: readPlainGitWorkspaceSnapshot(gitWorkspacePath),
});

process.on("message", (value: unknown) => {
  const message = value as ParentMessage;
  if (message.type === "checkpoint-committed") {
    release(message.requestId);
  } else if (message.type === "release-callback") {
    release(message.requestId);
  } else if (message.type === "stop") {
    stopRequested = true;
    void send({ type: "stop-acknowledged", requestId: message.requestId }).then(() => {
      if (!active) return close();
    });
  } else {
    void runStep(message);
  }
});
