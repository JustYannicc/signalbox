import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { HttpClient, HttpClientResponse } from "effect/http";

import { cli } from "./cli.ts";

const message = (id: number, method: string, params: object) =>
  `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;

describe("signalbox mcp", () => {
  it.effect("serves search and call over stdio, calling the API as an agent", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly caller: string | undefined }> = [];
      const http = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            calls.push({ url: request.url, caller: request.headers["x-signalbox-caller"] });
            const body = request.url.endsWith("/operations")
              ? { operations: [{ name: "folders.list", cloud: { served: true } }] }
              : { revision: 3 };
            return HttpClientResponse.fromWeb(request, Response.json(body));
          }),
        ),
      );
      const output: Array<string> = [];
      const answered = yield* Deferred.make<void>();
      const stdin = Stream.make(
        message(1, "initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        }),
        message(2, "tools/call", {
          name: "signalbox_call",
          arguments: { operation: "folders.list" },
        }),
      ).pipe(Stream.encodeText, Stream.concat(Stream.never));
      const stdio = Stdio.layerTest({
        stdin,
        stdout: () =>
          Sink.forEach((chunk: string | Uint8Array) =>
            Effect.gen(function* () {
              output.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
              if (output.join("").includes('"id":2')) yield* Deferred.succeed(answered, undefined);
            }),
          ),
      });
      const fiber = yield* Command.runWith(cli, { version: "test" })(["mcp"]).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            stdio,
            TestConsole.layer,
            http,
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: { SIGNALBOX_URL: "https://cloud.test", SIGNALBOX_KEY: "sbk_test" },
              }),
            ),
          ),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(answered);
      yield* Fiber.interrupt(fiber);
      expect(output.join("")).toContain("revision");
      expect(calls).toContainEqual({
        url: "https://cloud.test/api/v1/folders.list",
        caller: "agent",
      });
    }),
  );
});
