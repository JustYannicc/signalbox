import { ProjectId, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { poolSourceId } from "@t3tools/contracts/accountHub";
import { FolderId } from "@t3tools/contracts/signalboxFolders";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { PoolEntry } from "../pool/poolViews.ts";
import * as ModelManifest from "../models/ModelManifest.ts";
import * as ModelCatalog from "../models/ModelCatalog.ts";
import * as ThreadContexts from "./threadContexts.ts";
import * as ThreadContextLayers from "./threadContextLayers.ts";
import * as UserDrives from "./UserDrives.ts";
import * as UserFolders from "./UserFolders.ts";
import * as UserModelSettings from "./UserModelSettings.ts";
import * as UserPools from "./UserPools.ts";
import { projectIdForDrive } from "./contextProjects.ts";

const projectId = ProjectId.make("project");
const checkedAt = "2026-10-17T00:00:00.000Z";
const pool: PoolEntry = {
  pool: {
    id: "work",
    objectName: "owner:work",
    name: "Work",
    personal: false,
    backing: { mode: "managed" },
  },
  source: {
    id: poolSourceId("work"),
    kind: "cliproxy",
    label: "Work",
    checkedAt,
    accounts: [
      {
        id: "account",
        driver: ProviderDriverKind.make("codex"),
        usageLimits: { checkedAt, windows: [] },
      },
    ],
  },
  models: [{ id: "gpt-6-luna", ownedBy: "openai", created: null }],
  role: "admin",
  routing: null,
};

const resolveOnWorkPool = (
  selection: UserModelSettings.ModelSettingsSnapshot["defaultModelSelection"],
) =>
  ThreadContexts.ThreadContexts.use((contexts) => contexts.initialModelSelection(projectId)).pipe(
    Effect.provide(
      ThreadContextLayers.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(UserDrives.UserDrives)({ userId: Effect.succeed("owner") }),
            Layer.mock(UserFolders.UserFolders)({
              turn: () =>
                Effect.succeed({
                  pools: { top: "work", projects: {} },
                  instructions: { top: [], projects: {} },
                  secrets: { top: [], projects: {} },
                }),
            }),
            Layer.mock(UserPools.UserPools)({ state: () => Effect.succeed([pool]) }),
            Layer.mock(UserModelSettings.UserModelSettings)({
              snapshot: Effect.succeed({
                ...UserModelSettings.EMPTY_MODEL_SETTINGS,
                defaultModelSelection: selection,
              }),
            }),
            ModelCatalog.layer.pipe(Layer.provide(ModelManifest.layerBundled)),
          ),
        ),
      ),
    ),
  );

describe("initial model on a folder's pool", () => {
  it.effect("falls back when the destination pool does not serve the preferred provider", () =>
    Effect.gen(function* () {
      const selection = yield* resolveOnWorkPool({
        instanceId: ProviderInstanceId.make("claude_hub"),
        model: "claude-haiku-5-5",
      });
      expect(selection).toEqual({ instanceId: "codex_hub_work", model: "gpt-6-luna" });
    }),
  );

  it.effect("falls back when the destination provider does not serve the preferred model", () =>
    Effect.gen(function* () {
      const selection = yield* resolveOnWorkPool({
        instanceId: ProviderInstanceId.make("codex_hub"),
        model: "gpt-6-astra",
      });
      expect(selection).toEqual({ instanceId: "codex_hub_work", model: "gpt-6-luna" });
    }),
  );

  it.effect("keeps a supported preference and its options when moving it onto the pool", () =>
    Effect.gen(function* () {
      const selection = yield* resolveOnWorkPool({
        instanceId: ProviderInstanceId.make("codex_hub"),
        model: "gpt-6-luna",
        options: [{ id: "reasoningEffort", value: "high" }],
      });
      expect(selection).toEqual({
        instanceId: "codex_hub_work",
        model: "gpt-6-luna",
        options: [{ id: "reasoningEffort", value: "high" }],
      });
    }),
  );
});

describe("folder context lifecycle", () => {
  it.effect.each(["place", "turn", "initial model"] as const)(
    "returns a typed refusal for a trashed home during %s resolution",
    (operation) =>
      Effect.gen(function* () {
        const contexts = yield* ThreadContexts.ThreadContexts;
        const threadId = ThreadId.make("trashed-home");
        const project = projectIdForDrive("folder/personal/hidden");
        const attempt =
          operation === "place"
            ? contexts.placeOfProject(project).pipe(Effect.asVoid)
            : operation === "turn"
              ? contexts.turn(threadId, project).pipe(Effect.asVoid)
              : contexts.initialModelSelection(project, threadId).pipe(Effect.asVoid);
        expect(yield* Effect.flip(attempt)).toMatchObject({
          _tag: "ThreadFolderTrashedError",
          message: "This thread's folder is in Trash.",
        });
      }).pipe(
        Effect.provide(
          ThreadContextLayers.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(UserDrives.UserDrives)({
                  userId: Effect.succeed("owner"),
                  access: () => Effect.succeed("owner"),
                }),
                Layer.mock(UserFolders.UserFolders)({
                  driveIsTrashed: () => Effect.succeed(true),
                  turn: () =>
                    Effect.fail(
                      new UserFolders.ThreadHomeTrashedError({
                        folderId: FolderId.make("hidden"),
                      }),
                    ),
                }),
                Layer.mock(UserPools.UserPools)({ state: () => Effect.succeed([pool]) }),
                Layer.mock(UserModelSettings.UserModelSettings)({
                  snapshot: Effect.succeed(UserModelSettings.EMPTY_MODEL_SETTINGS),
                }),
                ModelCatalog.layer.pipe(Layer.provide(ModelManifest.layerBundled)),
              ),
            ),
          ),
        ),
      ),
  );
});
