// @effect-diagnostics globalFetch:off - `forwardRemote` passes git's streams through untouched, outside Effect.
import { DRIVE_PATHS } from "@signalbox/runner-protocol/DriveProtocol";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { GitHub } from "../github/GitHub.ts";
import { gitAuthorization } from "../github/GitHubApi.ts";
import { type ThreadObjectNamespace, threadObjectStub } from "../thread/ThreadDirectory.ts";
import { UserDirectory } from "../user/UserDirectory.ts";
import { DriveDirectory } from "./DriveDirectory.ts";
import type { Oid } from "./git/gitObjects.ts";
import { threadOfRemoteToken } from "./remoteToken.ts";
import { decodeBody, text } from "./routeResponses.ts";
import { readsShortcut } from "./shortcutRoutes.ts";

/**
 * A remote-backed drive's remote, as the drive API reaches it (#135). The
 * cloud acts on the remote as the thread's user, with their GitHub connection
 * (`github/GitHubConnection.ts`); the machine only ever holds its turn's
 * remote token.
 *
 * - `remoteHead` is what `main` may mirror: the remote's default branch head
 *   right now, as GitHub reports it.
 * - `proxyRemote` serves `DRIVE_PATHS.remote` as git's smart HTTP, fetch only:
 *   `info/refs?service=git-upload-pack` and `git-upload-pack`, passed through
 *   to GitHub with the user's credential added. Pushing never goes this way.
 *   Under `shortcuts/<target>/` it serves a shortcut target's remote instead
 *   (#142), while the user can open that target.
 */

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

/** The drive's remote and the user's GitHub token, asked of both objects at once. */
const remoteAndToken = (driveId: string, userId: string) =>
  Effect.gen(function* () {
    const drives = yield* DriveDirectory;
    const users = yield* UserDirectory;
    return yield* Effect.all(
      [drives.forDrive(driveId).remote(), users.forUser(userId).githubAccessToken()],
      { concurrency: 2 },
    );
  });

/** The remote's default branch head now, acting as `userId`; null when it cannot be known. */
export const remoteHead = (driveId: string, userId: string) =>
  Effect.gen(function* () {
    const [remote, token] = yield* remoteAndToken(driveId, userId);
    if (remote === null || token === null) return null;
    const head = yield* (yield* GitHub).api.defaultHead(token, remote.repository);
    return head?.oid ?? null;
  });

/** Whether `oid` is the remote's head right now. */
export const isRemoteHead = (driveId: string, userId: string, oid: Oid) =>
  Effect.map(remoteHead(driveId, userId), (head) => head === oid);

/** The upstream request `proxyRemote` resolved to; the caller sends it and streams the answer back. */
export interface RemoteFetch {
  readonly url: string;
  readonly headers: Headers;
}

/** Sends a resolved fetch with the client's body, and passes GitHub's answer straight back. */
export async function forwardRemote(request: Request, target: RemoteFetch): Promise<Response> {
  const init: RequestInit & { readonly duplex?: "half" } = {
    method: request.method,
    headers: target.headers,
    // The request body streams through rather than being buffered (Node requires saying so).
    ...(request.method === "POST" ? { body: request.body, duplex: "half" } : {}),
  };
  const upstream = await fetch(target.url, init);
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "cache-control": "no-store",
    },
  });
}

/** Request headers git's smart HTTP needs passed through. */
const FORWARDED = ["content-type", "content-encoding", "accept", "git-protocol"];

export const proxyRemote = (
  threads: ThreadObjectNamespace,
  request: Request,
  options: { readonly localWorkerd: boolean },
) =>
  Effect.gen(function* () {
    const url = new URL(request.url);
    const full = url.pathname.slice(DRIVE_PATHS.remote.length + 1);
    // `shortcuts/<target>/<git path>`: a shortcut target's remote rather than the drive's own.
    const shortcut = /^shortcuts\/([^/]+)\/(.*)$/.exec(full);
    const path = shortcut === null ? full : shortcut[2]!;
    const fetching =
      (request.method === "GET" &&
        path === "info/refs" &&
        url.searchParams.get("service") === "git-upload-pack") ||
      (request.method === "POST" && path === "git-upload-pack");
    if (!fetching) return text("A drive's remote can only be fetched from.", 403);

    const header = request.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const name = threadOfRemoteToken(token);
    const threadId = name === null ? null : decodeThreadId(name);
    if (threadId === null || threadId._tag === "None") return text("Not a remote token.", 401);
    const verdict = yield* Effect.promise(() =>
      threadObjectStub(threads, threadId.value, options).authorizeRemote(token),
    );
    if (verdict._tag === "unavailable") return text("Try again in a moment.", 503);
    if (verdict._tag === "denied") return text(verdict.reason, 403);

    let driveId = verdict.driveId;
    if (shortcut !== null) {
      const target = decodeBody(decodeURIComponent, shortcut[1]!);
      if (target === null) return text("Unknown path.", 404);
      driveId = target;
      const reader = { userId: verdict.userId, driveId: verdict.driveId };
      if (!(yield* readsShortcut(reader, driveId))) {
        return text("This drive has no shortcut to that drive you can open.", 403);
      }
    }
    const [remote, githubToken] = yield* remoteAndToken(driveId, verdict.userId);
    if (remote === null) return text("This drive has no remote.", 404);
    if (githubToken === null) {
      return text("Connect GitHub in Signalbox to fetch this repository.", 403);
    }

    const headers = new Headers({
      authorization: gitAuthorization(githubToken),
      "user-agent": request.headers.get("user-agent") ?? "git/signalbox",
    });
    for (const name of FORWARDED) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const target = `${(yield* GitHub).api.gitUrl(remote.repository, path)}${url.search}`;
    return { url: target, headers } satisfies RemoteFetch;
  });
