import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/**
 * Which Signalbox the CLI talks to, and as whom. `signalbox login` saves both
 * in the config directory; scripts set `SIGNALBOX_KEY` (and `SIGNALBOX_URL`)
 * instead, which win over the saved ones.
 */

export const DEFAULT_URL = "https://app.signalbox.run";

export interface Target {
  readonly url: string;
  readonly key: Option.Option<string>;
}

const Saved = Schema.Struct({ url: Schema.String, key: Schema.String });
type Saved = typeof Saved.Type;
const decodeSaved = Schema.decodeUnknownOption(Schema.fromJsonString(Saved));
const encodeSaved = Schema.encodeSync(Schema.fromJsonString(Saved));

const optionalEnv = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Config.map(Option.filter((value) => value.trim() !== "")),
  );

/** `$SIGNALBOX_CONFIG_DIR`, else `$XDG_CONFIG_HOME/signalbox`, else `~/.config/signalbox`. */
const configDirectory = Effect.gen(function* () {
  const path = yield* Path.Path;
  const explicit = yield* optionalEnv("SIGNALBOX_CONFIG_DIR");
  if (Option.isSome(explicit)) return explicit.value;
  const xdg = yield* optionalEnv("XDG_CONFIG_HOME");
  if (Option.isSome(xdg)) return path.join(xdg.value, "signalbox");
  const home = yield* optionalEnv("HOME");
  return path.join(
    Option.getOrElse(home, () => "."),
    ".config",
    "signalbox",
  );
});

const credentialsFile = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.join(yield* configDirectory, "credentials.json");
});

const readSaved = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* credentialsFile;
  const text = yield* fs.readFileString(file).pipe(Effect.option);
  return Option.flatMap(text, decodeSaved);
});

/** Saves a login, readable only by its owner: the key acts as them. */
export const saveLogin = (saved: Saved) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* credentialsFile;
    yield* fs.makeDirectory(yield* configDirectory, { recursive: true });
    yield* fs.writeFileString(file, `${encodeSaved(saved)}\n`, { mode: 0o600 });
    return file;
  });

export const forgetLogin = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(yield* credentialsFile).pipe(Effect.ignore);
});

/** The Signalbox to talk to: `--url`, else `SIGNALBOX_URL`, else the saved login's, else the cloud. */
export const resolveTarget = (urlFlag: Option.Option<string>) =>
  Effect.gen(function* () {
    const saved = yield* readSaved;
    const envUrl = yield* optionalEnv("SIGNALBOX_URL");
    const envKey = yield* optionalEnv("SIGNALBOX_KEY");
    const url = Option.firstSomeOf([urlFlag, envUrl, Option.map(saved, (login) => login.url)]).pipe(
      Option.getOrElse(() => DEFAULT_URL),
    );
    const normalized = url.replace(/\/+$/, "");
    // A saved key only goes to the Signalbox that made it.
    const savedKey = Option.flatMap(saved, (login) =>
      login.url === normalized ? Option.some(login.key) : Option.none(),
    );
    return { url: normalized, key: Option.orElse(envKey, () => savedKey) } satisfies Target;
  });
