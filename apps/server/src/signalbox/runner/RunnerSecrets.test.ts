// @effect-diagnostics cryptoRandomUUID:off cryptoRandomUUIDInEffect:off - fake secrets are generated per run, so no test ever holds a real one.
import {
  type RunnerItem,
  type RunnerMessage,
  type RunnerTurn,
} from "@signalbox/runner-protocol/RunnerProtocol";
import { type SecretValue, secretPlaceholder } from "@signalbox/runner-protocol/SecretScrubber";
import type { SecretsAccess } from "@signalbox/runner-protocol/SecretsProtocol";
import {
  MessageId,
  NodeId,
  type OrchestrationV2ProviderThread,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { OnePasswordEnvironmentId } from "@t3tools/contracts/signalboxFolders";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2,
  ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";
import {
  type EnvironmentVariable,
  type OnePassword,
  OnePasswordError,
} from "./RunnerOnePassword.ts";
import { makeRunnerSecrets, SecretsRegisterError, type SecretsReport } from "./RunnerSecrets.ts";
import type { RunnerTransport } from "./RunnerSession.ts";
import { makeRunnerTurns } from "./RunnerTurns.ts";
import { maskingTransport } from "./runnerSocket.ts";
import { makeSecretMask } from "./secretMask.ts";

const TOKEN = "ops_service-account-token";
const top = OnePasswordEnvironmentId.make("envtop");
const folder = OnePasswordEnvironmentId.make("envfolder");
const variable = (name: string, value: string, masked = true): EnvironmentVariable => ({
  name,
  value,
  masked,
});

/** A 1Password account holding `environments`, counting sign-ins and reads; its tokens start with `TOKEN`. */
const fakeOnePassword = (
  environments: Record<string, ReadonlyArray<EnvironmentVariable> | string>,
) => {
  const calls: Array<string> = [];
  const onePassword: OnePassword = (presented) =>
    Effect.suspend(() => {
      calls.push("sign in");
      if (!presented.startsWith(TOKEN)) {
        return Effect.fail(new OnePasswordError({ message: `invalid token ${presented}` }));
      }
      return Effect.succeed({
        variables: (environmentId: string) =>
          Effect.suspend(() => {
            calls.push(`read ${environmentId}`);
            const found = environments[environmentId];
            if (found === undefined || typeof found === "string") {
              return Effect.fail(new OnePasswordError({ message: found ?? "not found" }));
            }
            return Effect.succeed(found);
          }),
      });
    });
  return { onePassword, calls };
};

/** What a load reports; `refuse` makes the thread turn its registration down. */
const reporter = (refuse?: string) => {
  const notices: Array<string> = [];
  const lines: Array<string> = [];
  const registered: Array<ReadonlyArray<SecretValue>> = [];
  const report: SecretsReport = {
    notice: (message) => Effect.sync(() => void notices.push(message)),
    info: (message) => Effect.sync(() => void lines.push(message)),
    register: (secrets) =>
      refuse === undefined
        ? Effect.sync(() => void registered.push(secrets))
        : Effect.fail(new SecretsRegisterError({ message: refuse })),
  };
  return { report, notices, lines, registered };
};

/** The turn's session token, which registers its secrets with the thread. */
const sessions = { token: "session-token" };

const access = (
  environments: ReadonlyArray<OnePasswordEnvironmentId>,
  token: string | null = TOKEN,
): SecretsAccess => ({ token, environments, environmentNames: environments.map(() => null) });

describe("RunnerSecrets", () => {
  it.effect("keeps per-key precedence when an Environment appears twice on the chain", () =>
    Effect.gen(function* () {
      const account = fakeOnePassword({
        [top]: [variable("X", "outer-x"), variable("Y", "near-y")],
        [folder]: [variable("X", "middle-x")],
      });
      const secrets = makeRunnerSecrets({
        onePassword: account.onePassword,
        mask: makeSecretMask(),
        reserved: () => new Set(),
      });
      const { report } = reporter();
      yield* secrets.load(
        {
          ...access([top, folder, top]),
          environmentNames: [["X"], ["X"], ["Y"]],
        },
        report,
      );
      expect(secrets.environment()).toEqual({ X: "middle-x", Y: "near-y" });
    }),
  );

  it.effect("does not read an Environment missing from an explicit name filter", () =>
    Effect.gen(function* () {
      const account = fakeOnePassword({ [top]: [variable("PRIVATE", "never-load-this")] });
      const secrets = makeRunnerSecrets({
        onePassword: account.onePassword,
        mask: makeSecretMask(),
        reserved: () => new Set(),
      });
      const { report, registered } = reporter();
      yield* secrets.load({ ...access([top]), environmentNames: [] }, report);
      expect(secrets.environment()).toEqual({});
      expect(account.calls).toEqual([]);
      yield* secrets.load({ token: TOKEN, environments: [top] }, report);
      expect(account.calls).toEqual([]);
      expect(registered).toEqual([[], []]);
    }),
  );

  it.effect(
    "loads and registers only ancestor keys opted into subfolders, and changes next turn",
    () =>
      Effect.gen(function* () {
        const account = fakeOnePassword({
          [top]: [variable("PRIVATE", "parent-only"), variable("SHARED", "parent-shared")],
          [folder]: [variable("OWN", "own-value")],
        });
        const mask = makeSecretMask();
        const secrets = makeRunnerSecrets({
          onePassword: account.onePassword,
          mask,
          reserved: () => new Set(),
        });
        const { report, registered } = reporter();
        const scoped = {
          ...access([top, folder]),
          environmentNames: [["SHARED"], null],
        };
        expect(yield* secrets.load(scoped, report)).toBe(1);
        expect(secrets.environment()).toEqual({ SHARED: "parent-shared", OWN: "own-value" });
        expect(registered).toEqual([
          [
            { name: "SHARED", value: "parent-shared" },
            { name: "OWN", value: "own-value" },
          ],
        ]);
        expect(mask.text("parent-only parent-shared")).toBe("parent-only {{secret:SHARED}}");

        expect(yield* secrets.load({ ...scoped, environmentNames: [[], null] }, report)).toBe(2);
        expect(secrets.environment()).toEqual({ OWN: "own-value" });
        expect(registered.at(-1)).toEqual([{ name: "OWN", value: "own-value" }]);

        expect(yield* secrets.load(scoped, report)).toBe(3);
        expect(secrets.environment()).toEqual({ SHARED: "parent-shared", OWN: "own-value" });
      }),
  );

  it.effect("gives the chain's variables, a nearer folder's over the top level's", () =>
    Effect.gen(function* () {
      const account = fakeOnePassword({
        [top]: [variable("DATABASE_URL", "postgres://top-db"), variable("SHARED", "from-top")],
        [folder]: [variable("SHARED", "from-folder"), variable("API_KEY", "folder-api-key")],
      });
      const secrets = makeRunnerSecrets({
        onePassword: account.onePassword,
        mask: makeSecretMask(),
        reserved: () => new Set(),
      });
      const { report, notices, lines } = reporter();

      const version = yield* secrets.load(access([top, folder]), report);

      expect(secrets.environment()).toEqual({
        DATABASE_URL: "postgres://top-db",
        SHARED: "from-folder",
        API_KEY: "folder-api-key",
      });
      expect(version).toBe(1);
      expect(notices).toEqual([]);
      expect(lines).toEqual(["loaded 3 secrets from 2 1Password Environments"]);
    }),
  );

  it.effect(
    "reads again only when the turn names something else, or the last read fell short",
    () =>
      Effect.gen(function* () {
        const environments: Record<string, ReadonlyArray<EnvironmentVariable> | string> = {
          [top]: "rate limit exceeded",
        };
        const account = fakeOnePassword(environments);
        const secrets = makeRunnerSecrets({
          onePassword: account.onePassword,
          mask: makeSecretMask(),
          reserved: () => new Set(),
        });
        const { report, notices } = reporter();

        expect(yield* secrets.load(access([top]), report)).toBe(0);
        expect(notices).toEqual([
          "Some of this folder's secrets didn't load from 1Password, so this turn runs without them: Environment envtop: rate limit exceeded.",
        ]);
        // 1Password recovered: the next turn reads again and gets them.
        environments[top] = [variable("API_KEY", "now-it-loads")];
        expect(yield* secrets.load(access([top]), report)).toBe(1);
        // Nothing changed: no read, same version, so the open harness session stays.
        expect(yield* secrets.load(access([top]), report)).toBe(1);
        // The thread moved to a folder with its own Environment.
        environments[folder] = [variable("OTHER", "other-value")];
        expect(yield* secrets.load(access([top, folder]), report)).toBe(2);
        // A replaced token reads again, but the same variables keep their version.
        expect(yield* secrets.load(access([top, folder], `${TOKEN}-rotated`), report)).toBe(2);

        expect(account.calls).toEqual([
          "sign in",
          "read envtop",
          "sign in",
          "read envtop",
          "sign in",
          "read envtop",
          "read envfolder",
          "sign in",
          "read envtop",
          "read envfolder",
        ]);
      }),
  );

  it.effect("never replaces what Signalbox sets for the harness, and says which it skipped", () =>
    Effect.gen(function* () {
      const account = fakeOnePassword({
        [top]: [
          variable("HOME", "/somewhere/else"),
          variable("ANTHROPIC_API_KEY", "sk-ant-would-bypass-gateway"),
          variable("not a name", "ignored-value"),
          variable("TEST_ANTHROPIC_API_KEY", "sk-ant-for-tests"),
        ],
      });
      const secrets = makeRunnerSecrets({
        onePassword: account.onePassword,
        mask: makeSecretMask(),
        reserved: () => new Set(["HOME", "PATH"]),
      });
      const { report, notices } = reporter();

      yield* secrets.load(access([top]), report);

      expect(secrets.environment()).toEqual({ TEST_ANTHROPIC_API_KEY: "sk-ant-for-tests" });
      expect(notices).toEqual([
        "Skipped HOME from 1Password: Signalbox sets it for the agent's own harness.",
        "Skipped ANTHROPIC_API_KEY from 1Password: it could send the agent's model requests, or copies of them, around the gateway that keeps secrets out of them.",
      ]);
    }),
  );

  // Each of these took Claude Code 2.1.292 or Codex 0.160.1 off the gateway, or
  // copied its prompts elsewhere, when set in the harness's environment (#600).
  it.effect.each([
    ["a proxy", ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "all_proxy"]],
    [
      "OpenTelemetry export",
      ["CLAUDE_CODE_ENABLE_TELEMETRY", "OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_LOG_USER_PROMPTS"],
    ],
    [
      "another model provider",
      ["CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_FOUNDRY_BASE_URL", "CLAUDE_CODE_USE_MANTLE"],
    ],
    ["a socket instead of the gateway", ["ANTHROPIC_UNIX_SOCKET"]],
    ["code loaded into the harness", ["NODE_OPTIONS", "BUN_OPTIONS", "LD_PRELOAD"]],
    [
      "Codex's launch arguments and endpoint",
      ["T3CODE_CODEX_LAUNCH_ARGS", "OPENAI_BASE_URL", "CODEX_CA_CERTIFICATE"],
    ],
  ] as const)("skips folder secrets that route the harness through %s, and says so", ([, names]) =>
    Effect.gen(function* () {
      const account = fakeOnePassword({
        [top]: [
          ...names.map((name) => variable(name, `http://dead.invalid/${name}`, false)),
          variable("OPENAI_API_KEY", "sk-for-the-apps-own-tests"),
        ],
      });
      const secrets = makeRunnerSecrets({
        onePassword: account.onePassword,
        mask: makeSecretMask(),
        reserved: () => new Set(),
      });
      const { report, notices } = reporter();

      yield* secrets.load(access([top]), report);

      // A key the app itself uses still loads: Codex reads none of its provider from it.
      expect(secrets.environment()).toEqual({ OPENAI_API_KEY: "sk-for-the-apps-own-tests" });
      expect(notices).toEqual([
        `Skipped ${names.toSorted().join(", ")} from 1Password: ${names.length === 1 ? "it" : "they"} could send the agent's model requests, or copies of them, around the gateway that keeps secrets out of them.`,
      ]);
    }),
  );

  it.effect("loads nothing without a connected service account, and says so", () =>
    Effect.gen(function* () {
      const account = fakeOnePassword({ [top]: [variable("API_KEY", "never-read")] });
      const secrets = makeRunnerSecrets({
        onePassword: account.onePassword,
        mask: makeSecretMask(),
        reserved: () => new Set(),
      });
      const { report, notices } = reporter();

      yield* secrets.load(access([top], null), report);
      yield* secrets.load(null, report);

      expect(secrets.environment()).toEqual({});
      expect(account.calls).toEqual([]);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain("no 1Password service account is connected");
    }),
  );

  it.effect(
    "registers what it hides with the thread before the harness gets any, and fails without",
    () =>
      Effect.gen(function* () {
        // Generated per run: no test holds a real secret.
        const hidden = `sk-fake-${crypto.randomUUID()}`;
        const account = fakeOnePassword({
          [top]: [variable("API_KEY", hidden), variable("PUBLIC_URL", "https://app.test", false)],
        });
        const make = () =>
          makeRunnerSecrets({
            onePassword: account.onePassword,
            mask: makeSecretMask(),
            reserved: () => new Set(),
          });
        const accepted = reporter();
        const secrets = make();

        yield* secrets.load(access([top]), accepted.report);

        // Only what 1Password hides; the gateway can't serve the turn before this.
        expect(accepted.registered).toEqual([[{ name: "API_KEY", value: hidden }]]);
        expect(secrets.environment()).toEqual({ API_KEY: hidden, PUBLIC_URL: "https://app.test" });

        const refused = reporter("the cloud answered HTTP 403: A newer machine replaced this one.");
        const unregistered = make();
        const failed = yield* Effect.flip(unregistered.load(access([top]), refused.report));
        expect(failed._tag).toBe("SecretsRegisterError");
        expect(unregistered.environment()).toEqual({});
        // Tried again with the next turn.
        expect(yield* unregistered.load(access([top]), accepted.report)).toBe(1);

        // No service account: none to hide, which the gateway waits to hear too.
        const none = reporter();
        yield* make().load(access([top], null), none.report);
        expect(none.registered).toEqual([[]]);
      }),
  );

  it.effect("masks the token and every hidden value, but not what 1Password shows", () =>
    Effect.gen(function* () {
      const mask = makeSecretMask();
      const account = fakeOnePassword({
        [top]: [
          variable("API_KEY", "hidden-api-key"),
          variable("RELAY_URL", "https://relay.example", false),
        ],
      });
      const secrets = makeRunnerSecrets({
        onePassword: account.onePassword,
        mask,
        reserved: () => new Set(),
      });
      const { report, notices } = reporter();

      yield* secrets.load(access([top]), report);
      // A token 1Password turns down is masked in what the turn says about it.
      yield* secrets.load(access([top], "ops_a-revoked-token"), report);

      const token = secretPlaceholder("OP_SERVICE_ACCOUNT_TOKEN");
      expect(mask.text(`${TOKEN} hidden-api-key https://relay.example`)).toBe(
        `${token} ${secretPlaceholder("API_KEY")} https://relay.example`,
      );
      expect(notices).toEqual([
        `Some of this folder's secrets didn't load from 1Password, so this turn runs without them: signing in to 1Password failed: invalid token ${token}.`,
      ]);
    }),
  );
});

const threadId = ThreadId.make("thread-1");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const providerThread = {
  id: ProviderThreadId.make("pt-1"),
  nativeThreadRef: "native-thread",
} as unknown as OrchestrationV2ProviderThread;
const turnFor = (n: number): RunnerTurn =>
  ({
    runId: RunId.make(`run-${n}`),
    traceId: `trace-${n}`,
    attemptId: RunAttemptId.make(`attempt-${n}`),
    modelSelection: { instanceId, model: "m" },
    providerThread,
    message: { messageId: MessageId.make(`message-${n}`), text: "Hi", attachments: [] },
  }) as unknown as RunnerTurn;

const settle = Effect.gen(function* () {
  for (let round = 0; round < 20; round++) yield* Effect.yieldNow;
});

/**
 * A harness whose sessions see the folder's secrets the way the real adapters
 * do (`RunnerAdapters.ts`: as the session opens), and whose agent prints one
 * back, as `echo $API_KEY` would.
 */
const makeEchoingAdapter = (environment: () => Readonly<Record<string, string>>) => {
  const calls: Array<string> = [];
  let opened = 0;
  const adapter = {
    instanceId,
    driver,
    openSession: () =>
      Effect.gen(function* () {
        const n = ++opened;
        const seen = environment();
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        calls.push(`open ${n} with API_KEY=${seen.API_KEY ?? "none"}`);
        yield* Effect.addFinalizer(() => Effect.sync(() => void calls.push(`close ${n}`)));
        return {
          providerSessionId: ProviderSessionId.make(`session-${n}`),
          providerSession: {},
          events: Stream.fromQueue(events),
          ensureThread: () => Effect.succeed(providerThread),
          resumeThread: () => Effect.succeed(providerThread),
          startTurn: (input: { readonly runId: string; readonly runOrdinal: number }) =>
            Effect.gen(function* () {
              calls.push(`start ${input.runId}`);
              const ordinal = Number(input.runId.replace("run-", ""));
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: ProviderTurnId.make(`native-${ordinal}`),
                  providerThreadId: providerThread.id,
                  nodeId: NodeId.make(`node-${ordinal}`),
                  runAttemptId: RunAttemptId.make(`attempt-${ordinal}`),
                  nativeTurnRef: null,
                  ordinal,
                  status: "running",
                  startedAt: null,
                  completedAt: null,
                },
              } as unknown as ProviderAdapterV2Event);
              yield* Queue.offer(events, {
                type: "turn_item.updated",
                driver,
                turnItem: {
                  id: TurnItemId.make(`item-${input.runId}`),
                  threadId,
                  runId: RunId.make(input.runId),
                  nodeId: null,
                  providerThreadId: providerThread.id,
                  providerTurnId: ProviderTurnId.make(`native-${ordinal}`),
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 1,
                  status: "completed",
                  title: null,
                  startedAt: DateTime.makeUnsafe(0),
                  completedAt: DateTime.makeUnsafe(0),
                  updatedAt: DateTime.makeUnsafe(0),
                  type: "command_execution",
                  input: `curl -H 'Authorization: ${seen.API_KEY ?? ""}' localhost`,
                },
              } as ProviderAdapterV2Event);
              yield* Queue.offer(events, {
                type: "turn.terminal",
                driver,
                providerThreadId: providerThread.id,
                providerTurnId: ProviderTurnId.make(`native-${ordinal}`),
                runOrdinal: ordinal,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              } as unknown as ProviderAdapterV2Event);
            }),
        } as unknown as ProviderAdapterV2SessionRuntime;
      }),
  } as unknown as ProviderAdapterV2["Service"];
  return { adapter, calls };
};

describe("a thread's secrets on its machine", () => {
  it.effect(
    "reach the harness session, and a change restarts it so the thread resumes with them",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const environments: Record<string, ReadonlyArray<EnvironmentVariable>> = {
            [top]: [variable("API_KEY", "first-api-key")],
          };
          const account = fakeOnePassword(environments);
          const secrets = makeRunnerSecrets({
            onePassword: account.onePassword,
            mask: makeSecretMask(),
            reserved: () => new Set(),
          });
          const harness = makeEchoingAdapter(secrets.environment);
          const turns = yield* makeRunnerTurns({
            threadId,
            adapters: new Map([[instanceId, harness.adapter]]),
            cwd: "/tmp",
            useModelToken: () => Effect.void,
            usage: Effect.succeed({
              cpuSeconds: null,
              memoryBytes: null,
              memoryPeakBytes: null,
              memoryAverageBytes: null,
              diskUsedBytes: null,
              egressBytes: null,
            }),
            emit: () => Effect.void,
            secrets,
            registerSecrets: () => Effect.void,
          });

          yield* turns.start({
            turn: turnFor(1),
            modelToken: "t",
            sessions,
            secrets: access([top]),
          });
          yield* settle;
          yield* turns.start({
            turn: turnFor(2),
            modelToken: "t",
            sessions,
            secrets: access([top]),
          });
          yield* settle;
          // Moved to a folder with its own Environment, which sets the same name.
          environments[folder] = [variable("API_KEY", "folder-api-key")];
          yield* turns.start({
            turn: turnFor(3),
            modelToken: "t",
            sessions,
            secrets: access([top, folder]),
          });
          yield* settle;

          expect(harness.calls).toEqual([
            "open 1 with API_KEY=first-api-key",
            "start run-1",
            "start run-2",
            "close 1",
            "open 2 with API_KEY=folder-api-key",
            "start run-3",
          ]);
        }),
      ),
  );

  it.effect("never leave the machine: every frame the Runner sends has them masked", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const mask = makeSecretMask();
        const account = fakeOnePassword({
          [top]: [variable("API_KEY", "leakable-api-key")],
          [folder]: "Environment folder: denied for ops_service-account-token",
        });
        const secrets = makeRunnerSecrets({
          onePassword: account.onePassword,
          mask,
          reserved: () => new Set(),
        });
        const harness = makeEchoingAdapter(secrets.environment);
        const items: Array<RunnerItem> = [];
        const turns = yield* makeRunnerTurns({
          threadId,
          adapters: new Map([[instanceId, harness.adapter]]),
          cwd: "/tmp",
          useModelToken: () => Effect.void,
          usage: Effect.succeed({
            cpuSeconds: null,
            memoryBytes: null,
            memoryPeakBytes: null,
            memoryAverageBytes: null,
            diskUsedBytes: null,
            egressBytes: null,
          }),
          emit: (item) => Effect.sync(() => void items.push(item)),
          secrets,
          registerSecrets: () => Effect.void,
        });
        yield* turns.start({
          turn: turnFor(1),
          modelToken: "t",
          sessions,
          secrets: access([top, folder]),
        });
        yield* settle;
        // The agent did print it: the harness's own output carries the value.
        expect(JSON.stringify(items)).toContain("leakable-api-key");

        // What goes to the thread, as the Runner host sends it (`RunnerHost.ts`).
        const frames: Array<string> = [];
        const wire: RunnerTransport = {
          connect: Effect.succeed({
            send: (message: RunnerMessage) =>
              // The fake harness's session isn't a full one, so the frame is written out as is.
              Effect.sync(() => void frames.push(JSON.stringify(message))),
            receive: Effect.never,
            close: Effect.void,
          }),
        };
        const connection = yield* maskingTransport(wire, mask).connect;
        yield* connection.send({ type: "batch", sequence: 1, items });

        const sent = frames.join("\n");
        expect(sent).not.toContain("leakable-api-key");
        expect(sent).not.toContain(TOKEN);
        expect(sent).toContain(`Authorization: ${secretPlaceholder("API_KEY")}`);
        expect(sent).toContain("secrets.notice");
      }),
    ),
  );
});
