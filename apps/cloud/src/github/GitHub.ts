import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/http";

import {
  type GitHubApi,
  type GitHubAppClient,
  type GitHubEndpoints,
  makeGitHubApi,
} from "./GitHubApi.ts";

/**
 * Signalbox's GitHub App, as this cloud is configured with it (#135). The
 * hosted service brings its own App, so connecting GitHub is one click;
 * a self-hosted cloud registers one and sets:
 *
 * - `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`: the App's OAuth client.
 * - `GITHUB_APP_SLUG`: its public name, for the "install on more accounts" link.
 *
 * Without them, GitHub features are off and say so.
 */

export interface GitHubAppConfig extends GitHubAppClient {
  readonly slug: string;
}

export interface GitHubEnv {
  readonly GITHUB_APP_CLIENT_ID?: string;
  readonly GITHUB_APP_CLIENT_SECRET?: string;
  readonly GITHUB_APP_SLUG?: string;
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

export const gitHubAppConfig = (env: GitHubEnv): GitHubAppConfig | null =>
  env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET && env.GITHUB_APP_SLUG
    ? {
        clientId: env.GITHUB_APP_CLIENT_ID,
        clientSecret: env.GITHUB_APP_CLIENT_SECRET,
        slug: env.GITHUB_APP_SLUG,
      }
    : null;

export class GitHub extends Context.Service<
  GitHub,
  { readonly app: GitHubAppConfig | null; readonly api: GitHubApi }
>()("@signalbox/cloud/github/GitHub") {}

/** Needs an `HttpClient` (`FetchHttpClient.layer` will do). */
export const layer = (app: GitHubAppConfig | null, endpoints?: GitHubEndpoints) =>
  Layer.effect(
    GitHub,
    Effect.map(HttpClient.HttpClient, (client) =>
      GitHub.of({ app, api: makeGitHubApi(client, endpoints) }),
    ),
  );
