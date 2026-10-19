// @effect-diagnostics nodeBuiltinImport:off - isolated in-memory SQLite fixture, never live userdata.
import { describe, expect, it } from "vite-plus/test";
import { MIN_SCRUBBED_LENGTH, secretForms } from "@signalbox/runner-protocol/SecretScrubber";
import { sqliteFixture } from "./tests/sqliteFixture.ts";
import { createFacetSqliteStorage, FILE_CHUNK_BYTES } from "../kernel/FacetSqliteStorage.ts";
import type { Storage } from "../kernel/storage.ts";
import { createSecretFileByteView } from "./SecretFileBytes.ts";

const now = () => 1_800_000_000_000_000_001n;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const keyToken = "{{secret:API_KEY}}";
const vaultToken = "{{op://Production/API/password}}";
const longToken = "{{secret:LONG_KEY}}";
const shortToken = "{{secret:SHORT_KEY}}";
const keyValue = "short-七";
const longerValue = "a much longer credential 🔑";

interface FixtureOptions {
  readonly canonical?: string;
  readonly bindings?: ReadonlyArray<{ readonly placeholder: string; readonly value: string }>;
  readonly failWrite?: (call: number) => boolean;
  readonly syncError?: Error;
  readonly trackReads?: boolean;
}

const makeFixture = (options: FixtureOptions = {}) => {
  const database = sqliteFixture();
  const base = createFacetSqliteStorage(database.storage, now);
  let writeCall = 0;
  let maximumReadTarget = 0;
  const storage =
    options.failWrite === undefined && options.syncError === undefined && !options.trackReads
      ? base
      : {
          ...base,
          write(inode: bigint, offset: bigint, source: Uint8Array) {
            writeCall += 1;
            if (options.failWrite?.(writeCall))
              throw Object.assign(new Error("EIO"), { code: "EIO" });
            return base.write(inode, offset, source);
          },
          sync(inode: bigint, dataOnly: boolean) {
            if (options.syncError !== undefined) throw options.syncError;
            return base.sync(inode, dataOnly);
          },
          readInto(inode: bigint, offset: bigint, target: Uint8Array) {
            maximumReadTarget = Math.max(maximumReadTarget, target.byteLength);
            return base.readInto(inode, offset, target);
          },
        };
  const inode = storage.create(storage.root, "secret-file", {
    type: "file",
    exclusive: true,
  });
  const initial = encoder.encode(options.canonical ?? `key=${keyToken}; end`);
  storage.write(inode, 0n, initial);
  const bindings = options.bindings ?? [
    { placeholder: keyToken, value: keyValue },
    { placeholder: vaultToken, value: keyValue },
    { placeholder: longToken, value: longerValue },
    { placeholder: shortToken, value: "tiny--七" },
  ];
  const view = createSecretFileByteView({
    canonical: storage,
    transactions: {
      storage,
      run: (operation) => database.storage.transactionSync(() => operation(storage)),
    },
    bindings,
  });
  const access = view.bind(inode);
  const canonicalBytes = () => {
    const size = Number(storage.stat(inode).size);
    const bytes = new Uint8Array(size);
    expect(storage.readInto(inode, 0n, bytes)).toBe(size);
    return bytes;
  };
  const rawBytes = () => {
    const size = Number(access.stat().size);
    const bytes = new Uint8Array(size);
    expect(access.readInto(0n, bytes)).toBe(size);
    return bytes;
  };
  return {
    database,
    storage,
    inode,
    view,
    access,
    canonicalBytes,
    rawBytes,
    maximumReadTarget: () => maximumReadTarget,
    close: () => {
      access.release();
      database.close();
    },
  };
};

const codeError = (code: string) => expect.objectContaining({ code });

describe("SecretFileBytes", () => {
  it("fills UTF-8 values, keeps alias tokens and reports byte sizes", () => {
    const fixture = makeFixture({
      canonical: `key=${keyToken}; alias=${vaultToken}`,
    });
    try {
      const raw = fixture.rawBytes();
      expect(decoder.decode(raw)).toBe(`key=${keyValue}; alias=${keyValue}`);
      expect(fixture.access.stat().size).toBe(BigInt(raw.byteLength));
      expect(decoder.decode(fixture.canonicalBytes())).toBe(`key=${keyToken}; alias=${vaultToken}`);
      fixture.access.write(0n, encoder.encode("KEY="));
      expect(decoder.decode(fixture.canonicalBytes())).toBe(`KEY=${keyToken}; alias=${vaultToken}`);
      expect(keyValue.length).toBeGreaterThanOrEqual(MIN_SCRUBBED_LENGTH);
    } finally {
      fixture.close();
    }
  });

  it("fills values longer than 1 KiB while the prepared projection fits its byte budget", () => {
    const value = "x".repeat(1_100);
    const token = "{{secret:LONG_VALUE}}";
    const fixture = makeFixture({
      canonical: `key=${token}`,
      bindings: [{ placeholder: token, value }],
    });
    try {
      expect(decoder.decode(fixture.rawBytes())).toBe(`key=${value}`);
      expect(fixture.canonicalBytes()).toEqual(encoder.encode(`key=${token}`));
    } finally {
      fixture.close();
    }
  });

  it("uses the prepared-state byte budget instead of a separate 8 KiB value cap", () => {
    const bindings = Array.from({ length: 17 }, (_, index) => ({
      placeholder: `{{secret:LONG_SET_${index}}}`,
      value: `${"x".repeat(500)}${index.toString(36).padStart(2, "0")}`,
    }));
    const fixture = makeFixture({
      canonical: bindings.map(({ placeholder }) => placeholder).join("|"),
      bindings,
    });
    try {
      expect(decoder.decode(fixture.rawBytes())).toBe(bindings.map(({ value }) => value).join("|"));
    } finally {
      fixture.close();
    }
  });

  it("uses ranged reads for a clean file when prepared aliases approach the budget", () => {
    const bindings = Array.from({ length: 16 }, (_, index) => ({
      placeholder: `{{secret:${"A".repeat(190_000)}_${index}}}`,
      value: "shared7",
    }));
    const fixture = makeFixture({
      canonical: "x".repeat(1_048_576),
      bindings,
      trackReads: true,
    });
    try {
      expect(fixture.access.stat().size).toBe(1_048_576n);
      const target = new Uint8Array(16);
      expect(fixture.access.readInto(0n, target)).toBe(target.byteLength);
      expect(target).toEqual(new Uint8Array(target.byteLength).fill(0x78));
      expect(fixture.maximumReadTarget()).toBeLessThanOrEqual(64 * 1024);
    } finally {
      fixture.close();
    }
  });

  it("preflights scrubber expansion against the shared operation budget", () => {
    const storage = {} as Storage;
    expect(() =>
      createSecretFileByteView({
        canonical: storage,
        transactions: { storage, run: (operation) => operation(storage) },
        bindings: [{ placeholder: keyToken, value: "x".repeat(100_000) }],
      }),
    ).toThrow(codeError("ENOMEM"));
  });

  it("fills escaped Unicode values and refuses their shared scrubber forms before exceeding the budget", () => {
    const values = [
      "quotes ' \" slash \\ dollar $ tick ` newline\n tab\t and shell ;<>|",
      "üñíçødé 🔑 中文 and url /?&=+%",
      "control\u0000\u0001\u001f escaped-json \\",
    ];
    for (const value of values) {
      const fixture = makeFixture({
        canonical: keyToken,
        bindings: [{ placeholder: keyToken, value }],
      });
      try {
        expect(fixture.rawBytes()).toEqual(encoder.encode(value));
        fixture.access.write(0n, encoder.encode(value));
        expect(fixture.canonicalBytes()).toEqual(encoder.encode(keyToken));
      } finally {
        fixture.close();
      }

      const oversized = value.repeat(10_000);
      const forms = secretForms(oversized);
      const retainedBytes = forms.reduce(
        (size, form) => size + form.length * 2 + encoder.encode(form).byteLength,
        0,
      );
      expect(encoder.encode(oversized).byteLength).toBeLessThan(1_048_576);
      expect(retainedBytes).toBeGreaterThan(4_194_304);
      const storage = {} as Storage;
      expect(() =>
        createSecretFileByteView({
          canonical: storage,
          transactions: { storage, run: (operation) => operation(storage) },
          bindings: [{ placeholder: keyToken, value: oversized }],
        }),
      ).toThrow(codeError("ENOMEM"));
    }
  });

  it("projects more than 1,024 references and accepts tokens longer than 4 KiB", () => {
    const repeated = makeFixture({
      canonical: `${keyToken}|`.repeat(1_100),
    });
    try {
      expect(decoder.decode(repeated.rawBytes())).toBe(`${keyValue}|`.repeat(1_100));
    } finally {
      repeated.close();
    }

    const token = `{{secret:${"A".repeat(5_000)}}}`;
    const longToken = makeFixture({
      canonical: `value=${token}`,
      bindings: [{ placeholder: token, value: "long-token-value" }],
    });
    try {
      expect(decoder.decode(longToken.rawBytes())).toBe("value=long-token-value");
    } finally {
      longToken.close();
    }
  });

  it("rejects an unregistered 1 MiB token without decoding it into a full string", () => {
    const fixture = makeFixture({
      canonical: `{{secret:${"A".repeat(1_000_000)}}}`,
    });
    try {
      expect(() => fixture.access.stat()).toThrow(codeError("EINVAL"));
    } finally {
      fixture.close();
    }
  });

  it("preserves outer filled spans containing registered or unknown placeholder text", () => {
    const outerValue = `before {{secret:INNER}} after`;
    for (const includeInner of [false, true]) {
      const outerPlaceholder = "{{secret:OUTER}}";
      const bindings = [
        { placeholder: outerPlaceholder, value: outerValue },
        ...(includeInner ? [{ placeholder: "{{secret:INNER}}", value: "inner-secret" }] : []),
      ];
      const fixture = makeFixture({
        canonical: `prefix=${outerPlaceholder}`,
        bindings,
      });
      try {
        fixture.access.append(encoder.encode("!"));
        expect(decoder.decode(fixture.rawBytes())).toBe(`prefix=${outerValue}!`);
        expect(decoder.decode(fixture.canonicalBytes())).toBe(`prefix=${outerPlaceholder}!`);
      } finally {
        fixture.close();
      }
    }
  });

  it.each(["append", "prefix write"])(
    "preserves an untouched span when a longer secret overlaps its %s boundary",
    (operation) => {
      const token = "{{secret:A}}";
      const value = "abcdefg";
      const prefix = operation === "prefix write" ? "p" : "";
      const fixture = makeFixture({
        canonical: `${prefix}${token}`,
        bindings: [
          { placeholder: token, value },
          { placeholder: "{{secret:B}}", value: `${value}!` },
          { placeholder: "{{secret:C}}", value: `!${value}` },
        ],
      });
      try {
        if (operation === "append") fixture.access.append(encoder.encode("!"));
        else fixture.access.write(0n, encoder.encode("!"));
        expect(decoder.decode(fixture.canonicalBytes())).toBe(
          operation === "append" ? `${token}!` : `!${token}`,
        );
        expect(decoder.decode(fixture.rawBytes())).toBe(
          operation === "append" ? `${value}!` : `!${value}`,
        );
      } finally {
        fixture.close();
      }
    },
  );

  it("refuses an escape-expanded match that reaches into an untouched span", () => {
    const token = "{{secret:BACKSLASH}}";
    const value = "abcdef\\";
    const nextValue = "hijklmn";
    const fixture = makeFixture({
      canonical: token,
      bindings: [
        { placeholder: token, value },
        { placeholder: "{{secret:NEXT}}", value: nextValue },
      ],
    });
    try {
      const before = fixture.canonicalBytes();
      expect(() => fixture.access.append(encoder.encode(nextValue))).toThrow(codeError("ENOTSUP"));
      expect(fixture.canonicalBytes()).toEqual(before);
      expect(decoder.decode(fixture.rawBytes())).toBe(value);
      expect(fixture.access.stat().size).toBe(BigInt(encoder.encode(value).byteLength));
    } finally {
      fixture.close();
    }
  });

  it("allows clean files to grow past the projection limit through ranged storage", () => {
    const fixture = makeFixture({ canonical: "", bindings: [] });
    try {
      fixture.access.truncate(1_048_577n);
      expect(fixture.access.stat().size).toBe(1_048_577n);
      const tail = new Uint8Array(2);
      expect(fixture.access.readInto(1_048_575n, tail)).toBe(2);
      expect(tail).toEqual(new Uint8Array(2));
    } finally {
      fixture.close();
    }
  });

  it("rejects malformed UTF-16 secret values with EINVAL", () => {
    const storage = {} as Storage;
    expect(() =>
      createSecretFileByteView({
        canonical: storage,
        transactions: { storage, run: (operation) => operation(storage) },
        bindings: [{ placeholder: keyToken, value: "invalid-\ud800" }],
      }),
    ).toThrow(codeError("EINVAL"));
  });

  it("prepares more than 512 bindings when their matcher state fits the operation budget", () => {
    const bindings = Array.from({ length: 520 }, (_, index) => {
      const name = `SHARED_${index}`;
      const placeholder = `{{secret:${name}}}`;
      const value = `shared-secret-${index.toString().padStart(4, "0")}`;
      return { placeholder, value };
    });
    const first = bindings[0]!;
    const fixture = makeFixture({ canonical: first.placeholder, bindings });
    try {
      expect(decoder.decode(fixture.rawBytes())).toBe(first.value);
    } finally {
      fixture.close();
    }
  });

  it("refuses a projection whose reference bookkeeping exceeds 4 MiB before mutating canonical bytes", () => {
    const fixture = makeFixture({ canonical: `${keyToken}|`.repeat(36_000) });
    try {
      const before = fixture.canonicalBytes();
      expect(() => fixture.access.write(0n, encoder.encode("mutation"))).toThrow(
        codeError("ENOMEM"),
      );
      expect(fixture.canonicalBytes()).toEqual(before);
    } finally {
      fixture.close();
    }
  });

  it("preserves untouched spans when a longer replacement, outside edit and append commit", () => {
    const fixture = makeFixture({ canonical: `prefix--${keyToken}; tail` });
    try {
      fixture.access.write(0n, encoder.encode("changed="));
      const start = BigInt(encoder.encode("changed=").byteLength);
      fixture.access.write(start, encoder.encode(`${longerValue}; tail`));
      expect(decoder.decode(fixture.rawBytes())).toBe(`changed=${longerValue}; tail`);
      expect(decoder.decode(fixture.canonicalBytes())).toBe(`changed=${longToken}; tail`);

      const beforeAppend = fixture.access.stat().size;
      expect(fixture.access.append(encoder.encode("!"))).toEqual({
        offset: beforeAppend,
        bytesWritten: 1,
      });
      expect(decoder.decode(fixture.rawBytes())).toBe(`changed=${longerValue}; tail!`);
    } finally {
      fixture.close();
    }
  });

  it("tracks a multibyte filled span across the 64 KiB storage boundary", () => {
    const prefix = "x".repeat(FILE_CHUNK_BYTES - 2);
    const fixture = makeFixture({ canonical: `${prefix}${keyToken}` });
    try {
      const raw = new Uint8Array(12);
      expect(fixture.access.readInto(BigInt(FILE_CHUNK_BYTES - 2), raw)).toBe(
        encoder.encode(keyValue).byteLength,
      );
      expect(decoder.decode(raw.subarray(0, encoder.encode(keyValue).byteLength))).toBe(keyValue);
    } finally {
      fixture.close();
    }
  });

  it("accepts a whole-span replacement with a shorter UTF-8 value", () => {
    const fixture = makeFixture({ canonical: `prefix=${longToken}` });
    try {
      const start = BigInt(encoder.encode("prefix=").byteLength);
      const shortValue = encoder.encode("tiny--七");
      const replacement = new Uint8Array(encoder.encode(longerValue).byteLength);
      replacement.set(shortValue);
      fixture.access.write(start, replacement);
      fixture.access.truncate(start + BigInt(shortValue.byteLength));
      expect(decoder.decode(fixture.rawBytes())).toBe("prefix=tiny--七");
      expect(decoder.decode(fixture.canonicalBytes())).toBe(`prefix=${shortToken}`);
    } finally {
      fixture.close();
    }
  });

  it("refuses prefix, suffix, middle and interior-truncate edits without changing canonical state", () => {
    const fixture = makeFixture({ canonical: `prefix=${keyToken}; tail` });
    try {
      const bytes = fixture.rawBytes();
      const prefixLength = encoder.encode("prefix=").byteLength;
      const spanLength = encoder.encode(keyValue).byteLength;
      const start = BigInt(prefixLength);
      const end = start + BigInt(spanLength);
      const original = fixture.canonicalBytes();
      const originalSize = fixture.storage.stat(fixture.inode).size;
      for (const [offset, patch] of [
        [start, new Uint8Array([0x58])],
        [end - 1n, new Uint8Array([0x58])],
        [start + 2n, new Uint8Array([0x58])],
      ] as const) {
        expect(() => fixture.access.write(offset, patch)).toThrow(codeError("ENOTSUP"));
        expect(fixture.canonicalBytes()).toEqual(original);
        expect(fixture.storage.stat(fixture.inode).size).toBe(originalSize);
        expect(fixture.rawBytes()).toEqual(bytes);
      }
      expect(() => fixture.access.truncate(start + 1n)).toThrow(codeError("ENOTSUP"));
      expect(fixture.canonicalBytes()).toEqual(original);
      expect(fixture.storage.stat(fixture.inode).size).toBe(originalSize);
    } finally {
      fixture.close();
    }
  });

  it("allows full-span removal and truncation at both span endpoints", () => {
    const preserve = makeFixture({ canonical: `prefix=${keyToken}; tail` });
    try {
      const start = BigInt(encoder.encode("prefix=").byteLength);
      const end = start + BigInt(encoder.encode(keyValue).byteLength);
      preserve.access.truncate(end);
      expect(decoder.decode(preserve.canonicalBytes())).toBe(`prefix=${keyToken}`);
      preserve.access.truncate(start);
      expect(decoder.decode(preserve.canonicalBytes())).toBe("prefix=");
    } finally {
      preserve.close();
    }

    const remove = makeFixture({ canonical: `prefix=${keyToken}; tail` });
    try {
      const start = BigInt(encoder.encode("prefix=").byteLength);
      const end = start + BigInt(encoder.encode(keyValue).byteLength);
      remove.access.write(start, new Uint8Array(Number(end - start)));
      expect(decoder.decode(remove.canonicalBytes())).toBe(
        `prefix=${"\0".repeat(Number(end - start))}; tail`,
      );
      expect(decoder.decode(remove.rawBytes())).toContain("\0");
    } finally {
      remove.close();
    }
  });

  it("scrubs a secret completed across an append boundary and keeps the canonical token", () => {
    const value = "boundary-secret";
    const token = "{{secret:BOUNDARY}}";
    const prefix = value.slice(0, 8);
    const suffix = value.slice(8);
    const fixture = makeFixture({
      canonical: prefix,
      bindings: [{ placeholder: token, value }],
    });
    try {
      expect(fixture.access.append(encoder.encode(suffix))).toEqual({
        offset: BigInt(encoder.encode(prefix).byteLength),
        bytesWritten: encoder.encode(suffix).byteLength,
      });
      expect(decoder.decode(fixture.canonicalBytes())).toBe(token);
      expect(decoder.decode(fixture.rawBytes())).toBe(value);
    } finally {
      fixture.close();
    }
  });

  it("checks large clean files after mutation and refuses a boundary-created secret before publish", () => {
    const secret = "large-boundary-secret";
    const token = "{{secret:LARGE_BOUNDARY}}";
    const prefix = "x".repeat(1_048_576) + secret.slice(0, 12);
    const fixture = makeFixture({
      canonical: prefix,
      bindings: [{ placeholder: token, value: secret }],
    });
    try {
      const original = fixture.canonicalBytes();
      expect(() => fixture.access.append(encoder.encode(secret.slice(12)))).toThrow(
        codeError("ENOMEM"),
      );
      expect(fixture.canonicalBytes()).toEqual(original);
    } finally {
      fixture.close();
    }
  });

  it("reads current direct canonical writes and preserves successful bytes after sync failure", () => {
    const fixture = makeFixture({ canonical: `first=${keyToken}` });
    try {
      fixture.storage.write(fixture.inode, 0n, encoder.encode(`other=${keyToken}`));
      expect(decoder.decode(fixture.rawBytes())).toBe(`other=${keyValue}`);
    } finally {
      fixture.close();
    }

    const syncFailure = Object.assign(new Error("sync failed"), { code: "EIO" });
    const withSyncFailure = makeFixture({ syncError: syncFailure, canonical: `first=${keyToken}` });
    try {
      withSyncFailure.access.write(0n, encoder.encode("later="));
      expect(() => withSyncFailure.access.sync(false)).toThrow(syncFailure);
      expect(decoder.decode(withSyncFailure.canonicalBytes())).toBe(`later=${keyToken}`);
    } finally {
      withSyncFailure.close();
    }
  });

  it("rolls back canonical bytes when publication fails after its truncate", () => {
    const fixture = makeFixture({
      canonical: `first=${keyToken}`,
      failWrite: (call) => call === 2,
    });
    try {
      const before = fixture.canonicalBytes();
      expect(() => fixture.access.write(0n, encoder.encode("later="))).toThrow(codeError("EIO"));
      expect(fixture.canonicalBytes()).toEqual(before);
      expect(decoder.decode(fixture.rawBytes())).toBe(`first=${keyValue}`);
    } finally {
      fixture.close();
    }
  });

  it("rejects unknown and malformed references before exposing file bytes", () => {
    for (const canonical of ["{{secret:MISSING}}", "{{secret:BAD", "{{op://bad"] as const) {
      const fixture = makeFixture({ canonical });
      try {
        expect(() => fixture.access.stat()).toThrow(codeError("EINVAL"));
      } finally {
        fixture.close();
      }
    }
  });
});
