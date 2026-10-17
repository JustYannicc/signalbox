// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - The probe bounds and stops its compiler subprocess.
import * as NodeChildProcess from "node:child_process";
import * as NodePerfHooks from "node:perf_hooks";

export type JsonRpcMessage = {
  error?: { code: number; message: string };
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
};
type PendingMessage = {
  predicate: (message: JsonRpcMessage) => boolean;
  reject: (error: Error) => void;
  resolve: (message: JsonRpcMessage) => void;
  timer: ReturnType<typeof setTimeout>;
};
type CloseResult = {
  code: number | null;
  error?: Error;
  signal: NodeJS.Signals | null;
};
export type LspSmokeExit = Pick<CloseResult, "code" | "signal">;
export type LspSmokeShutdown = LspSmokeExit & {
  error: string | null;
  forcedTermination: boolean;
  responseReceived: boolean;
};

export class LspSmokeTimeoutError extends Error {}

export class LspSmokeClient {
  private readonly child: NodeChildProcess.ChildProcessWithoutNullStreams;
  private readonly platform: NodeJS.Platform;
  private readonly deadlineAt: number;
  private readonly messages: JsonRpcMessage[] = [];
  private readonly pending: PendingMessage[] = [];
  private readonly protocolTraceEvents: string[] = [];
  private readonly closed: Promise<CloseResult>;
  private resolveClosed!: (result: CloseResult) => void;
  private stdoutBuffer = Buffer.alloc(0);
  private stderrText = "";
  private shutdownRequestId: number | undefined;
  private shutdownAcknowledged = false;
  private serverLogMessageCount = 0;
  private isClosed = false;
  private closeResult: CloseResult | undefined;
  private protocolError: Error | undefined;
  private nextRequestId = 1;

  static spawn(
    executable: string,
    args: string[],
    cwd: string,
    platform: NodeJS.Platform,
    deadlineAt: number,
  ) {
    const wrapped =
      platform === "darwin"
        ? {
            command: "/usr/bin/time",
            args: ["-l", executable, ...args],
          }
        : platform === "linux"
          ? { command: "/usr/bin/time", args: ["-f", "LSP_PEAK_RSS_KIB=%M", executable, ...args] }
          : { command: executable, args };
    const child = NodeChildProcess.spawn(wrapped.command, wrapped.args, {
      cwd,
      detached: platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new LspSmokeClient(child, platform, deadlineAt);
  }

  private constructor(
    child: NodeChildProcess.ChildProcessWithoutNullStreams,
    platform: NodeJS.Platform,
    deadlineAt: number,
  ) {
    this.child = child;
    this.platform = platform;
    this.deadlineAt = deadlineAt;
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    child.stdout.on("data", (chunk: Buffer) => this.receiveBytes(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrText += chunk.toString("utf8");
    });
    child.stdin.on("error", (error) => {
      if (this.shutdownAcknowledged) return;
      this.protocolError = error;
      this.rejectPending(error);
    });
    child.once("error", (error) => this.finish({ code: null, error, signal: null }));
    child.once("close", (code, signal) => this.finish({ code, signal }));
  }

  private finish(result: CloseResult) {
    if (this.isClosed) return;
    this.traceEvent(
      `server exit code=${result.code ?? "null"} signal=${result.signal ?? "null"}${result.error ? ` error=${result.error.message}` : ""}`,
    );
    this.isClosed = true;
    this.closeResult = result;
    const error =
      result.error ??
      new Error(`LSP server exited with code ${result.code ?? result.signal ?? "unknown"}`);
    for (const item of this.pending.splice(0)) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.resolveClosed(result);
  }

  private receiveBytes(chunk: Buffer) {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    for (;;) {
      const headerEnd = this.stdoutBuffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.stdoutBuffer.subarray(0, headerEnd).toString("ascii");
      const length = Number(header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i)?.[1]);
      if (!Number.isFinite(length)) {
        this.protocolError = new Error("LSP response has no Content-Length header");
        this.rejectPending(this.protocolError);
        return;
      }
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.stdoutBuffer.byteLength < bodyEnd) return;
      try {
        const body = this.stdoutBuffer.subarray(bodyStart, bodyEnd).toString("utf8");
        this.stdoutBuffer = this.stdoutBuffer.subarray(bodyEnd);
        this.receive(JSON.parse(body) as JsonRpcMessage);
      } catch (error) {
        this.protocolError = error instanceof Error ? error : new Error(String(error));
        this.rejectPending(this.protocolError);
        return;
      }
    }
  }

  private receive(message: JsonRpcMessage) {
    if (message.method && message.id !== undefined && message.id !== null) {
      this.traceEvent(`server request ${message.method} id=${String(message.id)}`);
      if (this.shutdownAcknowledged) return;
      const items = (message.params as { items?: unknown[] } | undefined)?.items;
      const result =
        message.method === "workspace/configuration"
          ? (items ?? []).map(() => null)
          : message.method === "workspace/applyEdit"
            ? { applied: false }
            : null;
      this.send({ id: message.id, result });
      return;
    }
    if (
      this.shutdownRequestId !== undefined &&
      !message.method &&
      message.id === this.shutdownRequestId &&
      !message.error
    ) {
      // A response and a late server request can share the same stdout chunk.
      this.shutdownAcknowledged = true;
    }
    if (message.method) {
      if (message.method === "window/logMessage") {
        this.serverLogMessageCount += 1;
      } else {
        this.traceEvent(`server notification ${message.method}`);
      }
    } else {
      this.traceEvent(
        `server response id=${String(message.id ?? "missing")} ${message.error ? `error=${message.error.code}` : "result"}`,
      );
    }
    const index = this.pending.findIndex((item) => item.predicate(message));
    if (index < 0) {
      this.messages.push(message);
      return;
    }
    const [item] = this.pending.splice(index, 1);
    if (!item) return;
    clearTimeout(item.timer);
    item.resolve(message);
  }

  private rejectPending(error: Error) {
    for (const item of this.pending.splice(0)) {
      clearTimeout(item.timer);
      item.reject(error);
    }
  }

  private waitFor(
    predicate: (message: JsonRpcMessage) => boolean,
    description: string,
    timeoutMs?: number,
  ) {
    const index = this.messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]!);
    if (this.protocolError) return Promise.reject(this.protocolError);
    if (this.isClosed) return Promise.reject(new Error("LSP server exited before responding"));
    const remainingMs = this.deadlineAt - NodePerfHooks.performance.now();
    const waitMs = Math.min(timeoutMs ?? remainingMs, remainingMs);
    if (waitMs <= 0) {
      return Promise.reject(
        new LspSmokeTimeoutError(`LSP smoke deadline expired while waiting for ${description}`),
      );
    }
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.pending.findIndex((item) => item.timer === timer);
        if (index >= 0) this.pending.splice(index, 1);
        reject(new LspSmokeTimeoutError(`Timed out waiting for ${description}`));
      }, waitMs);
      this.pending.push({ predicate, reject, resolve, timer });
    });
  }

  private send(message: JsonRpcMessage) {
    if (this.isClosed) throw new Error("Cannot write to a closed LSP server");
    this.traceEvent(
      message.method
        ? `client ${message.id === undefined ? "notification" : "request"} ${message.method}${message.id === undefined ? "" : ` id=${String(message.id)}`}`
        : `client response id=${String(message.id ?? "missing")}`,
    );
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
    this.child.stdin.write(`Content-Length: ${body.byteLength}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  async request(method: string, params: unknown, timeoutMs?: number) {
    const id = this.nextRequestId++;
    if (method === "shutdown") this.shutdownRequestId = id;
    const response = this.waitFor(
      (message) => message.id === id,
      `${method} response id=${id}`,
      timeoutMs,
    );
    this.send({ id, method, params });
    const message = await response;
    if (message.error) throw new Error(`${method}: ${message.error.message}`);
    return message.result;
  }

  notify(method: string, params?: unknown) {
    this.send({ method, params });
  }

  waitForNotification(method: string, matches: (params: unknown) => boolean) {
    return this.waitFor(
      (message) => message.method === method && matches(message.params),
      `${method} notification`,
    );
  }

  protocolTrace() {
    const trace = this.protocolTraceEvents.slice(-32);
    if (this.serverLogMessageCount > 0) {
      trace.push(`server notification window/logMessage count=${this.serverLogMessageCount}`);
    }
    return trace.join("\n") || "(no LSP messages observed)";
  }

  recordEvent(event: string) {
    this.traceEvent(`event ${event}`);
  }

  private traceEvent(event: string) {
    this.protocolTraceEvents.push(event);
    if (this.protocolTraceEvents.length > 32) this.protocolTraceEvents.shift();
  }

  stderr() {
    return this.stderrText;
  }

  peakRssBytes() {
    const match = this.stderrText.match(/^\s*(\d+)\s+maximum resident set size\s*$/im);
    if (match) return Number(match[1]);
    const linux = this.stderrText.match(/^LSP_PEAK_RSS_KIB=(\d+)$/m);
    return linux ? Number(linux[1]) * 1024 : null;
  }

  async shutdown(): Promise<LspSmokeShutdown> {
    let responseReceived = false;
    try {
      await this.request("shutdown", undefined, 5_000);
      responseReceived = true;
      if (!this.isClosed && !this.child.stdin.destroyed) this.notify("exit");
      const result = await this.waitUntilClosed(5_000);
      // time reports its own exit status when its measured child dies from a signal.
      const crash = this.stderrText.match(
        /^(?:time: command terminated abnormally|Command terminated by signal \d+|panic:.*|fatal(?: error)?:.*)$/m,
      );
      const error =
        this.protocolError?.message ??
        result.error?.message ??
        (result.signal ? `LSP server stopped by ${result.signal}` : (crash?.[0] ?? null));
      return {
        code: result.code,
        error,
        forcedTermination: false,
        responseReceived,
        signal: result.signal,
      };
    } catch (error) {
      const processAlreadyClosed = this.isClosed;
      await this.terminate();
      const exit = this.exitStatus();
      const stderr = this.stderr().trim().slice(-2_000);
      return {
        code: exit?.code ?? null,
        error: `${error instanceof Error ? error.message : String(error)}${stderr ? `; stderr: ${stderr}` : ""}`,
        forcedTermination: !processAlreadyClosed,
        responseReceived,
        signal: exit?.signal ?? null,
      };
    }
  }

  async terminate(): Promise<LspSmokeExit | undefined> {
    const ownedPid = this.child.pid;
    if (this.isClosed || ownedPid === undefined) return this.exitStatus();
    this.signalOwnedGroup("TERM");
    const stopped = await this.waitUntilClosed(1_500, false);
    if (!stopped) {
      this.signalOwnedGroup("KILL");
      const killed = await this.waitUntilClosed(2_500, false);
      if (!killed) {
        throw new Error(`Could not confirm spawned LSP process group ${ownedPid} stopped`);
      }
      return { code: killed.code, signal: killed.signal };
    }
    return { code: stopped.code, signal: stopped.signal };
  }

  private exitStatus(): LspSmokeExit | undefined {
    return this.closeResult
      ? { code: this.closeResult.code, signal: this.closeResult.signal }
      : undefined;
  }

  private signalOwnedGroup(signal: "TERM" | "KILL") {
    const pid = this.child.pid;
    if (pid === undefined) return;
    if (this.platform === "win32") {
      const taskkill = NodeChildProcess.spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
        stdio: "ignore",
      });
      if (taskkill.error) this.child.kill(signal === "TERM" ? "SIGTERM" : "SIGKILL");
      return;
    }
    const result = NodeChildProcess.spawnSync("/bin/kill", [`-${signal}`, `-${pid}`], {
      stdio: "ignore",
    });
    if (result.error) this.child.kill(signal === "TERM" ? "SIGTERM" : "SIGKILL");
  }

  private waitUntilClosed(timeoutMs: number): Promise<CloseResult>;
  private waitUntilClosed(
    timeoutMs: number,
    throwOnTimeout: false,
  ): Promise<CloseResult | undefined>;
  private async waitUntilClosed(
    timeoutMs: number,
    throwOnTimeout = true,
  ): Promise<CloseResult | undefined> {
    if (this.closeResult) return this.closeResult;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      this.closed,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!result) {
      if (throwOnTimeout) {
        throw new LspSmokeTimeoutError("Timed out waiting for LSP process exit");
      }
      return undefined;
    }
    return result;
  }
}
