import {
  SYNTHETIC_SECRET_ENVIRONMENT,
  SYNTHETIC_SECRET_NAMES,
} from "@signalbox/runner-protocol/SyntheticSecrets";
import type { SecretsRegistration } from "@signalbox/runner-protocol/SecretsProtocol";
import { secretPlaceholder } from "@signalbox/runner-protocol/SecretScrubber";
import { OnePasswordEnvironmentId } from "@t3tools/contracts/signalboxFolders";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";

import {
  type EnvironmentVariable,
  OnePasswordError,
  type OnePassword,
} from "./RunnerOnePassword.ts";
import { makeRunnerSecrets, SecretsRegisterError, type SecretsReport } from "./RunnerSecrets.ts";
import { maskingLogger, makeSecretMask } from "./secretMask.ts";

const syntheticId = OnePasswordEnvironmentId.make(SYNTHETIC_SECRET_ENVIRONMENT);
const otherId = OnePasswordEnvironmentId.make("ordinary-environment");
const ACCESS = { token: null, environments: [syntheticId], synthetic: true as const };

type Registration = Omit<SecretsRegistration, "runId">;

const makeReport = (input: {
  readonly secrets: ReturnType<typeof makeRunnerSecrets>;
  readonly refuse?: boolean;
}) => {
  const notices: Array<string> = [];
  const infos: Array<string> = [];
  const registrations: Array<Registration> = [];
  const environmentEmptyDuringRegistration: Array<boolean> = [];
  const report: SecretsReport = {
    notice: (message) => Effect.sync(() => void notices.push(message)),
    info: (message) => Effect.sync(() => void infos.push(message)),
    register: (registration) =>
      Effect.suspend(() => {
        environmentEmptyDuringRegistration.push(
          Object.keys(input.secrets.environment()).length === 0,
        );
        if (input.refuse === true) {
          return Effect.fail(
            new SecretsRegisterError({ message: "synthetic test registration refused" }),
          );
        }
        registrations.push(registration);
        return Effect.void;
      }),
  };
  return { report, notices, infos, registrations, environmentEmptyDuringRegistration };
};

const variable = (name: string, value: string): EnvironmentVariable => ({
  name,
  value,
  masked: true,
});

describe("RunnerSyntheticSecrets", () => {
  it.effect(
    "loads repeated synthetic assignments once and generates exactly three fresh values",
    () =>
      Effect.gen(function* () {
        let onePasswordCalls = 0;
        const secrets = makeRunnerSecrets({
          onePassword: () => {
            onePasswordCalls += 1;
            return Effect.fail(new OnePasswordError({ message: "must not sign in" }));
          },
          mask: makeSecretMask(),
          reserved: () => new Set(),
        });
        const access = { ...ACCESS, environments: [syntheticId, syntheticId] };
        const first = makeReport({ secrets });
        yield* secrets.load(access, first.report);
        const second = makeReport({ secrets });
        yield* secrets.load(access, second.report);
        const firstValues = first.registrations[0]!.secrets.map(({ value }) => value);
        const secondValues = second.registrations[0]!.secrets.map(({ value }) => value);
        expect(onePasswordCalls).toBe(0);
        expect(firstValues.length).toBe(3);
        expect(secondValues.length).toBe(3);
        expect(new Set([...firstValues, ...secondValues]).size).toBe(6);
        expect(first.registrations[0]!.sources?.length).toBe(3);
        expect(second.registrations[0]!.sources?.length).toBe(3);
        expect(first.infos).toEqual(["loaded 3 secrets from synthetic preview"]);
        expect(second.infos).toEqual(first.infos);
      }),
  );

  it.effect("registers generated values before exposing them and masks every output surface", () =>
    Effect.gen(function* () {
      let onePasswordCalls = 0;
      const mask = makeSecretMask();
      const secrets = makeRunnerSecrets({
        onePassword: (_token) => {
          onePasswordCalls += 1;
          return Effect.fail(new OnePasswordError({ message: "must not sign in" }));
        },
        mask,
        reserved: () => new Set(),
      });
      const recorder = makeReport({ secrets });
      const version = yield* secrets.load(ACCESS, recorder.report);
      const registration = recorder.registrations[0]!;
      const values = registration.secrets.map(({ value }) => value);

      expect(version).toBe(1);
      expect(onePasswordCalls).toBe(0);
      expect(recorder.environmentEmptyDuringRegistration).toEqual([true]);
      expect(registration.secrets.length).toBe(3);
      expect(registration.secrets.map(({ name }) => name)).toEqual(SYNTHETIC_SECRET_NAMES);
      expect(registration.current.map(({ name }) => name)).toEqual(SYNTHETIC_SECRET_NAMES);
      expect(registration.sources?.map(({ name, environment }) => [name, environment])).toEqual(
        SYNTHETIC_SECRET_NAMES.map((name) => [name, syntheticId]),
      );
      expect(
        values.every((value) => value.length === 44 && /^[A-Za-z0-9+/]{43}=$/.test(value)),
      ).toBe(true);
      expect(new Set(values).size).toBe(3);
      expect(Object.keys(secrets.environment()).toSorted()).toEqual([...SYNTHETIC_SECRET_NAMES]);
      expect(
        registration.current.every(({ name, value }) => secrets.environment()[name] === value),
      ).toBe(true);
      expect(recorder.infos).toEqual(["loaded 3 secrets from synthetic preview"]);
      expect(recorder.notices).toEqual([]);
      expect(
        [...recorder.infos, ...recorder.notices].some((message) =>
          values.some((value) => message.includes(value)),
        ),
      ).toBe(false);

      const transcript = secrets.mask(values.join("\n"));
      expect(values.every((value) => !transcript.includes(value))).toBe(true);
      expect(
        SYNTHETIC_SECRET_NAMES.every((name) => transcript.includes(secretPlaceholder(name))),
      ).toBe(true);

      const logLines: Array<string> = [];
      const capture = Logger.make(({ message }) => {
        logLines.push(...(Array.isArray(message) ? message : [message]).map(String));
      });
      yield* Effect.logInfo(`synthetic runner output ${values[0]}`).pipe(
        Effect.provide(Logger.layer([maskingLogger(mask, capture)], { mergeWithExisting: false })),
      );
      expect(logLines.length > 0).toBe(true);
      expect(logLines.every((line) => values.every((value) => !line.includes(value)))).toBe(true);
    }),
  );

  it.effect("generates a fresh set on each registration and keeps prior values masked", () =>
    Effect.gen(function* () {
      const mask = makeSecretMask();
      const secrets = makeRunnerSecrets({
        onePassword: () => Effect.fail(new OnePasswordError({ message: "must not sign in" })),
        mask,
        reserved: () => new Set(),
      });
      const first = makeReport({ secrets });
      yield* secrets.load(ACCESS, first.report);
      const firstValues = first.registrations[0]!.secrets.map(({ value }) => value);

      const second = makeReport({ secrets });
      yield* secrets.load(ACCESS, second.report);
      const secondValues = second.registrations[0]!.secrets.map(({ value }) => value);

      expect(first.environmentEmptyDuringRegistration).toEqual([true]);
      expect(second.environmentEmptyDuringRegistration).toEqual([true]);
      expect(firstValues.length).toBe(3);
      expect(secondValues.length).toBe(3);
      expect(firstValues.every((value) => !secondValues.includes(value))).toBe(true);
      expect(new Set(secondValues).size).toBe(3);
      expect(firstValues.every((value) => !secrets.mask(value).includes(value))).toBe(true);
      expect(secondValues.every((value) => !secrets.mask(value).includes(value))).toBe(true);
    }),
  );

  it.effect("clears the generated environment when registration fails", () =>
    Effect.gen(function* () {
      const mask = makeSecretMask();
      const secrets = makeRunnerSecrets({
        onePassword: () => Effect.fail(new OnePasswordError({ message: "must not sign in" })),
        mask,
        reserved: () => new Set(),
      });
      const accepted = makeReport({ secrets });
      yield* secrets.load(ACCESS, accepted.report);
      const previousValues = accepted.registrations[0]!.secrets.map(({ value }) => value);

      const refused = makeReport({ secrets, refuse: true });
      const error = yield* Effect.flip(secrets.load(ACCESS, refused.report));

      expect(error._tag).toBe("SecretsRegisterError");
      expect(refused.environmentEmptyDuringRegistration).toEqual([true]);
      expect(Object.keys(secrets.environment()).length).toBe(0);
      expect(secrets.fillable().values.size).toBe(0);
      expect(previousValues.every((value) => !secrets.mask(value).includes(value))).toBe(true);
    }),
  );

  it.effect("rejects the reserved source without the capability, regardless of token", () =>
    Effect.gen(function* () {
      let onePasswordCalls = 0;
      const secrets = makeRunnerSecrets({
        onePassword: () => {
          onePasswordCalls += 1;
          return Effect.fail(new OnePasswordError({ message: "must not sign in" }));
        },
        mask: makeSecretMask(),
        reserved: () => new Set(),
      });
      const enabled = makeReport({ secrets });
      yield* secrets.load(ACCESS, enabled.report);

      const withoutCapability = makeReport({ secrets });
      const missingCapability = yield* Effect.flip(
        secrets.load({ token: null, environments: [syntheticId] }, withoutCapability.report),
      );
      const withToken = makeReport({ secrets });
      const tokenWithoutCapability = yield* Effect.flip(
        secrets.load({ token: "opaque-test-token", environments: [syntheticId] }, withToken.report),
      );
      const mixed = makeReport({ secrets });
      const mixedSource = yield* Effect.flip(
        secrets.load(
          {
            token: "opaque-test-token",
            environments: [syntheticId, syntheticId, otherId],
            synthetic: true,
          },
          mixed.report,
        ),
      );

      expect(missingCapability.message).toBe(
        "The synthetic preview secret source requires a preview capability.",
      );
      expect(tokenWithoutCapability.message).toBe(missingCapability.message);
      expect(mixedSource.message).toBe(
        "The synthetic preview secret source cannot be mixed with 1Password Environments.",
      );
      expect(onePasswordCalls).toBe(0);
      expect(withoutCapability.registrations.length).toBe(0);
      expect(withToken.registrations.length).toBe(0);
      expect(mixed.registrations.length).toBe(0);
      expect(Object.keys(secrets.environment()).length).toBe(0);
      expect(secrets.fillable().guarded).toBe(false);
    }),
  );

  it.effect("keeps ordinary Environment reads on the existing 1Password path", () =>
    Effect.gen(function* () {
      let onePasswordCalls = 0;
      const ordinaryValue = "ordinary-environment-test-value";
      const onePassword: OnePassword = (token) => {
        onePasswordCalls += 1;
        return Effect.succeed({
          variables: (environmentId) =>
            Effect.succeed(
              token === "ordinary-token" && environmentId === otherId
                ? [variable("ORDINARY_KEY", ordinaryValue)]
                : [],
            ),
        });
      };
      const secrets = makeRunnerSecrets({
        onePassword,
        mask: makeSecretMask(),
        reserved: () => new Set(),
      });
      const recorder = makeReport({ secrets });

      yield* secrets.load({ token: "ordinary-token", environments: [otherId] }, recorder.report);

      expect(onePasswordCalls).toBe(1);
      expect(secrets.environment().ORDINARY_KEY === ordinaryValue).toBe(true);
      expect(recorder.registrations[0]!.secrets.map(({ name }) => name)).toEqual(["ORDINARY_KEY"]);
      expect(recorder.infos).toEqual(["loaded 1 secret from 1 1Password Environment"]);
    }),
  );
});
