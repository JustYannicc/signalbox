// @effect-diagnostics nodeBuiltinImport:off - the CLI's saved login is a real file under a temp dir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { operations } from "@signalbox/api/catalog";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { HttpClient, HttpClientResponse } from "effect/http";

import { cli } from "./cli.ts";
import { commandPathOf } from "./operationCommands.ts";

interface Sent {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

/** A Signalbox that answers `respond` and records what the CLI sent. */
const fakeSignalbox = (respond: (sent: Sent) => Response) => {
  const sent: Array<Sent> = [];
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const body =
          request.body._tag === "Uint8Array"
            ? (JSON.parse(new TextDecoder().decode(request.body.body)) as unknown)
            : undefined;
        const entry = { url: request.url, authorization: request.headers.authorization, body };
        sent.push(entry);
        return HttpClientResponse.fromWeb(request, respond(entry));
      }),
    ),
  );
  return { sent, layer };
};

const run = (
  args: ReadonlyArray<string>,
  signalbox: ReturnType<typeof fakeSignalbox>,
  env: Record<string, string> = {},
) => {
  const configDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "signalbox-cli-"));
  return Command.runWith(cli, { version: "test" })(args).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        TestConsole.layer,
        signalbox.layer,
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { SIGNALBOX_CONFIG_DIR: configDir, ...env } }),
        ),
      ),
    ),
    Effect.as(configDir),
  );
};

/** The subcommand paths a command tree answers to. */
const pathsOf = (command: Command.Command.Any, prefix: ReadonlyArray<string> = []): Array<string> =>
  command.subcommands.flatMap((group) =>
    group.commands.flatMap((child) => {
      const path = [...prefix, child.name];
      return [path.join(" "), ...pathsOf(child, path)];
    }),
  );

describe("signalbox CLI", () => {
  it("has a command for every public API operation", () => {
    const paths = new Set(pathsOf(cli));
    const missing = operations
      .map((operation) => commandPathOf(operation).join(" "))
      .filter((path) => !paths.has(path));
    expect(missing).toEqual([]);
  });

  it.effect("turns flags into the operation's input and sends the key as bearer", () =>
    Effect.gen(function* () {
      const signalbox = fakeSignalbox(() => Response.json({ revision: 1 }));
      yield* run(["folders", "create", "--name", "Signalbox", "--parent-id", "null"], signalbox, {
        SIGNALBOX_URL: "https://cloud.test",
        SIGNALBOX_KEY: "sbk_test",
      });
      expect(signalbox.sent).toEqual([
        {
          url: "https://cloud.test/api/v1/folders.create",
          authorization: "Bearer sbk_test",
          body: { name: "Signalbox", parentId: null },
        },
      ]);
      expect((yield* TestConsole.logLines).join("\n")).toContain('"revision": 1');
    }),
  );

  it.effect("merges --input JSON under the flags", () =>
    Effect.gen(function* () {
      const signalbox = fakeSignalbox(() => Response.json({}));
      yield* run(
        ["threads", "update", "--input", '{"threadId":"t1","title":"Old"}', "--title", "New"],
        signalbox,
        { SIGNALBOX_KEY: "sbk_test" },
      );
      expect(signalbox.sent[0]?.body).toEqual({ threadId: "t1", title: "New" });
    }),
  );

  it.effect("signs in through the device flow and saves the key for later calls", () =>
    Effect.gen(function* () {
      let polls = 0;
      const signalbox = fakeSignalbox((sent) => {
        if (sent.url.endsWith("/login")) {
          return Response.json({
            deviceCode: "device-1",
            userCode: "ABCD-EFGH",
            verificationUri: "https://authkit.test/device",
            verificationUriComplete: "https://authkit.test/device?user_code=ABCD-EFGH",
            expiresIn: 300,
            interval: 5,
          });
        }
        if (sent.url.endsWith("/login/token")) {
          polls += 1;
          return polls < 2
            ? Response.json({ error: "authorization_pending" }, { status: 400 })
            : Response.json({ key: "sbk_signed_in" });
        }
        return Response.json({ keys: [] });
      });
      const fiber = yield* run(["login", "--url", "https://cloud.test"], signalbox).pipe(
        Effect.forkChild,
      );
      // Step until the login ends: one jump can land before the first poll sleeps.
      while (fiber.pollUnsafe() === undefined) yield* TestClock.adjust("1 second");
      const configDir = yield* Fiber.join(fiber);
      expect(polls).toBe(2);
      expect((yield* TestConsole.logLines).join("\n")).toContain("ABCD-EFGH");

      const saved = JSON.parse(
        NodeFS.readFileSync(NodePath.join(configDir, "credentials.json"), "utf8"),
      ) as { url: string; key: string };
      expect(saved).toEqual({ url: "https://cloud.test", key: "sbk_signed_in" });
      expect(
        (NodeFS.statSync(NodePath.join(configDir, "credentials.json")).mode & 0o777).toString(8),
      ).toBe("600");
    }),
  );

  it.effect("tells you to sign in before calling anything", () =>
    Effect.gen(function* () {
      const signalbox = fakeSignalbox(() => Response.json({}));
      const exit = yield* Effect.exit(run(["folders", "list"], signalbox));
      expect(exit._tag).toBe("Failure");
      expect(signalbox.sent).toEqual([]);
    }),
  );
});
