import { describe, expect, it } from "vite-plus/test";

import {
  AGENTOS_PROCESS_ERRNO,
  decodeAgentOsSpawnRequest,
  writeAgentOsPid,
  type AgentOsProcessWireResult,
} from "./AgentOsProcessWire.ts";

function ok<T>(result: AgentOsProcessWireResult<T>): T {
  expect(result.status).toBe("ok");
  if (result.status !== "ok") throw new Error("Expected a decoded request");
  return result.value;
}

function fail<T>(result: AgentOsProcessWireResult<T>, errno: number) {
  expect(result).toEqual({ status: "error", errno });
}

function encode(value: string) {
  return new TextEncoder().encode(value);
}

function terminatedStrings(values: readonly string[]) {
  return encode(values.map((value) => `${value}\0`).join(""));
}

function spawnAction(command: number, fd = 0, sourceFd = 0, flags = 0, mode = 0, path = "") {
  const pathBytes = encode(path);
  const bytes = new Uint8Array(24 + pathBytes.length);
  const view = new DataView(bytes.buffer);
  [command, fd, sourceFd, flags, mode, pathBytes.length].forEach((value, index) => {
    view.setUint32(index * 4, value >>> 0, true);
  });
  bytes.set(pathBytes, 24);
  return bytes;
}

function join(...chunks: readonly Uint8Array[]) {
  const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function fixture(
  input: {
    readonly execPath?: string;
    readonly argv?: readonly string[];
    readonly env?: readonly string[];
    readonly actions?: Uint8Array;
    readonly cwd?: string;
    readonly pidPointer?: number;
    readonly flags?: number;
    readonly processGroup?: number;
  } = {},
) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  let cursor = 32;
  const put = (bytes: Uint8Array) => {
    const pointer = cursor;
    new Uint8Array(memory.buffer, pointer, bytes.length).set(bytes);
    cursor += bytes.length + 8;
    return { pointer, length: bytes.length };
  };
  const execPath = put(encode(input.execPath ?? "/bin/tool"));
  const argv = put(terminatedStrings(input.argv ?? ["tool"]));
  const env = put(terminatedStrings(input.env ?? []));
  const actions = put(input.actions ?? new Uint8Array());
  const cwd = put(encode(input.cwd ?? "/work"));
  const pidPointer = input.pidPointer ?? 512;
  const args = [
    execPath.pointer,
    execPath.length,
    argv.pointer,
    argv.length,
    env.pointer,
    env.length,
    actions.pointer,
    actions.length,
    cwd.pointer,
    cwd.length,
    input.flags ?? 0,
    0x1234,
    0x8000_0000,
    0x20,
    0x4000_0000,
    input.processGroup ?? 0,
    pidPointer,
  ];
  return { memory, args, locations: { execPath, argv, env, actions, cwd, pidPointer } };
}

describe("AgentOS host_process spawn wire", () => {
  it("snapshots paths, argv, environment and attributes while preserving empty argv and duplicate env semantics", () => {
    const input = fixture({
      argv: ["agent", "--mode", "", ""],
      env: ["MODE=first", "MODE=last", "__proto__=safe", "=ignored", "invalid"],
      processGroup: -3,
    });
    const request = ok(decodeAgentOsSpawnRequest(input.memory, input.args));

    expect(request.execPath).toBe("/bin/tool");
    expect(request.argv).toEqual(["agent", "--mode", "", ""]);
    expect(Object.getPrototypeOf(request.env)).toBeNull();
    expect(Object.hasOwn(request.env, "__proto__")).toBe(true);
    expect(request.env.MODE).toBe("last");
    expect(request.env["__proto__"]).toBe("safe");
    expect(request.cwd).toBe("/work");
    expect(request.attributes).toEqual({
      flags: 0,
      defaultMask: { low: 0x1234, high: 0x8000_0000 },
      signalMask: { low: 0x20, high: 0x4000_0000 },
      processGroup: -3,
    });

    new Uint8Array(
      input.memory.buffer,
      input.locations.argv.pointer,
      input.locations.argv.length,
    ).fill(0);
    new Uint8Array(
      input.memory.buffer,
      input.locations.env.pointer,
      input.locations.env.length,
    ).fill(0);
    expect(request.argv).toEqual(["agent", "--mode", "", ""]);
    expect(request.env.MODE).toBe("last");
    expect(writeAgentOsPid(input.memory, request.pidPointer, 0x1234)).toBe(0);
    expect(new DataView(input.memory.buffer).getUint32(request.pidPointer, true)).toBe(0x1234);
  });

  it("decodes ordered unpadded action records with signed file descriptors", () => {
    const actions = join(
      spawnAction(3, 5, 0, 0x8000_0000, 0o644, "a"),
      spawnAction(4, 0, 0, 0, 0, "b"),
      spawnAction(6, 12),
    );
    const input = fixture({ actions });
    const request = ok(decodeAgentOsSpawnRequest(input.memory, input.args));

    expect(request.actions).toEqual([
      { kind: "open", fd: 5, sourceFd: 0, flags: -0x8000_0000, mode: 0o644, path: "a" },
      { kind: "chdir", fd: 0, sourceFd: 0, flags: 0, mode: 0, path: "b" },
      { kind: "closefrom", fd: 12, sourceFd: 0, flags: 0, mode: 0 },
    ]);
  });

  it("maps malformed memory, out pointers, and action records to the historical WASI errnos", () => {
    const badInput = fixture();
    badInput.args[2] = new Uint8Array(badInput.memory.buffer).length - 1;
    badInput.args[3] = 2;
    fail(decodeAgentOsSpawnRequest(badInput.memory, badInput.args), AGENTOS_PROCESS_ERRNO.fault);

    const badOutput = fixture();
    badOutput.args[16] = 65_534;
    fail(decodeAgentOsSpawnRequest(badOutput.memory, badOutput.args), AGENTOS_PROCESS_ERRNO.fault);

    const truncatedHeader = fixture({ actions: new Uint8Array(23) });
    fail(
      decodeAgentOsSpawnRequest(truncatedHeader.memory, truncatedHeader.args),
      AGENTOS_PROCESS_ERRNO.invalidArgument,
    );
    const truncatedPath = fixture({ actions: spawnAction(3, 5, 0, 0, 0, "path").slice(0, 27) });
    fail(
      decodeAgentOsSpawnRequest(truncatedPath.memory, truncatedPath.args),
      AGENTOS_PROCESS_ERRNO.invalidArgument,
    );
  });

  it("returns source-compatible errno values for invalid fields and unsupported flags", () => {
    const emptyPath = fixture({ execPath: "" });
    fail(
      decodeAgentOsSpawnRequest(emptyPath.memory, emptyPath.args),
      AGENTOS_PROCESS_ERRNO.noEntry,
    );

    const negativeFd = fixture({ actions: spawnAction(1, -1) });
    fail(
      decodeAgentOsSpawnRequest(negativeFd.memory, negativeFd.args),
      AGENTOS_PROCESS_ERRNO.badFileDescriptor,
    );

    const emptyOpen = fixture({ actions: spawnAction(3, 5) });
    fail(
      decodeAgentOsSpawnRequest(emptyOpen.memory, emptyOpen.args),
      AGENTOS_PROCESS_ERRNO.noEntry,
    );

    const unsupportedFlags = fixture({ flags: 0x100 });
    fail(
      decodeAgentOsSpawnRequest(unsupportedFlags.memory, unsupportedFlags.args),
      AGENTOS_PROCESS_ERRNO.notSupported,
    );
  });

  it("rejects oversized guest data and oversized caller limits before allocating", () => {
    const input = fixture();
    input.args[3] = 1024 * 1024 + 1;
    fail(decodeAgentOsSpawnRequest(input.memory, input.args), AGENTOS_PROCESS_ERRNO.tooBig);

    const valid = fixture();
    fail(
      decodeAgentOsSpawnRequest(valid.memory, valid.args, {
        maxArgvBytes: Number.MAX_SAFE_INTEGER,
      }),
      AGENTOS_PROCESS_ERRNO.tooBig,
    );
  });

  it("accepts the maximum argument count with the runner's final NUL framing byte", () => {
    const input = fixture({ argv: ["tool"] });
    const request = ok(decodeAgentOsSpawnRequest(input.memory, input.args, { maxArgCount: 1 }));

    expect(request.argv).toEqual(["tool"]);
  });

  it("revalidates a saved output pointer when writing after async work", () => {
    const input = fixture();
    const request = ok(decodeAgentOsSpawnRequest(input.memory, input.args));
    expect(writeAgentOsPid(input.memory, request.pidPointer, 42)).toBe(0);
    expect(writeAgentOsPid(input.memory, 65_534, 42)).toBe(AGENTOS_PROCESS_ERRNO.fault);
    expect(writeAgentOsPid(input.memory, request.pidPointer, -1)).toBe(
      AGENTOS_PROCESS_ERRNO.invalidArgument,
    );
  });
});
