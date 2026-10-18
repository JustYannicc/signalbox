import { describe, expect, it } from "vitest";
import {
  decodeMessage,
  encodeMessage,
  readParams,
  RpcError,
  signalParams,
  startParams,
  writeParams,
} from "./CodexExecProtocol.ts";

const start = {
  processId: "logical-process",
  argv: ["/bin/echo", "", "a b"],
  cwd: "file:///workspace/a%20b",
  env: { PATH: "/bin", EMPTY: "" },
  tty: false,
};

describe("Codex exec-server wire decoding", () => {
  it("accepts upstream envelopes without a jsonrpc version and preserves string ids", () => {
    expect(
      decodeMessage(JSON.stringify({ id: "17", method: "process/start", params: start })),
    ).toMatchObject({ id: "17", method: "process/start", params: start });
    expect(decodeMessage('{"method":"initialized"}')).toEqual({
      method: "initialized",
      params: undefined,
    });
  });

  it.each([
    "null",
    "[]",
    "{",
    '{"id":null,"method":"initialize"}',
    '{"id":1.5,"method":"initialize"}',
    '{"id":9223372036854775808,"method":"initialize"}',
    '{"id":1.0,"method":"initialize"}',
    '{"id":1e2,"method":"initialize"}',
    '{"id":1,"result":{}}',
  ])("rejects malformed inbound message %s", (text) => {
    expect(() => decodeMessage(text)).toThrow(RpcError);
  });

  it("round-trips the full signed 64-bit request-id range without rounding", () => {
    for (const id of ["9007199254740993", "9223372036854775807", "-9223372036854775808"]) {
      const message = decodeMessage(`{"id":${id},"method":"initialize"}`);
      expect(message.id).toBe(BigInt(id));
      expect(encodeMessage({ id: message.id!, result: {} })).toBe(`{"id":${id},"result":{}}`);
    }
    expect(decodeMessage('{"id":9007199254740991,"method":"initialize"}').id).toBe(
      9007199254740991,
    );
  });

  it("bounds frame bytes and decoded value count", () => {
    expect(() => decodeMessage('{"method":"é"}', 14)).toThrow("byte limit");
    expect(() =>
      decodeMessage(JSON.stringify({ method: "x", params: Array(262_144).fill(0) })),
    ).toThrow("value limit");
  });

  it("preserves empty args, URI spelling and the explicit environment", () => {
    expect(startParams(start)).toMatchObject({ ...start, pipeStdin: false });
    expect(startParams({ ...start, arg0: "different-name", pipeStdin: true })).toMatchObject({
      argv: start.argv,
      arg0: "different-name",
      pipeStdin: true,
    });
  });

  it.each([
    { argv: [] },
    { argv: [""] },
    { argv: ["echo", 3] },
    { cwd: "/workspace" },
    { cwd: "https://example.com" },
    { tty: "false" },
    { pipeStdin: null },
    { env: { SECRET: 1 } },
    { sandbox: [] },
  ])("rejects invalid launch fields %o", (patch) => {
    expect(() => startParams({ ...start, ...patch })).toThrow(RpcError);
  });

  it("decodes bytes without treating stdin as text", () => {
    const write = writeParams({ processId: "p", writeId: "once", chunk: "AP+A" });
    expect([...write.chunk]).toEqual([0, 255, 128]);
    expect(writeParams({ processId: "p", writeId: "empty", chunk: "" }).chunk.byteLength).toBe(0);
  });

  it.each(["YQ", "YR==", "YQ==\n", "_w==", "%%%%"])("rejects nonstandard base64 %s", (chunk) => {
    expect(() => writeParams({ processId: "p", writeId: "once", chunk })).toThrow(RpcError);
  });

  it("requires a write identity and the upstream interrupt signal", () => {
    expect(() => writeParams({ processId: "p", writeId: "", chunk: "" })).toThrow("writeId");
    expect(signalParams({ processId: "p", signal: "interrupt" })).toEqual({ processId: "p" });
    expect(() => signalParams({ processId: "p", signal: "kill" })).toThrow("signal");
  });

  it("accepts nullable read options, including zero, and rejects negative cursors", () => {
    expect(readParams({ processId: "p", afterSeq: 0, maxBytes: 0, waitMs: null })).toEqual({
      processId: "p",
      afterSeq: 0,
      maxBytes: 0,
      waitMs: undefined,
    });
    expect(() => readParams({ processId: "p", afterSeq: -1 })).toThrow("afterSeq");
  });
});
