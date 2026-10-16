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
import { AUTOMATION_COMPILED_FORMAT } from "@t3tools/contracts";

import { cli } from "./cli.ts";

const message = (id: number, method: string, params: object) =>
  `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;

/** Runs `signalbox mcp`, sends one `signalbox_call`, and returns what it printed and sent. */
const callOverStdio = (callArguments: object, answer: unknown) =>
  Effect.gen(function* () {
    const calls: Array<{
      readonly url: string;
      readonly caller: string | undefined;
      readonly body: unknown;
    }> = [];
    const http = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          calls.push({
            url: request.url,
            caller: request.headers["x-signalbox-caller"],
            body:
              request.body._tag === "Uint8Array"
                ? (JSON.parse(new TextDecoder().decode(request.body.body)) as unknown)
                : undefined,
          });
          const body = request.url.endsWith("/operations")
            ? {
                operations: [
                  { name: "folders.list", cloud: { served: true } },
                  { name: "automations.save", cloud: { served: true } },
                ],
              }
            : answer;
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
      message(2, "tools/call", { name: "signalbox_call", arguments: callArguments }),
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
    return { output: output.join(""), calls };
  });

describe("signalbox mcp", () => {
  it.effect("serves search and call over stdio, calling the API as an agent", () =>
    Effect.gen(function* () {
      const { output, calls } = yield* callOverStdio(
        { operation: "folders.list" },
        { revision: 3 },
      );
      expect(output).toContain("revision");
      expect(calls).toContainEqual({
        url: "https://cloud.test/api/v1/folders.list",
        caller: "agent",
        body: {},
      });
    }),
  );

  it.effect("compiles an automation here before saving it in the cloud (#558)", () =>
    Effect.gen(function* () {
      const source = `export const meta = { name: "From Claude Code" } as const;
export default workflow(async (w) => "hi");`;
      const { calls } = yield* callOverStdio(
        { operation: "automations.save", input: { source, projectId: "p1" } },
        { ok: false, diagnostics: [] },
      );
      const save = calls.find((call) => call.url.endsWith("/automations.save"));
      expect(save?.body).toMatchObject({
        source,
        projectId: "p1",
        compiled: { format: AUTOMATION_COMPILED_FORMAT, meta: { name: "From Claude Code" } },
      });
    }),
  );
});
