import { DeviceHostId, DeviceId, LOCAL_DEVICE_HOST_ID } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import * as CliError from "effect/cli/CliError";

import * as DeviceService from "../device/DeviceService.ts";
import * as NetService from "@t3tools/shared/Net";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

const isDeviceHostId = Schema.is(DeviceHostId);
const isDeviceId = Schema.is(DeviceId);

const deviceJanitorLayer = (config: ServerConfig.ServerConfig["Service"]) => {
  const runtime = Layer.mergeAll(
    ServerSettings.layerTest({ enableDeviceSupport: true }),
    NetService.layer,
    FetchHttpClient.layer,
    ServerConfig.layer(config),
    NodeServices.layer,
  );
  const withProcessRunner = ProcessRunner.layer.pipe(Layer.provideMerge(runtime));
  return DeviceService.maintenanceLayer.pipe(Layer.provide(withProcessRunner));
};

const describe = (reason: string | undefined) => {
  switch (reason) {
    case "active_owner":
      return "a live owner still holds the device";
    case "unknown_owner":
      return "an owner could not be proven dead";
    case "waiting_walk":
      return "another walk is waiting for the device";
    case "not_idle":
      return "the device has not been idle for 30 minutes";
    case "not_signalbox_owned":
      return "Signalbox did not boot this device";
    case "physical":
      return "physical devices are never cleaned up automatically";
    case "not_booted":
      return "the device is already recorded as shut down";
    case "in_progress":
      return "a device operation is in progress";
    case "unreadable_lease":
      return "the ownership record is unreadable";
    case "not_found":
      return "no lease matches this exact ID";
    default:
      return "the device was skipped";
  }
};

export const deviceJanitorCommand = Command.make("__device-janitor", {
  ...projectLocationFlags,
  hostId: Flag.String("host-id").pipe(
    Flag.withDescription("Exact device host ID. Defaults to local."),
    Flag.withDefault(LOCAL_DEVICE_HOST_ID),
  ),
  deviceId: Argument.String("device-id"),
  apply: Flag.Boolean("apply").pipe(
    Flag.withDescription("Shut down the exact idle Signalbox-owned device when it is safe."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.unlisted,
  Command.withDescription("Inspect or safely clean up one exact device lease."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      if (!isDeviceHostId(flags.hostId)) {
        return yield* new CliError.UserError({ cause: "Invalid device host ID." });
      }
      if (!isDeviceId(flags.deviceId)) {
        return yield* new CliError.UserError({ cause: "Invalid device ID." });
      }
      const hostId = flags.hostId;
      const deviceId = flags.deviceId;
      const items = yield* Effect.gen(function* () {
        const devices = yield* DeviceService.DeviceService;
        return yield* devices.janitor({ hostId, deviceId, apply: flags.apply });
      }).pipe(Effect.provide(deviceJanitorLayer(config)));

      for (const item of items) {
        if (item.status === "would_shutdown") {
          yield* Console.log(
            `Dry run: would shut down ${item.hostId}/${item.deviceId} (Signalbox-owned, idle over 30 minutes, no live or unknown owners).`,
          );
        } else if (item.status === "shutdown") {
          yield* Console.log(`Shut down ${item.hostId}/${item.deviceId}.`);
        } else {
          yield* Console.log(`Skipped ${item.hostId}/${item.deviceId}: ${describe(item.reason)}.`);
        }
      }
    }),
  ),
);
