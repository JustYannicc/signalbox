import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Provider from "alchemy/Provider";
import { ApiKey, ApiKeyProvider } from "./ApiKey.ts";
import { BoatAuth } from "./AuthProvider.ts";
import * as Credentials from "./Credentials.ts";
import { Environment, EnvironmentProvider } from "./Environment.ts";
import { NamedSnapshot, NamedSnapshotProvider } from "./NamedSnapshot.ts";

/**
 * Service tag bundling the Boat providers Signalbox carries until the
 * upstream Alchemy provider ships. Same identifier as upstream's.
 */
export class Providers extends Provider.ProviderCollection<Providers>()("Boat") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

export interface ProvidersOptions {
  /**
   * The deploy credentials, e.g. `Boat.fromApiKey({ apiKey })` from a
   * deploy-only secret. Omit to resolve `BOAT_API_KEY` or the alchemy
   * profile.
   */
  readonly credentials?: Layer.Layer<Credentials.Credentials>;
}

/** ApiKey, Environment and NamedSnapshot providers, Boat auth and credential resolution. */
export const providers = (options: ProvidersOptions = {}) =>
  Layer.effect(Providers, Provider.collection([ApiKey, Environment, NamedSnapshot])).pipe(
    Layer.provide(Layer.mergeAll(ApiKeyProvider(), EnvironmentProvider(), NamedSnapshotProvider())),
    Layer.provideMerge(options.credentials ?? Credentials.fromAuthProvider()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(BoatAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
