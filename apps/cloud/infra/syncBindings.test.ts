import * as Cloudflare from "alchemy/Cloudflare";
import { describe, expect, it } from "@effect/vitest";

import { toAlchemyBindings, type BindingManifestInput } from "./syncBindings.ts";

const manifest = (bindings: BindingManifestInput["bindings"]): BindingManifestInput => ({
  version: 1,
  unknown: [],
  bindings,
});

const classExports = { Counter: true } as const;

describe("toAlchemyBindings", () => {
  it("maps a declared SQLite class to the Alchemy v2 Worker binding marker", () => {
    const bindings = toAlchemyBindings(
      manifest([
        {
          type: "durable_object",
          binding: "COUNTERS",
          className: "Counter",
          sqlite: true,
        },
      ]),
      classExports,
    );

    expect(bindings).toEqual({
      COUNTERS: Cloudflare.DurableObject<unknown>("COUNTERS", { className: "Counter" }),
    });
  });

  it("rejects unsupported manifest revisions and unmodelled config", () => {
    expect(() => toAlchemyBindings({ ...manifest([]), version: 2 }, {})).toThrow(
      /Unsupported Lunora BindingManifest version 2/,
    );
    expect(() => toAlchemyBindings({ ...manifest([]), unknown: ["unsafe_bindings"] }, {})).toThrow(
      /unmodelled config: unsafe_bindings/,
    );
  });

  it("rejects manifest fields and configured resources this stack does not carry", () => {
    expect(() => toAlchemyBindings({ ...manifest([]), resourcePolicy: "unmodeled" }, {})).toThrow(
      /Unsupported Lunora BindingManifest fields: resourcePolicy/,
    );
    expect(() => toAlchemyBindings({ ...manifest([]), crons: ["*/5 * * * *"] }, {})).toThrow(
      /does not configure crons/,
    );
    expect(() =>
      toAlchemyBindings({ ...manifest([]), vars: [{ name: "PUBLIC_URL" }] }, {}),
    ).toThrow(/does not configure vars/);
  });

  it("rejects binding kinds and fields outside the supported manifest shape", () => {
    expect(() => toAlchemyBindings(manifest([{ type: "kv", binding: "CACHE" }]), {})).toThrow(
      /supports only durable_object bindings/,
    );
    expect(() =>
      toAlchemyBindings(
        manifest([
          {
            type: "durable_object",
            binding: "COUNTERS",
            className: "Counter",
            sqlite: true,
            resourceId: "anything",
          } as BindingManifestInput["bindings"][number],
        ]),
        classExports,
      ),
    ).toThrow(/Unsupported fields.*resourceId/);
  });

  it("requires an allowlisted class export and Alchemy-supported SQLite storage", () => {
    const requirement = {
      type: "durable_object",
      binding: "COUNTERS",
      className: "Counter",
      sqlite: true,
    } as const;
    expect(() => toAlchemyBindings(manifest([requirement]), {})).toThrow(
      /not present in the supplied Worker export allowlist/,
    );
    expect(() =>
      toAlchemyBindings(manifest([{ ...requirement, sqlite: false }]), classExports),
    ).toThrow(/has no legacy-storage binding option/);
  });

  it("checks own class markers without accepting inherited or false entries", () => {
    const requirement = {
      type: "durable_object",
      binding: "COUNTERS",
      className: "Counter",
      sqlite: true,
    } as const;
    const inherited = Object.create({ Counter: true }) as Record<string, true>;

    expect(() => toAlchemyBindings(manifest([requirement]), inherited)).toThrow(
      /not present in the supplied Worker export allowlist/,
    );
    expect(() =>
      toAlchemyBindings(manifest([requirement]), { Counter: false } as unknown as Record<
        string,
        true
      >),
    ).toThrow(/not present in the supplied Worker export allowlist/);
  });
});
