import * as Hash from "effect/Hash";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const Text = Schema.String.check(Schema.isNonEmpty()).check(
  Schema.makeFilter((value) => !/[\r\n\0]/.test(value)),
);
const Hostname = Schema.String.check(
  Schema.makeFilter((value) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)),
);
const PositiveSafeInteger = Schema.Number.check(Schema.isInt())
  .check(Schema.isGreaterThan(0))
  .check(Schema.makeFilter(Number.isSafeInteger));
const MemoryBytes = PositiveSafeInteger.check(Schema.isGreaterThanOrEqualTo(64 * 1024 * 1024));
const PositiveVcpuCount = PositiveSafeInteger.check(Schema.isLessThanOrEqualTo(256));

/** Modeled machine resources are guest-facing values, not host telemetry. */
export const SystemResourcesConfig = Schema.Struct({
  memoryBytes: MemoryBytes,
  vcpus: PositiveVcpuCount,
  profile: Schema.Literal("steady"),
});
export type SystemResourcesConfig = typeof SystemResourcesConfig.Type;

export const DEFAULT_SYSTEM_RESOURCES: SystemResourcesConfig = Object.freeze({
  memoryBytes: 4 * 1024 * 1024 * 1024,
  vcpus: 1,
  profile: "steady",
});

/** One configured machine image supplies the identity every execution tier presents. */
export const SystemIdentityConfig = Schema.Struct({
  release: Text,
  version: Text,
  machine: Schema.Literals(["x86_64", "aarch64"]),
  hostnamePolicy: Schema.Literal("thread"),
  verification: Schema.Literals(["provisional", "measured"]),
  /** Optional on decode for callers that still send the legacy identity shape. */
  resources: Schema.optional(SystemResourcesConfig),
});
export type SystemIdentityConfig = typeof SystemIdentityConfig.Type;

export const SystemIdentity = Schema.Struct({
  ...SystemIdentityConfig.fields,
  /** A legacy identity without resources resolves through the shared modeled defaults. */
  resources: SystemResourcesConfig.pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(DEFAULT_SYSTEM_RESOURCES)),
  ),
  hostname: Hostname,
  platform: Schema.Literal("linux"),
  type: Schema.Literal("Linux"),
  arch: Schema.Literals(["x64", "arm64"]),
  endianness: Schema.Literal("LE"),
});
export type SystemIdentity = typeof SystemIdentity.Type;

const decodeSystemIdentity = Schema.decodeUnknownSync(SystemIdentity);
const decodeSystemIdentityConfig = Schema.decodeUnknownSync(SystemIdentityConfig);
const sameResolvedSystemIdentity = Schema.toEquivalence(SystemIdentity);

export function sameSystemIdentity(left?: SystemIdentity, right?: SystemIdentity): boolean {
  return left === undefined || right === undefined
    ? left === right
    : sameResolvedSystemIdentity(decodeSystemIdentity(left), decodeSystemIdentity(right));
}

// Remeasure these defaults when the machine image changes.
// The resource profile stays modeled in guest output and never reports host telemetry.
export const DEFAULT_SYSTEM_IDENTITY: SystemIdentityConfig = Object.freeze({
  release: "6.18.0+",
  version: "#1 SMP PREEMPT_DYNAMIC Fri Oct 16 14:27:07 UTC 2026",
  machine: "x86_64",
  hostnamePolicy: "thread",
  verification: "measured",
  resources: DEFAULT_SYSTEM_RESOURCES,
});

export function systemHostname(threadId: string): string {
  if (!threadId) throw new TypeError("System identity requires a thread id");
  const name = threadId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (name === threadId && name.length <= 61 && /^[a-z0-9].*[a-z0-9]$/.test(name))
    return `t-${name}`;
  const suffix = (Hash.string(threadId) >>> 0).toString(16).padStart(8, "0");
  return `t-${name.slice(0, 50)}-${suffix}`;
}

export function systemIdentityForThread(
  threadId: string,
  config: SystemIdentityConfig = DEFAULT_SYSTEM_IDENTITY,
): SystemIdentity {
  const resolvedConfig = decodeSystemIdentityConfig(config);
  const identity = decodeSystemIdentity({
    ...resolvedConfig,
    resources: resolvedConfig.resources ?? DEFAULT_SYSTEM_RESOURCES,
    hostname: systemHostname(threadId),
    platform: "linux",
    type: "Linux",
    arch: resolvedConfig.machine === "x86_64" ? "x64" : "arm64",
    endianness: "LE",
  });
  return Object.freeze({
    ...identity,
    resources: Object.freeze({ ...identity.resources }),
  });
}
