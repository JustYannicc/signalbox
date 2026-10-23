// @effect-diagnostics nodeBuiltinImport:off - reads only the locally prepared, hash-pinned WASM artifact.
// @effect-diagnostics globalTimers:off - deadlines bound a stalled guest without polling.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { KERNEL_BASH_ARTIFACT } from "../../kernel/KernelBashProgram.ts";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import { createChildBash } from "../ChildBash.ts";
import { bashCredentials, childBashFixture } from "./ChildBashFixture.ts";

const bashArtifact = new URL("../../../../../.t3/1071/programs/bash.wasm", import.meta.url);
export const bashArtifactAvailable = NodeFS.existsSync(bashArtifact);
if (!bashArtifactAvailable && NodeProcess.env.SIGNALBOX_REQUIRE_BASH_ARTIFACT === "1")
  throw new Error(`Required GNU Bash test artifact is missing: ${bashArtifact.pathname}`);

let cachedModule: WebAssembly.Module | undefined;

function loadPinnedBashModule() {
  if (!bashArtifactAvailable) throw new Error("GNU Bash test artifact is unavailable");
  if (cachedModule !== undefined) return cachedModule;
  const bytes = NodeFS.readFileSync(bashArtifact);
  if (
    bytes.byteLength !== KERNEL_BASH_ARTIFACT.bytes ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== KERNEL_BASH_ARTIFACT.sha256
  )
    throw new Error("GNU Bash test artifact does not match its pin");
  cachedModule = new WebAssembly.Module(bytes);
  return cachedModule;
}

type Completion<T> =
  | { readonly kind: "completed"; readonly value: T }
  | { readonly kind: "rejected"; readonly error: unknown }
  | { readonly kind: "deadline" };

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<Completion<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ readonly kind: "deadline" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "deadline" }), milliseconds);
  });
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ kind: "completed" as const, value }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      ),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function observeReads(
  port: KernelBashPort,
  onRead: () => void,
  onFork: () => void,
): KernelBashPort {
  const observe = (request: {
    readonly name: string;
    readonly args: readonly (number | bigint)[];
  }) => {
    if (request.name === "fd_read" && Number(request.args[0]) === 0) onRead();
  };
  return {
    ...port,
    call(request) {
      observe(request);
      return port.call(request);
    },
    callBash(request) {
      observe(request);
      return port.callBash(request);
    },
    async fork() {
      const child = await port.fork();
      if (child.kind === "fork") onFork();
      return child.kind === "fork"
        ? { ...child, port: observeReads(child.port, onRead, onFork) }
        : child;
    },
  };
}

export async function startBlockedBashReaders(readerCount: number) {
  const module = loadPinnedBashModule();
  const fixture = childBashFixture({
    args: [
      "bash",
      "--noprofile",
      "--norc",
      "-c",
      `coproc F { read -r z; }; exec 5<&\${F[0]}; for i in {1..${readerCount}}; do ( read -r x <&5 ) & done; wait`,
    ],
    env: { HOME: "/workspace", PATH: "/bin", TMPDIR: "/workspace" },
  });
  const expectedReads = readerCount + 1;
  const readersEntered = Promise.withResolvers<number>();
  let readEntries = 0;
  let forks = 0;
  const running = createChildBash({
    module,
    credentials: bashCredentials,
    pid: fixture.owner.pid,
    port: observeReads(
      fixture.owner.port,
      () => {
        readEntries++;
        if (readEntries === expectedReads) readersEntered.resolve(readEntries);
      },
      () => {
        forks++;
      },
    ),
    args: fixture.context.args,
    env: fixture.context.env,
  }).run();
  const settled = running.then(
    () => undefined,
    () => undefined,
  );
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    fixture.controller.abort();
    const beforeClose = await within(settled, 15_000);
    await fixture.close();
    if (beforeClose.kind === "deadline") {
      const afterClose = await within(settled, 15_000);
      if (afterClose.kind === "deadline")
        throw new Error("Blocked Bash readers did not settle after fixture close");
    }
  };

  try {
    const startup = await within(
      Promise.race([
        readersEntered.promise,
        running.then(
          () => -1,
          () => -1,
        ),
      ]),
      30_000,
    );
    if (startup.kind !== "completed" || startup.value !== expectedReads) {
      throw new Error(
        `Only ${readEntries} fd_read(0) entries across ${forks} forks; expected ${expectedReads}`,
      );
    }
    return {
      fdReadEntries: () => readEntries,
      forkCount: () => forks,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
