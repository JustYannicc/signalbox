import {
  DRIVE_API_PREFIX,
  DRIVE_PATHS,
  type DriveState,
  driveJson,
  PACK_INDEX_LENGTH_HEADER,
  PACKS_AFTER_HEADER,
  type RefWriteResult,
} from "@signalbox/runner-protocol/DriveProtocol";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";

import { type ThreadObjectNamespace, threadObjectStub } from "../thread/ThreadDirectory.ts";
import type { DriveAuthorization } from "../thread/runner/ThreadRunner.ts";
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

/**
 * The drive API a thread's Runner calls (`DriveProtocol.ts`). Each request
 * carries the thread's drive token; the thread's object says whether it is
 * good and for which drive and machine generation, and the drive's object
 * decides what that writer may do. Nothing here trusts the Runner further.
 */

export interface DriveRouteEnv {
  readonly THREADS: ThreadObjectNamespace;
  readonly DRIVES: DriveDirectory.DriveObjectNamespace;
  readonly DRIVE_PACKS: DrivePacks.PackBucket;
}

export const isDriveApiPath = (pathname: string) => pathname.startsWith(`${DRIVE_API_PREFIX}/`);

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

const decodeBody = <A>(decode: (text: string) => A, body: string): A | null => {
  try {
    return decode(body);
  } catch {
    return null;
  }
};

const json = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });
const text = (body: string, status: number) => new Response(body, { status });

const toState = (driveId: string, refs: ThreadRefs): DriveState => ({
  driveId,
  main: refs.main,
  thread: refs.thread,
  wip: refs.wip,
  base: refs.base,
  packs: refs.packs,
});

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
  const verdict = await threadObjectStub(env.THREADS, threadId.value, {
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

let runtime:
  | ManagedRuntime.ManagedRuntime<DriveDirectory.DriveDirectory | DrivePacks.DrivePacks, never>
  | undefined;

/** One drive API request. Anything unexpected is logged and answered 500, which the Runner retries. */
export async function handleDriveRequest(
  env: DriveRouteEnv,
  request: Request,
  options: { readonly localWorkerd: boolean },
): Promise<Response> {
  runtime ??= ManagedRuntime.make(
    Layer.mergeAll(
      DriveDirectory.layerDurableObjects(env.DRIVES, options),
      DrivePacks.layerBucket(env.DRIVE_PACKS),
    ),
  );
  try {
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
  const packsAfter = Number(request.headers.get(PACKS_AFTER_HEADER) ?? 0);
  const writer: DriveWriter = {
    threadId: auth.threadId,
    userId: auth.userId,
    generation: auth.generation,
    live: auth.live,
    packsAfter: Number.isSafeInteger(packsAfter) && packsAfter > 0 ? packsAfter : 0,
  };
  const { pathname } = new URL(request.url);
  const run = <A, E>(
    effect: Effect.Effect<A, E, DriveDirectory.DriveDirectory | DrivePacks.DrivePacks>,
  ) => runtime!.runPromise(effect);
  const drive = DriveDirectory.DriveDirectory.use((directory) =>
    Effect.succeed(directory.forDrive(auth.driveId)),
  );

  if (request.method === "GET" && pathname.startsWith(`${DRIVE_PATHS.packs}/`)) {
    const match = /^([0-9a-f]{40})\.(pack|idx)$/.exec(pathname.slice(DRIVE_PATHS.packs.length + 1));
    if (match === null) return text("Unknown pack.", 404);
    const file = await run(
      DrivePacks.DrivePacks.use((packs) =>
        packs.get(auth.driveId, match[1]!, match[2] as DrivePacks.PackFile),
      ),
    );
    return file === null
      ? text("Unknown pack.", 404)
      : new Response(file.body, {
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(file.size),
            "cache-control": "private, max-age=31536000, immutable",
          },
        });
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
    case DRIVE_PATHS.packs: {
      const idxLength = Number(request.headers.get(PACK_INDEX_LENGTH_HEADER));
      const body = new Uint8Array(await request.arrayBuffer());
      if (!Number.isInteger(idxLength) || idxLength <= 0 || idxLength >= body.length) {
        return text(`Missing or bad ${PACK_INDEX_LENGTH_HEADER}.`, 400);
      }
      const result = await run(
        uploadPack({
          driveId: auth.driveId,
          threadId: auth.threadId,
          idx: body.subarray(0, idxLength),
          pack: body.subarray(idxLength),
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
    default:
      return text("Unknown path.", 404);
  }
}
