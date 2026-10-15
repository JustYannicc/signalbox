import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { callOperation, pollLogin, startLogin } from "./http.ts";
import { forgetLogin, resolveTarget, saveLogin } from "./target.ts";
import { asUserErrors } from "./userErrors.ts";

/**
 * The few commands that aren't one operation: signing in and out, and
 * setting this computer's harnesses up on your pool.
 */

const urlFlag = Flag.optional(Flag.String("url")).pipe(
  Flag.withDescription("Which Signalbox, if not app.signalbox.run."),
);

/** What this computer is called, for the key's label in Settings. */
const computerName = Config.String("HOSTNAME").pipe(
  Config.withDefault("computer"),
  Effect.orElseSucceed(() => "computer"),
);

export class CliLoginExpiredError extends Schema.TaggedError<CliLoginExpiredError>()(
  "CliLoginExpiredError",
  {},
) {
  override get message(): string {
    return "The sign-in code expired before it was approved. Run `signalbox login` again.";
  }
}

/** Polls until the person approves the code, honoring `slow_down`, until the code expires. */
const waitForApproval = (
  target: Parameters<typeof pollLogin>[0],
  device: Effect.Success<ReturnType<typeof startLogin>>,
  label: string,
) =>
  Effect.gen(function* () {
    let interval = device.interval;
    let waited = 0;
    while (waited < device.expiresIn) {
      yield* Effect.sleep(Duration.seconds(interval));
      waited += interval;
      const answer = yield* pollLogin(target, device.deviceCode, label);
      if (answer._tag === "signed-in") return answer.key;
      if (answer._tag === "slow_down") interval += 5;
    }
    return yield* new CliLoginExpiredError();
  });

export const loginCommand = Command.make("login", { url: urlFlag }, ({ url }) =>
  Effect.gen(function* () {
    const target = yield* resolveTarget(url);
    const device = yield* startLogin(target);
    yield* Console.log(
      `Open ${device.verificationUriComplete}\nand check it shows ${device.userCode}. Waiting…`,
    );
    const label = yield* computerName;
    const key = yield* waitForApproval(target, device, label);
    const file = yield* saveLogin({ url: target.url, key });
    yield* Console.log(`Signed in to ${target.url}. Your key is in ${file}.`);
  }).pipe(asUserErrors),
).pipe(
  Command.withDescription(
    "Sign in with your browser. Saves a personal key you can revoke in Settings.",
  ),
);

export const logoutCommand = Command.make("logout", {}, () =>
  Effect.gen(function* () {
    yield* forgetLogin;
    yield* Console.log("Signed out here. Revoke the key in Settings › Pools to end it everywhere.");
  }),
).pipe(Command.withDescription("Forget this computer's saved key."));

const KeyCreated = Schema.Struct({ key: Schema.String });

/**
 * `signalbox pools use`: runs this computer's Claude Code and Codex on your
 * pool. It makes a harness key (one that can't call the API) and runs the
 * cloud's own setup script with it (#413), which honors `CLAUDE_CONFIG_DIR`
 * and `CODEX_HOME` and undoes cleanly with `--undo`.
 */
export const poolsUseCommand = Command.make("use", { url: urlFlag }, ({ url }) =>
  Effect.gen(function* () {
    const target = yield* resolveTarget(url);
    const label = yield* computerName;
    const created = yield* callOperation(target, "keys.create", {
      label,
      scopes: [],
      model: true,
    }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(KeyCreated)));
    const client = yield* HttpClient.HttpClient;
    const script = yield* client
      .get(`${target.url}/api/local-keys/setup`)
      .pipe(Effect.flatMap((response) => response.text));
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("node", ["-", created.key], {
        stdin: { stream: Stream.encodeText(Stream.make(script)) },
        stdout: "inherit",
        stderr: "inherit",
      }),
    );
    const exitCode = yield* child.exitCode;
    if (exitCode !== 0) yield* Console.error("Setup changed nothing; see above.");
  }).pipe(Effect.scoped, asUserErrors),
).pipe(Command.withDescription("Run this computer's Claude Code and Codex on your pool."));
