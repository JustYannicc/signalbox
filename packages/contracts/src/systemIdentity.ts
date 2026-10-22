import * as Hash from "effect/Hash";
import * as Schema from "effect/Schema";

const Text = Schema.String.check(Schema.isNonEmpty()).check(
  Schema.makeFilter((value) => !/[\r\n\0]/.test(value)),
);
const Hostname = Schema.String.check(
  Schema.makeFilter((value) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)),
);

/** One configured machine image supplies the identity every execution tier presents. */
export const SystemIdentityConfig = Schema.Struct({
  release: Text,
  version: Text,
  machine: Schema.Literals(["x86_64", "aarch64"]),
  hostnamePolicy: Schema.Literal("thread"),
  verification: Schema.Literals(["provisional", "measured"]),
});
export type SystemIdentityConfig = typeof SystemIdentityConfig.Type;

export const SystemIdentity = Schema.Struct({
  ...SystemIdentityConfig.fields,
  hostname: Hostname,
  platform: Schema.Literal("linux"),
  type: Schema.Literal("Linux"),
  arch: Schema.Literals(["x64", "arm64"]),
  endianness: Schema.Literal("LE"),
});
export type SystemIdentity = typeof SystemIdentity.Type;

// These compatibility values are provisional until computer-boxd-proof measures the image.
// Keep that status explicit in host configuration; it is never part of guest OS output.
export const DEFAULT_SYSTEM_IDENTITY: SystemIdentityConfig = Object.freeze({
  release: "6.12.0",
  version: "#1 SMP",
  machine: "x86_64",
  hostnamePolicy: "thread",
  verification: "provisional",
});

export function systemHostname(threadId: string): string {
  if (!threadId) throw new TypeError("System identity requires a thread id");
  const name = threadId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (name === threadId && name.length <= 61 && /^[a-z0-9].*[a-z0-9]$/.test(name))
    return `t-${name}`;
  const suffix = (Hash.string(threadId) >>> 0).toString(16).padStart(8, "0");
  return `t-${name.slice(0, 50)}-${suffix}`;
}

const decodeSystemIdentity = Schema.decodeUnknownSync(SystemIdentity);

export function systemIdentityForThread(
  threadId: string,
  config: SystemIdentityConfig = DEFAULT_SYSTEM_IDENTITY,
): SystemIdentity {
  return Object.freeze(
    decodeSystemIdentity({
      ...config,
      hostname: systemHostname(threadId),
      platform: "linux",
      type: "Linux",
      arch: config.machine === "x86_64" ? "x64" : "arm64",
      endianness: "LE",
    }),
  );
}
