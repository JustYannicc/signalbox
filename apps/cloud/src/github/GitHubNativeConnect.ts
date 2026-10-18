import {
  GITHUB_CONNECT_PATH,
  isGitHubNativeReturnUrl,
} from "@t3tools/contracts/signalboxGitHubConnect";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import * as CloudSessions from "../auth/CloudSessions.ts";
import * as CloudTokens from "../auth/CloudTokens.ts";
import { GRANT_TTL_MS } from "./GitHubConnection.ts";

export const start = Effect.fn("GitHubNativeConnect.start")(function* (input: {
  readonly bearer: string;
  readonly returnUrl: string;
  readonly origin: string;
}) {
  // A browser cookie must never override the native caller's identity.
  const session = yield* (yield* CloudSessions.CloudSessions).authenticate({
    bearer: input.bearer,
  });
  if (!isGitHubNativeReturnUrl(input.returnUrl)) return null;
  const crypto = yield* Crypto.Crypto;
  const gid = (yield* Effect.orDie(crypto.randomUUIDv4())).replaceAll("-", "");
  const state = yield* (yield* CloudTokens.CloudTokens).sign({
    _tag: "github-native-start",
    u: session.userId,
    gid,
    returnUrl: input.returnUrl,
    exp: (yield* Clock.currentTimeMillis) + GRANT_TTL_MS,
  });
  const url = new URL(GITHUB_CONNECT_PATH, input.origin);
  url.searchParams.set("state", state);
  return { url: url.toString() };
});

export const returnLocation = (returnUrl: string, result: "connected" | "cancelled" | "failed") => {
  const url = new URL(returnUrl);
  url.searchParams.set("github", result);
  return url.toString();
};
