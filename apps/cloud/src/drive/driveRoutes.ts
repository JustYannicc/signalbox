import {
  DRIVE_API_PREFIX,
  DRIVE_PATHS,
  type DriveState,
  driveJson,
  Oid,
  PACK_INDEX_LENGTH_HEADER,
  PACKS_AFTER_HEADER,
  type RefWriteResult,
  REMOTE_HEAD_HEADER,
} from "@signalbox/runner-protocol/DriveProtocol";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";

import {
  contextResponse,
  isContextApiPath,
  serveContextRequest,
} from "../context/contextRoutes.ts";
import * as ContextTool from "../context/ContextTool.ts";
import * as GitHub from "../github/GitHub.ts";
import * as ThreadDirectory from "../thread/ThreadDirectory.ts";
import type { DriveAuthorization } from "../thread/runner/ThreadRunner.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import * as DriveDirectory from "./DriveDirectory.ts";
import * as DrivePacks from "./DrivePacks.ts";
import {
  type DriveWriter,
  type RefWrite,
  type ThreadRefs,
  threadRef,
  wipRef,
} from "./DriveStore.ts";
import { uploadPack } from "./DriveUploads.ts";
import { threadOfDriveToken } from "./driveToken.ts";
import { forwardRemote, isRemoteHead, proxyRemote } from "./remoteRoutes.ts";
import { decodeBody, json, packResponse, text } from "./routeResponses.ts";
import { shortcutRoute } from "./shortcutRoutes.ts";

/**
 * The drive API a thread's Runner calls (`DriveProtocol.ts`). Each request
 * carries the thread's drive token; the thread's object says whether it is
 * good and for which drive and machine generation, and the drive's object
 * decides what that writer may do. Nothing here trusts the Runner further: a
 * remote-backed drive's `main` only ever moves to what the remote itself says
 * its head is (`remoteRoutes.ts`), and its remote is reached with the
 * thread's own remote token, never the drive token.
 */

export interface DriveRouteEnv extends GitHub.GitHubEnv {
  readonly THREADS: ThreadDirectory.ThreadObjectNamespace;
  readonly USERS: UserDirectory.UserObjectNamespace;
  readonly DRIVES: DriveDirectory.DriveObjectNamespace;
  readonly DRIVE_PACKS: DrivePacks.PackBucket;
}

type Services =
  | DriveDirectory.DriveDirectory
  | DrivePacks.DrivePacks
  | UserDirectory.UserDirectory
  | GitHub.GitHub
  | ContextTool.ContextTool;

export const isDriveApiPath = (pathname: string) => pathname.startsWith(`${DRIVE_API_PREFIX}/`);

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

const toState = (driveId: string, refs: ThreadRefs): DriveState => ({
  driveId,
  main: refs.main,
  thread: refs.thread,
  wip: refs.wip,
  base: refs.base,
  packs: refs.packs,
  remote: refs.remote,
  shallow: refs.shallow,
});

const decodeOid = Schema.decodeUnknownOption(Oid);

const toResult = (driveId: string, write: RefWrite): RefWriteResult =>
  write._tag === "refused" ? write : { _tag: write._tag, state: toState(driveId, write.refs) };

async function authorize(
  env: DriveRouteEnv,
  request: Request,
  localWorkerd: boolean,
): Promise<Extract<DriveAuthorization, { _tag: "granted" }> | Response> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const name = threadOfDriveToken(token);
  const threadId = name === null ? null : decodeThreadId(name);
  if (threadId === null || threadId._tag === "None") return text("Not a drive token.", 401);
  const verdict = await ThreadDirectory.threadObjectStub(env.THREADS, threadId.value, {
    localWorkerd,
  }).authorizeDrive(token);
  switch (verdict._tag) {
    case "granted":
      return verdict;
    case "denied":
      return text(verdict.reason, 403);
    case "unavailable":
      return text("The drive is unavailable right now.", 503);
  }
}

let runtime: ManagedRuntime.ManagedRuntime<Services, never> | undefined;

/** One drive API request. Anything unexpected is logged and answered 500, which the Runner retries. */
export async function handleDriveRequest(
  env: DriveRouteEnv,
  request: Request,
  options: { readonly localWorkerd: boolean },
): Promise<Response> {
  runtime ??= ManagedRuntime.make(
    ContextTool.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          DriveDirectory.layerDurableObjects(env.DRIVES, options),
          DrivePacks.layerBucket(env.DRIVE_PACKS),
          UserDirectory.layerDurableObjects(env.USERS, options),
          ThreadDirectory.layerDurableObjects(env.THREADS, options),
          // Only users' own tokens act on GitHub here; the App's client stays in their objects.
          GitHub.layer(null, GitHub.gitHubEndpoints(env)).pipe(
            Layer.provide(FetchHttpClient.layer),
          ),
        ),
      ),
    ),
  );
  try {
    if (new URL(request.url).pathname.startsWith(`${DRIVE_PATHS.remote}/`)) {
      const resolved = await runtime.runPromise(proxyRemote(env.THREADS, request, options));
      return resolved instanceof Response ? resolved : await forwardRemote(request, resolved);
    }
    return await route(env, request, options);
  } catch (cause) {
    await runtime.runPromise(Effect.logError("drive request failed", { cause: String(cause) }));
    return text("The drive is unavailable right now.", 500);
  }
}

async function route(
  env: DriveRouteEnv,
  request: Request,
  options: { readonly localWorkerd: boolean },
): Promise<Response> {
  const auth = await authorize(env, request, options.localWorkerd);
  if (auth instanceof Response) return auth;
  // Reading beyond the thread's own drive (#141): what its owner can read, never write.
  if (isContextApiPath(new URL(request.url).pathname)) {
    if (request.method !== "POST") return text("Method not allowed.", 405);
    const reader = { userId: auth.userId, threadId: auth.threadId, driveId: auth.driveId };
    const path = new URL(request.url).pathname;
    return contextResponse(
      await runtime!.runPromise(serveContextRequest(reader, path, await request.text())),
    );
  }
  const packsAfter = Number(request.headers.get(PACKS_AFTER_HEADER) ?? 0);
  const writer: DriveWriter = {
    threadId: auth.threadId,
    userId: auth.userId,
    generation: auth.generation,
    live: auth.live,
    packsAfter: Number.isSafeInteger(packsAfter) && packsAfter > 0 ? packsAfter : 0,
  };
  const { pathname } = new URL(request.url);
  const run = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime!.runPromise(effect);
  const drive = DriveDirectory.DriveDirectory.use((directory) =>
    Effect.succeed(directory.forDrive(auth.driveId)),
  );

  // Shortcut targets, read-only (#142): the thread's user's access to each, asked now.
  if (pathname === DRIVE_PATHS.shortcuts || pathname.startsWith(`${DRIVE_PATHS.shortcuts}/`)) {
    return await run(shortcutRoute({ userId: auth.userId, driveId: auth.driveId }, request));
  }
  if (request.method === "GET" && pathname.startsWith(`${DRIVE_PATHS.packs}/`)) {
    return await run(packResponse(auth.driveId, pathname.slice(DRIVE_PATHS.packs.length + 1)));
  }
  if (request.method !== "POST") return text("Method not allowed.", 405);

  switch (pathname) {
    case DRIVE_PATHS.open: {
      const opened = await run(Effect.flatMap(drive, (handle) => handle.open(writer)));
      // A newer machine writes here now; nothing this one retries changes that.
      return opened._tag === "refused"
        ? text(opened.reason, 403)
        : json(driveJson.state.encode(toState(auth.driveId, opened.refs)));
    }
    case DRIVE_PATHS.state: {
      const refs = await run(
        Effect.flatMap(drive, (handle) => handle.refs(auth.threadId, writer.packsAfter)),
      );
      return json(driveJson.state.encode(toState(auth.driveId, refs)));
    }
    case DRIVE_PATHS.packs: {
      const idxLength = Number(request.headers.get(PACK_INDEX_LENGTH_HEADER));
      const body = new Uint8Array(await request.arrayBuffer());
      if (!Number.isInteger(idxLength) || idxLength <= 0 || idxLength >= body.length) {
        return text(`Missing or bad ${PACK_INDEX_LENGTH_HEADER}.`, 400);
      }
      const headerValue = request.headers.get(REMOTE_HEAD_HEADER);
      const remoteHead = headerValue === null ? null : decodeOid(headerValue);
      if (remoteHead?._tag === "None") return text(`Bad ${REMOTE_HEAD_HEADER}.`, 400);
      if (
        remoteHead !== null &&
        !(await run(isRemoteHead(auth.driveId, auth.userId, remoteHead.value)))
      ) {
        return text("That is not the remote's head.", 422);
      }
      const result = await run(
        uploadPack({
          driveId: auth.driveId,
          threadId: auth.threadId,
          idx: body.subarray(0, idxLength),
          pack: body.subarray(idxLength),
          ...(remoteHead === null ? {} : { remoteHead: remoteHead.value }),
        }),
      );
      return result._tag === "ok"
        ? json(driveJson.packUpload.encode({ name: result.name, objects: result.objects }))
        : text(result.reason, 422);
    }
    case DRIVE_PATHS.refs: {
      const parsed = decodeBody(driveJson.refUpdate.decode, await request.text());
      if (parsed === null) return text("Unreadable request.", 400);
      const { updates } = parsed;
      const names = { thread: threadRef(auth.threadId), wip: wipRef(auth.threadId) };
      const written = await run(
        Effect.flatMap(drive, (handle) =>
          handle.updateRefs(
            writer,
            updates.map((update) => ({
              name: names[update.ref],
              old: update.old,
              new: update.new,
            })),
          ),
        ),
      );
      return json(driveJson.refWrite.encode(toResult(auth.driveId, written)));
    }
    case DRIVE_PATHS.reconcile: {
      const body = decodeBody(driveJson.reconcile.decode, await request.text());
      if (body === null) return text("Unreadable request.", 400);
      const written = await run(Effect.flatMap(drive, (handle) => handle.reconcile(writer, body)));
      return json(driveJson.refWrite.encode(toResult(auth.driveId, written)));
    }
    case DRIVE_PATHS.mirror: {
      const body = decodeBody(driveJson.mirror.decode, await request.text());
      if (body === null) return text("Unreadable request.", 400);
      // Checked here, before the drive object moves anything: main only follows the remote.
      if (!(await run(isRemoteHead(auth.driveId, auth.userId, body.newMain)))) {
        return json(
          driveJson.refWrite.encode({ _tag: "refused", reason: "That is not the remote's head." }),
        );
      }
      const written = await run(Effect.flatMap(drive, (handle) => handle.mirror(writer, body)));
      return json(driveJson.refWrite.encode(toResult(auth.driveId, written)));
    }
    default:
      return text("Unknown path.", 404);
  }
}
