import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  MACHINE_FILES_MAX_CONTENT_BYTES,
  MACHINE_FILES_MAX_FRAME_BYTES,
  MachineFilesMessage,
  MachineFileStat,
  machineFilesFrame,
  machineFilesFrameBytes,
} from "./MachineFilesProtocol.ts";

const decode = Schema.decodeUnknownSync(MachineFilesMessage);
const decodeStat = Schema.decodeUnknownSync(MachineFileStat);

describe("Runner machine files protocol", () => {
  const requiredStat = {
    mode: 0o755,
    type: "file",
    size: "118456",
    uid: 1000,
    gid: 1000,
    nlink: "1",
    atimeNs: "1720000000000000000",
    mtimeNs: "1720000000000000001",
    ctimeNs: "1720000000000000002",
  } as const;

  it("round trips unknown native identity and birthtime without replacing them", () => {
    const message = {
      type: "machine.files.result",
      generation: 1,
      requestId: "unknown-native-fields",
      outcome: { status: "ok", results: [{ id: "stat", op: "lstat", stat: requiredStat }] },
    } as const;
    expect(decode(message)).toEqual(message);
    expect(machineFilesFrame.decode(machineFilesFrame.encode(message))).toEqual(message);
    expect(decodeStat(requiredStat)).toEqual(requiredStat);
  });

  it.each(["mode", "type", "size", "uid", "gid", "nlink", "atimeNs", "mtimeNs", "ctimeNs"])(
    "still rejects stat metadata missing %s",
    (field) => {
      const incomplete = new Map(Object.entries(requiredStat));
      incomplete.delete(field);
      expect(() => decodeStat(Object.fromEntries(incomplete))).toThrow();
    },
  );

  it("round trips batched metadata, original link bytes, and lazy ranges", () => {
    const request = {
      type: "machine.files.request",
      generation: 5,
      requestId: "lookup-1",
      operations: [
        { id: "stat-1", op: "stat", path: "/usr/bin/tool" },
        { id: "link-1", op: "readlink", path: "/usr/bin/tool-link" },
        { id: "read-1", op: "readRange", path: "/usr/bin/tool", offset: 17, length: 32 },
      ],
    } as const;
    const result = {
      type: "machine.files.result",
      generation: 5,
      requestId: "lookup-1",
      outcome: {
        status: "ok",
        results: [
          {
            id: "stat-1",
            op: "stat",
            stat: {
              mode: 33261,
              type: "file",
              size: "118456",
              uid: 1000,
              gid: 1000,
              dev: "2049",
              ino: "1234567",
              nlink: "1",
              atimeNs: "1720000000000000000",
              mtimeNs: "1720000000000000001",
              ctimeNs: "1720000000000000002",
              birthtimeNs: "1720000000000000003",
            },
          },
          { id: "link-1", op: "readlink", targetBase64: "Li4vYmluL3Rvb2w=" },
          {
            id: "read-1",
            op: "readRange",
            offset: 17,
            bytesRead: 3,
            bytesBase64: "YWJj",
            eof: false,
          },
        ],
      },
    } as const;

    expect(decode(request)).toEqual(request);
    expect(decode(result)).toEqual(result);
    expect(machineFilesFrame.decode(machineFilesFrame.encode(result))).toEqual(result);
    expect(machineFilesFrameBytes(result)).toBe(
      new TextEncoder().encode(machineFilesFrame.encode(result)).byteLength,
    );
  });

  it("bounds read ranges before their base64 representation can fill the wire frame", () => {
    expect(MACHINE_FILES_MAX_CONTENT_BYTES).toBeLessThan(MACHINE_FILES_MAX_FRAME_BYTES);
    expect(() =>
      decode({
        type: "machine.files.request",
        generation: 1,
        requestId: "too-large",
        operations: [
          {
            id: "range",
            op: "readRange",
            path: "/large",
            offset: 0,
            length: MACHINE_FILES_MAX_CONTENT_BYTES + 1,
          },
        ],
      }),
    ).toThrow();
  });
});
