export const HARNESS_C_PRODUCT_CAPABILITY_KEYS = {
  release: "HARNESS_C_PRODUCT_RELEASES",
  nativeCheckpoint: "HARNESS_C_PRODUCT_NATIVE_CHECKPOINTS",
  access: "HARNESS_C_PRODUCT_ACCESS",
  programs: "HARNESS_C_PRODUCT_PROGRAMS",
  machine: "HARNESS_C_PRODUCT_MACHINE",
  model: "HARNESS_C_PRODUCT_MODEL",
  executor: "HARNESS_C_PRODUCT_EXECUTOR",
  turnGrantSource: "HARNESS_C_PRODUCT_TURN_GRANT_SOURCE",
} as const;

export class HarnessCProductCapabilityError extends Error {
  readonly _tag = "HarnessCProductCapabilityError";
  readonly capability: string;

  constructor(capability: string) {
    super(`Required product bootstrap capability is missing: ${capability}.`);
    this.capability = capability;
  }
}

export function requireHarnessCProductCapability<T>(
  capabilities: Readonly<Record<string, Fetcher>> | undefined,
  name: string,
  methods: readonly string[],
): T {
  if (capabilities === undefined)
    throw new HarnessCProductCapabilityError("HARNESS_C_PRODUCT_CAPABILITIES");
  const capability = capabilities[name];
  if (capability === undefined) throw new HarnessCProductCapabilityError(name);
  const service = capability as unknown as Record<string, unknown>;
  for (const method of methods) {
    if (typeof service[method] !== "function")
      throw new HarnessCProductCapabilityError(`${name}.${method}`);
  }
  return capability as unknown as T;
}
