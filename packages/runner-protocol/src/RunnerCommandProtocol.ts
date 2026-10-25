import { ThreadId } from "@t3tools/contracts";
import { SystemIdentity } from "@t3tools/contracts/systemIdentity";
import * as Schema from "effect/Schema";

import { jsonCodec } from "./jsonCodec.ts";

export const COMMAND_RUNNER_CONNECT_PATH = "/api/computer/runner";

const Id = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(256));
const AbsolutePath = Schema.String.check(
  Schema.makeFilter((value) => {
    const segments = value.split("/");
    return (
      value.startsWith("/") &&
      !value.startsWith("//") &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      !segments.some(
        (segment, index) => index > 0 && (segment === "" || segment === "." || segment === ".."),
      )
    );
  }),
);

const Endpoint = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "ws:" || url.protocol === "wss:") &&
        url.hostname !== "" &&
        url.pathname === COMMAND_RUNNER_CONNECT_PATH &&
        url.username === "" &&
        url.password === "" &&
        url.search === "" &&
        url.hash === ""
      );
    } catch {
      return false;
    }
  }),
);

const CgroupPath = Schema.String.check(
  Schema.makeFilter((value) => {
    const prefix = "/sys/fs/cgroup/signalbox-command/";
    const name = value.startsWith(prefix) ? value.slice(prefix.length) : "";
    return /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(name);
  }),
);

/** Private launch input for the single-process command Runner. */
export const RunnerCommandConfigSchema = Schema.Struct({
  version: Schema.Literal(1),
  endpoint: Endpoint,
  threadId: ThreadId,
  operationId: Id,
  machineId: Id,
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  /** Resolved host identity; omitted only by legacy private launch files. */
  systemIdentity: Schema.optional(SystemIdentity),
  token: Schema.String.check(Schema.isNonEmpty()),
  workspaceReceipt: AbsolutePath,
  cgroupPath: Schema.optional(CgroupPath),
});
export type RunnerCommandConfig = typeof RunnerCommandConfigSchema.Type;

/** Owner-written proof that /workspace was hydrated for this exact launch. */
export const RunnerCommandReceiptSchema = Schema.Struct({
  version: Schema.Literal(1),
  threadId: ThreadId,
  operationId: Id,
  machineId: Id,
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  root: Schema.Literal("/workspace"),
});
export type RunnerCommandReceipt = typeof RunnerCommandReceiptSchema.Type;

/** Synchronous JSON codecs keep the cloud constructor independent of Effect runtimes. */
export const RunnerCommandConfigJson = jsonCodec(RunnerCommandConfigSchema);
export const RunnerCommandReceiptJson = jsonCodec(RunnerCommandReceiptSchema);
