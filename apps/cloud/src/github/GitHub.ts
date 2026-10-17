import * as WorkOSPipes from "@signalbox/account/WorkOSPipes";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient } from "effect/http";

import * as IdentityProvider from "../account/IdentityProvider.ts";
import { type GitHubApi, type GitHubEndpoints, makeGitHubApi } from "./GitHubApi.ts";

/**
 * GitHub as this cloud reaches it. Users connect their GitHub account through
 * WorkOS Pipes, which holds and refreshes the OAuth tokens; the cloud asks it
 * for a token whenever it acts as the user. The GitHub OAuth app lives in the
 * WorkOS dashboard (Pipes › GitHub), so the cloud needs only its WorkOS API key:
 *
 * - `T3CODE_WORKOS_API_KEY` (and optionally `T3CODE_WORKOS_API_BASE_URL`).
 *
 * Without it, GitHub features are off and say so.
 */

/** The Pipes integration's slug in WorkOS. */
export const GITHUB_PIPES_PROVIDER = "github";

export interface GitHubEnv {
  readonly T3CODE_WORKOS_API_KEY?: string;
  readonly T3CODE_WORKOS_API_BASE_URL?: string;
  /** Local development only (with `LOCAL_WORKERD`): a stand-in for github.com and its API. */
  readonly GITHUB_WEB_URL?: string;
  readonly GITHUB_API_URL?: string;
  readonly LOCAL_WORKERD?: string;
}

/** github.com, or a local stand-in for it under `wrangler dev`. */
export const gitHubEndpoints = (env: GitHubEnv): GitHubEndpoints | undefined =>
  env.LOCAL_WORKERD === "1" && env.GITHUB_WEB_URL && env.GITHUB_API_URL
    ? { web: env.GITHUB_WEB_URL, api: env.GITHUB_API_URL }
    : undefined;

export const gitHubPipesConfig = (env: GitHubEnv): WorkOSPipes.PipesConfig | null =>
  env.T3CODE_WORKOS_API_KEY
    ? {
        apiKey: Redacted.make(env.T3CODE_WORKOS_API_KEY),
        apiBaseUrl: env.T3CODE_WORKOS_API_BASE_URL || "https://api.workos.com",
      }
    : null;

/** A user's GitHub connection in WorkOS Pipes, by their WorkOS user id. */
export interface GitHubPipes {
  /** Where to send the user's browser to connect GitHub; WorkOS comes back to `returnTo`. */
  readonly authorizeUrl: (input: {
    readonly userId: string;
    readonly returnTo: string;
  }) => Effect.Effect<string, WorkOSPipes.WorkOSPipesError>;
  readonly accessToken: (
    userId: string,
  ) => Effect.Effect<WorkOSPipes.PipesToken, WorkOSPipes.WorkOSPipesError>;
  readonly disconnect: (userId: string) => Effect.Effect<void, WorkOSPipes.WorkOSPipesError>;
}

export class GitHub extends Context.Service<
  GitHub,
  {
    readonly pipesForUser: (
      userId: string,
    ) => Effect.Effect<GitHubPipes | null, WorkOSPipes.WorkOSPipesError>;
    readonly api: GitHubApi;
  }
>()("@signalbox/cloud/github/GitHub") {}

const makePipes = (config: WorkOSPipes.PipesConfig, client: HttpClient.HttpClient): GitHubPipes => {
  const provider = GITHUB_PIPES_PROVIDER;
  const run = Effect.provideService(HttpClient.HttpClient, client);
  return {
    authorizeUrl: ({ userId, returnTo }) =>
      run(WorkOSPipes.authorizeUrl(config, { provider, userId, returnTo })),
    accessToken: (userId) => run(WorkOSPipes.accessToken(config, { provider, userId })),
    disconnect: (userId) => run(WorkOSPipes.disconnect(config, { provider, userId })),
  };
};

/** Needs an `HttpClient` (`FetchHttpClient.layer` will do). */
export const layer = (pipes: WorkOSPipes.PipesConfig | null, endpoints?: GitHubEndpoints) =>
  Layer.effect(
    GitHub,
    Effect.map(HttpClient.HttpClient, (client) => {
      const configured = pipes === null ? null : makePipes(pipes, client);
      return GitHub.of({
        pipesForUser: () => Effect.succeed(configured),
        api: makeGitHubApi(client, endpoints),
      });
    }),
  );

/** Resolves each user's WorkOS realm before using Pipes for them. */
export const layerForUsers = (endpoints?: GitHubEndpoints) =>
  Layer.effect(
    GitHub,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const identityProviders = yield* IdentityProvider.IdentityProviders;
      const pipesForUser: GitHub["Service"]["pipesForUser"] = (userId) =>
        identityProviders.identityProviderForUser(userId).pipe(
          Effect.mapError(
            () => new WorkOSPipes.WorkOSPipesError({ operation: "configuration", status: 0 }),
          ),
          Effect.map((config) =>
            config.apiKey === undefined || Redacted.value(config.apiKey).trim() === ""
              ? null
              : makePipes({ apiKey: config.apiKey, apiBaseUrl: config.apiBaseUrl }, client),
          ),
        );
      return GitHub.of({
        pipesForUser,
        api: makeGitHubApi(client, endpoints),
      });
    }),
  );
