import { AuthSettingsWriteScope, KeybindingsConfigError, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";

import * as UserKeybindings from "./UserKeybindings.ts";

export const KEYBINDING_METHODS = [
  WS_METHODS.serverUpsertKeybinding,
  WS_METHODS.serverRemoveKeybinding,
] as const;
export const KEYBINDING_REQUIRED_SCOPES = {
  [WS_METHODS.serverUpsertKeybinding]: AuthSettingsWriteScope,
  [WS_METHODS.serverRemoveKeybinding]: AuthSettingsWriteScope,
} as const;

const keybindingCall = (
  effect: Effect.Effect<UserKeybindings.KeybindingsSnapshot, SqlError | KeybindingsConfigError>,
) =>
  effect.pipe(
    Effect.map(({ keybindings }) => ({ keybindings, issues: [] })),
    Effect.catchTags({
      SqlError: (cause) =>
        Effect.logError("cloud keybindings write failed", { cause }).pipe(
          Effect.andThen(
            Effect.fail(
              new KeybindingsConfigError({
                configPath: "cloud keybindings",
                detail: "Couldn't save your keybindings. Try again.",
              }),
            ),
          ),
        ),
    }),
  );

export const makeKeybindingHandlers = Effect.gen(function* () {
  const keybindings = yield* UserKeybindings.UserKeybindings;
  return {
    [WS_METHODS.serverUpsertKeybinding]: (input: Parameters<typeof keybindings.upsert>[0]) =>
      keybindingCall(keybindings.upsert(input)),
    [WS_METHODS.serverRemoveKeybinding]: (input: Parameters<typeof keybindings.remove>[0]) =>
      keybindingCall(keybindings.remove(input)),
  };
});
