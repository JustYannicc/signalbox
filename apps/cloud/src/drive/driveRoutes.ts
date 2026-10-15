import {
  DRIVE_API_PREFIX,
  DRIVE_PATHS,
  type DriveState,
  driveJson,
  MAX_DIRECT_PACK_BYTES,
  MAX_REMOTE_COMMITS,
  REMOTE_COMMITS_HEADER,
  Oid,
  PACK_INDEX_LENGTH_HEADER,
  PACKS_AFTER_HEADER,
  type RefWriteResult,
  REMOTE_HEAD_HEADER,
} from "@signalbox/runner-protocol/DriveProtocol";
import { ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
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
import * as Platform from "../platform.ts";
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
import { isAutomationApiPath, serveAutomationRequest } from "./automationRoutes.ts";
import { isBranchApiPath, serveBranchRequest } from "./branchRoutes.ts";
import {
  type DirectUploads,
  type DirectUploadsEnv,
  makeDirectUploads,
  s3Storage,
} from "./directUploads.ts";
import { uploadPack } from "./DriveUploads.ts";
import { threadOfDriveToken } from "./driveToken.ts";
import {
  areRemoteCommits,
  forwardRemote,
  isRemoteHead,
  proxyRemote,
  remoteFileSizes,
} from "./remoteRoutes.ts";
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

export interface DriveRouteEnv extends GitHub.GitHubEnv, DirectUploadsEnv {
  readonly THREADS: ThreadDirectory.ThreadObjectNamespace;
  readonly USERS: UserDirectory.UserObjectNamespace;
  readonly DRIVES: DriveDirectory.DriveObjectNamespace;
  readonly DRIVE_PACKS: DrivePacks.PackBucket;
  readonly DRIVE_PACKS_PREFIX?: string;
}

type Services =
  | Crypto.Crypto
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
/** Uploads straight to storage (#406), or null when this cloud has no S3 credentials. */
let direct: DirectUploads | null | undefined;

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
          DrivePacks.layerBucket(env.DRIVE_PACKS, env.DRIVE_PACKS_PREFIX),
          Platform.layerCrypto,
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
  if (direct === undefined) {
    const storage = s3Storage(env);
    direct =
      storage === null
        ? null
        : makeDirectUploads({ bucket: env.DRIVE_PACKS, storage, prefix: env.DRIVE_PACKS_PREFIX });
  }
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

/**
 * An upload's remote commits, each checked against the remote as the
 * thread's user: its head, and others its branch sits on (#394). What may
 * lean on the remote, or the refusal.
 */
async function checkedRemote(
  run: <A, E>(effect: Effect.Effect<A, E, Services>) => Promise<A>,
  auth: { readonly driveId: string; readonly userId: string },
  remoteHead: Oid | null,
  remoteCommits: ReadonlyArray<Oid>,
) {
  if (remoteCommits.length > MAX_REMOTE_COMMITS) {
    return text(`More than ${MAX_REMOTE_COMMITS} remote commits in one upload.`, 400);
  }
  if (remoteHead !== null && !(await run(isRemoteHead(auth.driveId, auth.userId, remoteHead)))) {
    return text("That is not the remote's head.", 422);
  }
  if (
    remoteCommits.length > 0 &&
    !(await run(areRemoteCommits(auth.driveId, auth.userId, remoteCommits)))
  ) {
    return text("The remote doesn't hold those commits.", 422);
  }
  // Other remote commits' files are promised with unknown sizes: read when first needed.
  return {
    ...(remoteHead === null
      ? {}
      : {
          remoteHead,
          promisedSizes: remoteFileSizes(auth.driveId, auth.userId, remoteHead),
        }),
    ...(remoteCommits.length === 0 ? {} : { remoteCommits }),
  };
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
  // The thread's agent publishing its own branch, as its owner (#135).
  if (isBranchApiPath(new URL(request.url).pathname)) {
    if (request.method !== "POST") return text("Method not allowed.", 405);
    return await runtime!.runPromise(serveBranchRequest(auth, await request.text()));
  }
  // The thread's agent using automations, which run in its owner's object (#434).
  if (isAutomationApiPath(new URL(request.url).pathname)) {
    if (request.method !== "POST") return text("Method not allowed.", 405);
    return await runtime!.runPromise(serveAutomationRequest(auth, await request.text()));
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
      const listed = request.headers.get(REMOTE_COMMITS_HEADER);
      const remoteCommits = listed === null ? [] : listed.split(",").map((oid) => decodeOid(oid));
      if (remoteCommits.some((oid) => oid._tag === "None")) {
        return text(`Bad ${REMOTE_COMMITS_HEADER}.`, 400);
      }
      const remote = await checkedRemote(
        run,
        auth,
        remoteHead?.value ?? null,
        remoteCommits.flatMap((oid) => (oid._tag === "Some" ? [oid.value] : [])),
      );
      if (remote instanceof Response) return remote;
      const result = await run(
        uploadPack({
          driveId: auth.driveId,
          threadId: auth.threadId,
          idx: body.subarray(0, idxLength),
          pack: body.subarray(idxLength),
          ...remote,
        }),
      );
      return result._tag === "ok"
        ? json(driveJson.packUpload.encode({ name: result.name, objects: result.objects }))
        : text(result.reason, 422);
    }
    case DRIVE_PATHS.directUpload: {
      const parsed = decodeBody(driveJson.directUpload.decode, await request.text());
      if (parsed === null) return text("Unreadable request.", 400);
      if (direct === null || direct === undefined) {
        return json(driveJson.directOffer.encode({ _tag: "inline" }));
      }
      const offered = await run(direct.offer(auth.driveId, parsed));
      if (offered._tag === "too_large") {
        return text(
          `A pack of ${parsed.packSize} bytes is more than a drive takes at once (${MAX_DIRECT_PACK_BYTES}).`,
          413,
        );
      }
      return json(driveJson.directOffer.encode(offered));
    }
    case DRIVE_PATHS.directCommit: {
      const parsed = decodeBody(driveJson.directCommit.decode, await request.text());
      if (parsed === null) return text("Unreadable request.", 400);
      if (direct === null || direct === undefined) {
        return text("This cloud takes packs in a request's body.", 404);
      }
      const remote = await checkedRemote(
        run,
        auth,
        parsed.remoteHead ?? null,
        parsed.remoteCommits ?? [],
      );
      if (remote instanceof Response) return remote;
      const result = await run(
        direct.commit({
          driveId: auth.driveId,
          threadId: auth.threadId,
          uploadId: parsed.uploadId,
          ...remote,
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
