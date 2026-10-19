import {
  makeSecretScrubber,
  type SecretValue,
  secretPlaceholder,
} from "@signalbox/runner-protocol/SecretScrubber";
import { describe, expect, it } from "@effect/vitest";

import {
  createHookSecretBoundary,
  HookSecretBoundaryError,
  type HookSecretBoundaryOptions,
} from "./HookSecrets.ts";

const signal = () => new AbortController().signal;
let fakeId = 0;
const fake = (label: string) => `${label}-fake-secret-${++fakeId}`;
const vaultRef = "{{op://Production/API/password}}";

interface HarnessOptions {
  readonly named?: ReadonlyArray<SecretValue>;
  readonly vault?: ReadonlyArray<readonly [string, SecretValue]>;
  readonly assertCurrent?: HookSecretBoundaryOptions["assertCurrent"];
  readonly fillVault?: HookSecretBoundaryOptions["fillVault"];
  readonly registerFailure?: string;
  readonly scrub?: HookSecretBoundaryOptions["scrub"];
}

const makeBoundary = (options: HarnessOptions = {}) => {
  const registry: Array<SecretValue> = [];
  const available = new Map((options.named ?? []).map((secret) => [secret.name, secret]));
  const vault = new Map(options.vault ?? []);
  const events: {
    readonly order: Array<string>;
    readonly resolved: Array<string>;
    readonly vaultInputs: Array<string>;
    readonly registered: Array<SecretValue>;
  } = { order: [], resolved: [], vaultInputs: [], registered: [] };
  let ready = false;

  const ports: HookSecretBoundaryOptions = {
    assertCurrent: options.assertCurrent ?? (() => undefined),
    resolveNamedSecret: async (name) => {
      events.resolved.push(name);
      const secret = available.get(name);
      if (secret === undefined) throw new Error(`private resolver detail: ${fake("raw-error")}`);
      return secret;
    },
    fillVault: async (text, signal) => {
      events.vaultInputs.push(text);
      if (options.fillVault !== undefined) return options.fillVault(text, signal);
      const secret = vault.get(text);
      if (secret === undefined) throw new Error(`private vault detail: ${fake("raw-error")}`);
      return { text: secret.value, secrets: [secret] };
    },
    register: async (secrets) => {
      events.order.push("register");
      if (options.registerFailure !== undefined) throw new Error(options.registerFailure);
      registry.push(...secrets);
      events.registered.push(...secrets);
      ready = true;
    },
    scrub: (text, signal) => {
      events.order.push("scrub");
      if (!ready) throw new Error("registered values are not ready");
      return options.scrub?.(text, signal) ?? makeSecretScrubber(registry).text(text);
    },
  };

  return { boundary: createHookSecretBoundary(ports), events, registry };
};

const caught = async (operation: () => Promise<unknown>) => {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the hook secret boundary to fail.");
};

describe("HookSecrets", () => {
  it("fills a write only inside its operation and scrubs the result", async () => {
    const key = { name: "API_KEY", value: fake("api") };
    const password = { name: "DATABASE_PASSWORD", value: fake("db") };
    const { boundary, events } = makeBoundary({
      named: [key],
      vault: [[vaultRef, password]],
    });
    const input = `key={{secret:API_KEY}} password=${vaultRef}`;
    let written = "";

    const output = await boundary.useWrite(
      input,
      async (filled) => {
        events.order.push("operation");
        written = filled;
        return `wrote ${filled}`;
      },
      signal(),
    );

    expect(input).toBe(`key={{secret:API_KEY}} password=${vaultRef}`);
    expect(written).toBe(`key=${key.value} password=${password.value}`);
    expect(events.vaultInputs).toEqual([vaultRef]);
    expect(events.registered).toEqual([key, password]);
    expect(events.order).toEqual(["register", "operation", "scrub"]);
    expect(output).toBe(
      `wrote key=${secretPlaceholder(key.name)} password=${secretPlaceholder(password.name)}`,
    );
    expect(output).not.toContain(key.value);
    expect(output).not.toContain(password.value);
  });

  it("fills command environment values and returns only scrubbed command output", async () => {
    const key = { name: "SERVICE_TOKEN", value: fake("token") };
    const { boundary, events } = makeBoundary({ named: [key] });
    let commandEnvironment: Readonly<Record<string, string>> | undefined;

    const output = await boundary.useEnvironment(
      { API_TOKEN: `{{secret:${key.name}}}`, PORT: "3000", HTTPS_PROXY: "http://127.0.0.1:8080" },
      async (environment) => {
        events.order.push("operation");
        commandEnvironment = environment;
        return `API_TOKEN=${environment.API_TOKEN}`;
      },
      signal(),
    );

    expect(commandEnvironment).toEqual({
      API_TOKEN: key.value,
      PORT: "3000",
      HTTPS_PROXY: "http://127.0.0.1:8080",
    });
    expect(events.order).toEqual(["register", "operation", "scrub"]);
    expect(output).toBe(`API_TOKEN=${secretPlaceholder(key.name)}`);
    expect(output).not.toContain(key.value);
  });

  it("registers an empty set before using an operation", async () => {
    const { boundary, events } = makeBoundary();

    const output = await boundary.useEnvironment(
      {},
      async (environment) => {
        expect(environment).toEqual({});
        events.order.push("operation");
        return "done";
      },
      signal(),
    );

    expect(events.registered).toEqual([]);
    expect(events.order).toEqual(["register", "operation", "scrub"]);
    expect(output).toBe("done");
  });

  it("rejects routing secret names before lookup or fill", async () => {
    const { boundary, events } = makeBoundary();
    const denied = [
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CODEX_HOME",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "T3CODE_TOKEN",
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
      "NODE_OPTIONS",
      "BUN_OPTIONS",
      "OPENAI_BASE_URL",
      "HTTPS_PROXY",
      "https_proxy",
    ];

    for (const name of denied) {
      const error = await caught(() =>
        boundary.useWrite(`{{secret:${name}}}`, async () => "unused", signal()),
      );
      expect(error).toBeInstanceOf(HookSecretBoundaryError);
      expect((error as HookSecretBoundaryError).reason).toBe("invalid");
    }

    expect(events.resolved).toEqual([]);
    expect(events.vaultInputs).toEqual([]);
    expect(events.registered).toEqual([]);
  });

  it("rejects invalid environment names before filling values", async () => {
    const { boundary, events } = makeBoundary();

    for (const name of ["bad-name", "", "9INVALID"]) {
      const error = await caught(() =>
        boundary.useEnvironment({ [name]: "{{secret:API_KEY}}" }, async () => "unused", signal()),
      );
      expect(error).toBeInstanceOf(HookSecretBoundaryError);
      expect((error as HookSecretBoundaryError).reason).toBe("invalid");
    }

    expect(events.resolved).toEqual([]);
    expect(events.registered).toEqual([]);
  });

  it("rejects forbidden names returned by Connections before registration", async () => {
    const routingSecret = { name: "CLAUDE_CODE_OAUTH_TOKEN", value: fake("oauth") };
    const { boundary, events } = makeBoundary({ vault: [[vaultRef, routingSecret]] });
    const error = await caught(() => boundary.useWrite(vaultRef, async () => "unused", signal()));

    expect(error).toBeInstanceOf(HookSecretBoundaryError);
    expect((error as HookSecretBoundaryError).reason).toBe("invalid");
    expect(events.registered).toEqual([]);
    expect(events.order).toEqual([]);
  });

  it("refuses a vault fill that does not return values to register", async () => {
    const { boundary, events } = makeBoundary({
      fillVault: async () => ({ text: fake("unregistered-vault-value"), secrets: [] }),
    });
    const error = await caught(() => boundary.useWrite(vaultRef, async () => "unused", signal()));

    expect(error).toBeInstanceOf(HookSecretBoundaryError);
    expect((error as HookSecretBoundaryError).reason).toBe("fill");
    expect(events.registered).toEqual([]);
    expect(events.order).toEqual([]);
  });

  it("hides resolver errors and stops before registration", async () => {
    const { boundary, events } = makeBoundary();
    const error = await caught(() =>
      boundary.useWrite("{{secret:MISSING_KEY}}", async () => "unused", signal()),
    );

    expect(error).toBeInstanceOf(HookSecretBoundaryError);
    expect((error as HookSecretBoundaryError).reason).toBe("resolve");
    expect((error as Error).message).toBe("Hook secret boundary failed.");
    expect(events.registered).toEqual([]);
    expect(events.order).toEqual([]);
  });

  it("hides vault errors and stops before registration", async () => {
    const { boundary, events } = makeBoundary();
    const error = await caught(() => boundary.useWrite(vaultRef, async () => "unused", signal()));

    expect(error).toBeInstanceOf(HookSecretBoundaryError);
    expect((error as HookSecretBoundaryError).reason).toBe("fill");
    expect((error as Error).message).toBe("Hook secret boundary failed.");
    expect(events.vaultInputs).toEqual([vaultRef]);
    expect(events.registered).toEqual([]);
    expect(events.order).toEqual([]);
  });

  it("hides registration errors and never runs after registration fails", async () => {
    const value = fake("registration-secret");
    const secret = { name: "API_KEY", value };
    const details = fake("raw-error-detail");
    const { boundary, events } = makeBoundary({ named: [secret], registerFailure: details });
    const error = await caught(() =>
      boundary.useWrite(
        `{{secret:${secret.name}}}`,
        async () => {
          events.order.push("operation");
          return "unused";
        },
        signal(),
      ),
    );

    expect(error).toBeInstanceOf(HookSecretBoundaryError);
    expect((error as Error).message).toBe("Hook secret boundary failed.");
    expect((error as Error).message).not.toContain(details);
    expect(events.order).toEqual(["register"]);
  });

  it("stops when the host attempt becomes stale before registration", async () => {
    const secret = { name: "API_KEY", value: fake("api") };
    let checks = 0;
    const { boundary, events } = makeBoundary({
      named: [secret],
      assertCurrent: () => {
        checks += 1;
        if (checks === 3) throw new Error(fake("private-host-detail"));
      },
    });
    const error = await caught(() =>
      boundary.useWrite(`{{secret:${secret.name}}}`, async () => "unused", signal()),
    );

    expect(error).toBeInstanceOf(HookSecretBoundaryError);
    expect((error as HookSecretBoundaryError).reason).toBe("stale");
    expect(events.registered).toEqual([]);
    expect(events.order).toEqual([]);
  });

  it("rechecks the host after registration and before using the secret", async () => {
    const secret = { name: "API_KEY", value: fake("api") };
    let checks = 0;
    const { boundary, events } = makeBoundary({
      named: [secret],
      assertCurrent: () => {
        checks += 1;
        if (checks === 5) throw new Error(fake("private-host-detail"));
      },
    });
    const error = await caught(() =>
      boundary.useWrite(`{{secret:${secret.name}}}`, async () => "unused", signal()),
    );

    expect(error).toBeInstanceOf(HookSecretBoundaryError);
    expect((error as HookSecretBoundaryError).reason).toBe("stale");
    expect(events.registered).toEqual([secret]);
    expect(events.order).toEqual(["register"]);
  });

  it("stops on cancellation before registration and after the operation callback", async () => {
    const secret = { name: "API_KEY", value: fake("api") };
    const early = makeBoundary({ named: [secret] });
    const abortedBeforeUse = new AbortController();
    abortedBeforeUse.abort(new Error(fake("private-abort-detail")));
    const earlyError = await caught(() =>
      early.boundary.useWrite(
        `{{secret:${secret.name}}}`,
        async () => "unused",
        abortedBeforeUse.signal,
      ),
    );

    expect(earlyError).toBeInstanceOf(HookSecretBoundaryError);
    expect((earlyError as HookSecretBoundaryError).reason).toBe("cancelled");
    expect(early.events.resolved).toEqual([]);
    expect(early.events.order).toEqual([]);

    const late = makeBoundary({ named: [secret] });
    const abortedDuringUse = new AbortController();
    const lateError = await caught(() =>
      late.boundary.useWrite(
        `{{secret:${secret.name}}}`,
        async () => {
          late.events.order.push("operation");
          abortedDuringUse.abort(new Error(fake("private-abort-detail")));
          return secret.value;
        },
        abortedDuringUse.signal,
      ),
    );

    expect(lateError).toBeInstanceOf(HookSecretBoundaryError);
    expect((lateError as HookSecretBoundaryError).reason).toBe("cancelled");
    expect(late.events.order).toEqual(["register", "operation"]);
  });

  it("fails closed for values the shared scrubber cannot mask", async () => {
    const short = { name: "PIN", value: "12345" };
    const { boundary, events } = makeBoundary({ named: [short] });
    const error = await caught(() =>
      boundary.useWrite(`{{secret:${short.name}}}`, async () => "unused", signal()),
    );

    expect(error).toBeInstanceOf(HookSecretBoundaryError);
    expect((error as HookSecretBoundaryError).reason).toBe("invalid");
    expect(events.registered).toEqual([]);
    expect(events.order).toEqual([]);
  });

  it("does not return output if the registered-value scrubber leaves a raw value", async () => {
    const secret = { name: "API_KEY", value: fake("api") };
    const { boundary } = makeBoundary({
      named: [secret],
      scrub: (text) => text,
    });
    const error = await caught(() =>
      boundary.useWrite(
        `{{secret:${secret.name}}}`,
        async () => `output ${secret.value}`,
        signal(),
      ),
    );

    expect(error).toBeInstanceOf(HookSecretBoundaryError);
    expect((error as HookSecretBoundaryError).reason).toBe("scrub");
    expect((error as Error).message).not.toContain(secret.value);
  });
});
