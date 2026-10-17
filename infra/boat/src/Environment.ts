import * as boat from "@distilled.cloud/boat-dev/boat";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { formatEnvContents, parseEnvContents } from "./dotenv.ts";
import type { Providers } from "./Providers.ts";
import { reveal, type SecretInput } from "./secret.ts";

export interface EnvironmentRepository {
  /**
   * The GitHub repository, as `owner/name` (resolved through the repositories
   * the Boat GitHub app can see) or as Boat's repository `databaseId`.
   */
  repository: string;
  /** Branch new sandboxes check out. Omit to keep Boat's choice. */
  baseBranch?: string;
  /** Script that runs after the repository is cloned. */
  setupScript?: string;
  /** Whether the sandbox waits for `setupScript` before it is ready. */
  setupBlocking?: boolean;
}

export interface EnvironmentProps {
  /**
   * Environment name, unique within your account. Sandboxes pick an
   * environment by this name. If omitted, a unique name is generated from
   * the stack, stage, and logical ID. Changing it renames the environment.
   */
  name?: string;
  /**
   * Make this the environment sandboxes get when they don't name one.
   * Setting it moves the default here; `false` leaves the default where it
   * is (move it by marking another environment default). Boat can't delete
   * the default environment, so destroying it leaves it in place.
   */
  isDefault?: boolean;
  /**
   * Pass nothing to sandboxes (repositories, secrets and credentials are all
   * withheld), overriding the `pass*` flags. Use for sandboxes handed to
   * third parties. Omit to leave the setting as Boat has it (`false` on a
   * new environment).
   */
  safeForThirdParties?: boolean;
  /** Attach the GitHub repositories and the GitHub token. Omit to leave as is (`true` on a new environment). */
  passGithub?: boolean;
  /** Attach `vars` and `secretFiles`. Omit to leave as is (`true` on a new environment). */
  passSecrets?: boolean;
  /** Attach the sandbox's own service and preview credentials. Omit to leave as is (`true` on a new environment). */
  passSandboxCredentials?: boolean;
  /** Attach agent-provider credentials. Omit to leave as is (`true` on a new environment). */
  passAgentsCredentials?: boolean;
  /**
   * Environment variables. Values are secrets: pass them as `Redacted` to
   * keep them out of logs. The map is the complete set: variables Boat has
   * that are not listed are removed. Omit to leave the variables alone.
   */
  vars?: Record<string, SecretInput>;
  /**
   * Secret files, keyed by path under the sandbox user's home. The map is
   * the complete set. Omit to leave the secret files alone.
   */
  secretFiles?: Record<string, SecretInput>;
  /**
   * Repositories cloned into new sandboxes. The list is the complete set.
   * Omit to leave the repositories alone.
   */
  repositories?: EnvironmentRepository[];
  /**
   * Move the account's running and stopped sandboxes onto the new version
   * whenever a deploy changes the environment. Without it, existing
   * sandboxes keep the version they were created on.
   * @default false
   */
  upgradeSandboxes?: boolean;
}

export interface EnvironmentAttributes {
  environmentId: string;
  name: string;
  /** Whether this is the default environment. */
  isDefault: boolean;
  /** Id of the latest immutable version. */
  latestVersionId: string | undefined;
  /** Number of the latest version (0 when there is none). */
  latestVersionNumber: number;
  /** Whether the environment passes nothing to sandboxes. */
  safeForThirdParties: boolean;
  /** Whether GitHub repositories and the GitHub token are attached. */
  passGithub: boolean;
  /** Whether variables and secret files are attached. */
  passSecrets: boolean;
  /** Whether the sandbox's own credentials are attached. */
  passSandboxCredentials: boolean;
  /** Whether agent-provider credentials are attached. */
  passAgentsCredentials: boolean;
  /** Names of the environment's variables (values are never stored). */
  varNames: string[];
  /** Paths of the environment's secret files (contents are never stored). */
  secretFilePaths: string[];
  /** `databaseId`s of the attached repositories. */
  repositoryIds: string[];
}

export type Environment = Resource<
  "Boat.Environment",
  EnvironmentProps,
  EnvironmentAttributes,
  never,
  Providers
>;

/**
 * A Boat sandbox environment: the repositories, variables, secret files and
 * credential settings a sandbox gets when it is created with this
 * environment's name.
 *
 * Every change mints a new immutable version. Sandboxes stay on the version
 * they were created on unless `upgradeSandboxes` is set. Variable values and
 * secret file contents are sent to Boat but only their names are kept in
 * the resource's attributes.
 *
 * Boat's account secrets (`/secrets`) are the default environment's
 * variables and secret files: manage them by adopting the default
 * environment (`base` unless you changed it).
 * @see https://docs.boat.dev/api/v1
 *
 * @resource
 * @product Environment
 */
export const Environment = Resource<Environment>("Boat.Environment");

/** The Boat GitHub app can't see a repository the environment lists. */
export class EnvironmentRepositoryNotVisible extends Data.TaggedError(
  "EnvironmentRepositoryNotVisible",
)<{ message: string }> {}

/** Boat accepted a create but the environment isn't listed. */
export class EnvironmentNotFoundAfterCreate extends Data.TaggedError(
  "EnvironmentNotFoundAfterCreate",
)<{ message: string }> {}

const environmentName = (id: string, name: string | undefined) =>
  name ? Effect.succeed(name) : createPhysicalName({ id, lowercase: true, maxLength: 64 });

const listEnvironments = boat.listEnvironments({}).pipe(Effect.map((res) => res.environments));

const findEnvironment = (match: { id?: string | undefined; name: string }) =>
  listEnvironments.pipe(
    Effect.map(
      (environments) =>
        (match.id === undefined ? undefined : environments.find((e) => e.id === match.id)) ??
        environments.find((e) => e.name === match.name),
    ),
  );

const toAttrs = (env: boat.SandboxEnvironment): EnvironmentAttributes => ({
  environmentId: env.id,
  name: env.name,
  isDefault: env.isDefault,
  latestVersionId: env.latestVersionId ?? undefined,
  latestVersionNumber:
    env.versions.find((version) => version.id === env.latestVersionId)?.versionNumber ?? 0,
  safeForThirdParties: env.safeForThirdParties,
  passGithub: env.passGithub,
  passSecrets: env.passSecrets,
  passSandboxCredentials: env.passSandboxCredentials,
  passAgentsCredentials: env.passAgentsCredentials,
  varNames: Object.keys(parseEnvContents(reveal(env.envContents))).sort(),
  secretFilePaths: env.secretFiles.map((file) => file.path).sort(),
  repositoryIds: (env.selectedRepositories ?? []).flatMap((repo) =>
    repo.databaseId ? [repo.databaseId] : [],
  ),
});

/** Resolve `owner/name` to Boat's repository `databaseId`; ids pass through. */
const resolveRepositoryId = (repository: string) =>
  Effect.gen(function* () {
    if (!repository.includes("/")) return repository;
    const name = repository.split("/").pop()!;
    const installations = yield* boat.listRepos
      .items({ q: name, limit: 100 })
      .pipe(Stream.runCollect);
    const match = Array.from(installations)
      .flatMap((installation) => installation.repositories ?? [])
      .find((repo) => repo.fullName?.toLowerCase() === repository.toLowerCase());
    if (!match?.databaseId) {
      return yield* new EnvironmentRepositoryNotVisible({
        message: `Boat cannot see GitHub repository ${repository}. Install the Boat GitHub app on it first.`,
      });
    }
    return match.databaseId;
  });

const fileMap = (files: ReadonlyArray<{ path: string; contents: SecretInput }>) =>
  Object.fromEntries(files.map((file) => [file.path, reveal(file.contents)]));

const revealAll = (record: Record<string, SecretInput>) =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [key, reveal(value)]));

export const EnvironmentProvider = () =>
  Provider.effect(
    Environment,
    Effect.succeed({
      stables: ["environmentId"],
      read: Effect.fn(function* ({ id, olds, output }) {
        const name = output?.name ?? (yield* environmentName(id, olds?.name));
        const env = yield* findEnvironment({ id: output?.environmentId, name });
        if (!env) return undefined;
        const attrs = toAttrs(env);
        // Boat has no tags: an environment found under an explicit,
        // user-chosen name without prior state may belong to someone else.
        return output === undefined && olds?.name !== undefined ? Unowned(attrs) : attrs;
      }),
      reconcile: Effect.fn(function* ({ id, news, output, session }) {
        const name = yield* environmentName(id, news.name ?? output?.name);

        // Observe
        let env = yield* findEnvironment({ id: output?.environmentId, name });

        // Ensure
        if (!env) {
          yield* session.note(`Creating environment ${name}...`);
          env = yield* boat.createEnvironment({ name }).pipe(
            Effect.map((res) => res.environments.find((e) => e.name === name)),
            Effect.catchTags({ Conflict: () => findEnvironment({ name }) }),
          );
          if (!env) {
            return yield* new EnvironmentNotFoundAfterCreate({
              message: `Boat environment ${name} vanished after create`,
            });
          }
        }

        // Sync every managed setting against the observed environment in
        // one update, so a deploy mints at most one new version.
        const update: Omit<boat.UpdateEnvironmentRequest, "environmentId"> = {};
        if (env.name !== name) update.name = name;
        if (news.isDefault === true && !env.isDefault) update.isDefault = true;
        for (const flag of [
          "safeForThirdParties",
          "passGithub",
          "passSecrets",
          "passSandboxCredentials",
          "passAgentsCredentials",
        ] as const) {
          if (news[flag] !== undefined && news[flag] !== env[flag]) {
            update[flag] = news[flag];
          }
        }
        if (news.vars !== undefined) {
          const desired = revealAll(news.vars);
          if (!deepEqual(desired, parseEnvContents(reveal(env.envContents)))) {
            update.envContents = formatEnvContents(desired);
          }
        }
        if (news.secretFiles !== undefined) {
          const desired = revealAll(news.secretFiles);
          if (!deepEqual(desired, fileMap(env.secretFiles))) {
            update.secretFiles = Object.entries(desired).map(([path, contents]) => ({
              path,
              contents,
            }));
          }
        }
        if (news.repositories !== undefined) {
          const desired = yield* Effect.forEach(news.repositories, (repo) =>
            resolveRepositoryId(repo.repository).pipe(
              Effect.map((repositoryId) => ({
                repositoryId,
                ...(repo.baseBranch !== undefined ? { baseBranch: repo.baseBranch } : {}),
                ...(repo.setupScript !== undefined ? { setupScript: repo.setupScript } : {}),
                ...(repo.setupBlocking !== undefined ? { setupBlocking: repo.setupBlocking } : {}),
              })),
            ),
          );
          const observed = env.selectedRepositories ?? [];
          // Compare only what the props pin; Boat fills in the rest
          // (e.g. the repository's default branch).
          const inSync =
            desired.length === observed.length &&
            desired.every((want) => {
              const have = observed.find((repo) => repo.databaseId === want.repositoryId);
              return (
                have !== undefined &&
                (want.baseBranch === undefined || want.baseBranch === have.baseBranch) &&
                (want.setupScript === undefined || want.setupScript === have.setupScript) &&
                (want.setupBlocking === undefined || want.setupBlocking === have.setupBlocking)
              );
            });
          if (!inSync) update.repositories = desired;
        }

        if (Object.keys(update).length > 0) {
          yield* session.note(`Updating environment ${name}...`);
          const updated = yield* boat.updateEnvironment({ environmentId: env.id, ...update });
          env = updated.environment ?? (yield* findEnvironment({ id: env.id, name })) ?? env;
          if (news.upgradeSandboxes) {
            yield* session.note(`Upgrading sandboxes to the latest version of ${name}...`);
            yield* boat.upgradeEnvironment({ environmentId: env.id });
          }
        }

        return toAttrs(env);
      }),
      delete: Effect.fn(function* ({ output }) {
        const env = (yield* listEnvironments).find((e) => e.id === output.environmentId);
        if (env?.isDefault) {
          yield* Effect.logWarning(
            `Boat environment ${env.name} is the account's default, which Boat can't delete; it is left in place.`,
          );
          return;
        }
        yield* boat
          .deleteEnvironment({ environmentId: output.environmentId })
          .pipe(Effect.catchTags({ NotFound: () => Effect.void }));
      }),
      list: Effect.fn(function* () {
        // The default environment can never be deleted, so it is not
        // listed for account-wide teardown.
        return (yield* listEnvironments).filter((env) => !env.isDefault).map(toAttrs);
      }),
    }),
  );
