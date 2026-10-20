import type { Computer } from "../../computer/Computer.ts";
import type { KernelProgramHost } from "../../kernel/KernelProgramHost.ts";
import type { KernelSessionStdio } from "../../kernel/KernelSessionStdio.ts";
import type { KernelExitStatus } from "../../kernel/KernelProcessTable.ts";
import type { EnvironmentInfo } from "../../kernel/CodexExecProtocol.ts";
import type { HarnessOwnedProcess } from "../HarnessProcessLifetime.ts";
export interface CodexHarnessProcessOptions {
  readonly engine: WebAssembly.Module;
  readonly computer: Computer;
  readonly host: KernelProgramHost;
  readonly stdio: KernelSessionStdio;
  readonly environment: Readonly<Record<string, string>>;
  readonly bootstrap: {
    readonly type: "bootstrap";
    readonly codex_home: string;
    readonly cwd: string;
    readonly overrides: Readonly<Record<string, unknown>>;
    readonly host_capabilities?: { readonly standard_form_input: boolean };
  };
  readonly environmentInfo: EnvironmentInfo;
  readonly fetch: (request: Request) => Promise<Response>;
  readonly lifetime: Pick<DurableObjectState, "waitUntil">;
  readonly signal: AbortSignal;
}

export interface CodexHarnessProcess extends HarnessOwnedProcess {
  readonly ready: Promise<void>;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<KernelExitStatus>;
  readonly abort: (reason?: unknown) => Promise<void>;
  readonly dispose: () => Promise<void>;
}
