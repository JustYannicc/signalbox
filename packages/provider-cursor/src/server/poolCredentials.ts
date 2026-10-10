/**
 * signalbox: the credential store a pool's Cursor instance reads instead of
 * its own. The account hub provides it; Cursor's driver opens its own store
 * only when it is absent, so a pool never reads a Cursor login on the server
 * machine.
 *
 * @module provider-cursor/server/poolCredentials
 */
import type { SdkCredentialStore } from "@cursor/sdk";
import type { ProviderCredentials } from "@t3tools/provider-core/server/ProviderHost";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export class CursorPoolCredentials extends Context.Service<
  CursorPoolCredentials,
  {
    readonly store: SdkCredentialStore;
    readonly binding: ProviderCredentials["binding"];
  }
>()("@t3tools/provider-cursor/server/poolCredentials/CursorPoolCredentials") {}

/** The pool's credentials when the hub provides them, else the instance's own store. */
export const withPoolCredentials = <E, R>(
  own: Effect.Effect<CursorPoolCredentials["Service"], E, R>,
) =>
  Effect.serviceOption(CursorPoolCredentials).pipe(
    Effect.flatMap(Option.match({ onSome: Effect.succeed, onNone: () => own })),
  );
