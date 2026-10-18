import * as Schema from "effect/Schema";

import { ACCOUNT_NATIVE_RETURN_SCHEMES } from "./account.ts";

export const GITHUB_CONNECT_PATH = "/api/github/connect";

/** POST with the native environment's bearer session; open the returned URL in an auth session. */
export const GitHubNativeConnectRequest = Schema.Struct({ returnUrl: Schema.String });
export const GitHubNativeConnectResponse = Schema.Struct({ url: Schema.String });

/** Only the app's account-return entry point may receive a connect result. */
export const isGitHubNativeReturnUrl = (value: string) =>
  ACCOUNT_NATIVE_RETURN_SCHEMES.some((scheme) => value === `${scheme}//account-return`);
