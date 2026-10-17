import { RunId } from "@t3tools/contracts";
import { OnePasswordEnvironmentId } from "@t3tools/contracts/signalboxFolders";
import * as Base64 from "effect/encoding/Base64";

import type { SecretsRegistration } from "../SecretsProtocol.ts";
import { secretPlaceholder } from "../SecretScrubber.ts";
import { SYNTHETIC_SECRET_ENVIRONMENT, SYNTHETIC_SECRET_NAMES } from "../SyntheticSecrets.ts";

const environment = OnePasswordEnvironmentId.make(SYNTHETIC_SECRET_ENVIRONMENT);

const valuesForGeneration = (generation: number) => {
  if (generation !== 0 && generation !== 1) {
    throw new RangeError("Synthetic secret fixture supports only its initial and rotated canaries");
  }
  return SYNTHETIC_SECRET_NAMES.map((name, index) => ({
    name,
    value: Base64.encode(
      Uint8Array.from(
        { length: 32 },
        (_, offset) => (generation * 128 + (index + 1) * 37 + offset * 17) % 256,
      ),
    ),
  }));
};

/** A canary-only registration fixture for the runner/cloud protocol boundary. */
export const syntheticSecretsRegistrationFixture = (
  runId: RunId,
  generation = 0,
): SecretsRegistration => {
  const values = valuesForGeneration(generation);
  return {
    runId,
    secrets: values,
    current: values,
    sources: values.map(({ name }) => ({ name, environment })),
  };
};

/** Request and response text shared by runner persistence and cloud egress proofs. */
export const syntheticSecretsEchoFixture = (registration: SecretsRegistration) => {
  const text = (resolve: boolean) =>
    registration.current
      .map(({ name, value }) => `${name}=${resolve ? value : secretPlaceholder(name)}`)
      .join("\n");
  return {
    placeholder: text(false),
    resolved: text(true),
  };
};

const isCanonical32ByteBase64 = (value: string) => {
  try {
    const decoded = atob(value);
    return decoded.length === 32 && btoa(decoded) === value;
  } catch {
    return false;
  }
};

/** The properties shared by real synthetic loads and the cloud protocol fixture. */
export const hasSyntheticSecretsRegistrationShape = (
  registration: Omit<SecretsRegistration, "runId">,
): boolean => {
  const names = SYNTHETIC_SECRET_NAMES;
  return (
    registration.secrets.length === names.length &&
    registration.current.length === names.length &&
    registration.sources?.length === names.length &&
    registration.secrets.every(
      ({ name, value }, index) => name === names[index] && isCanonical32ByteBase64(value),
    ) &&
    registration.current.every(
      ({ name, value }, index) =>
        name === registration.secrets[index]?.name && value === registration.secrets[index]?.value,
    ) &&
    registration.sources.every(
      ({ name, environment: source }, index) => name === names[index] && source === environment,
    ) &&
    new Set(registration.secrets.map(({ value }) => value)).size === names.length
  );
};
