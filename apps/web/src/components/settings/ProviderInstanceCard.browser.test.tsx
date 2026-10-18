import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { providerClients } from "./providerDriverMeta";

// signalbox: rendered without a browser, so environment UI reads as shown.
vi.mock(import("../../state/environmentCapabilities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useShowsEnvironmentUi: () => true,
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const driver = ProviderDriverKind.make("codex");

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-27T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

async function renderCard(
  liveProvider: ServerProvider,
  mode: ComponentProps<typeof ProviderInstanceCard>["mode"],
) {
  await act(async () =>
    root.render(
      <ProviderInstanceCard
        instanceId={liveProvider.instanceId}
        instance={{ driver }}
        driverOption={undefined}
        liveProvider={liveProvider}
        mode={mode}
        onUpdate={() => undefined}
        hiddenModels={[]}
        favoriteModels={[]}
        modelOrder={[]}
        onHiddenModelsChange={() => undefined}
        onFavoriteModelsChange={() => undefined}
        onToggleFavorite={() => undefined}
        onModelOrderChange={() => undefined}
      />,
    ),
  );
}

describe("ProviderInstanceCard", () => {
  it("hides the account email until the user reveals it, and hides it again", async () => {
    await renderCard(
      provider({ auth: { status: "authenticated", email: "developer@example.com" } }),
      "editor",
    );
    expect(container.textContent).toContain("Authenticated as");
    expect(container.textContent).not.toContain("developer@example.com");

    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle account email visibility"]',
    )!;
    await userEvent.click(toggle);
    expect(toggle.textContent).toBe("developer@example.com");

    await userEvent.click(toggle);
    expect(container.textContent).not.toContain("developer@example.com");
  });

  it.each(["list", "editor"] as const)(
    "surfaces a failed probe message in the %s",
    async (mode) => {
      await renderCard(
        provider({
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message:
            "Codex app-server provider probe failed: Cannot create Codex shadow home entry 'auth.json' because '/home/me/.codex-t3/work/auth.json' already exists and is not a symlink.",
        }),
        mode,
      );
      expect(container.textContent).toContain("Unavailable");
      expect(container.textContent).toContain("is not a symlink");
    },
  );

  // signalbox: a Cloud pool shows its models without the host's runtime configuration.
  it("keeps Cloud pool models visible without exposing host configuration", async () => {
    const instanceId = ProviderInstanceId.make("codex_hub");
    const onHiddenModelsChange = vi.fn();
    const onToggleFavorite = vi.fn();
    await act(async () =>
      root.render(
        <ProviderInstanceCard
          instanceId={instanceId}
          instance={{
            driver,
            config: { binaryPath: "/host/bin/codex", configDirectory: "/host/.codex" },
            environment: [{ name: "HOST_ONLY_KEY", value: "host-secret", sensitive: true }],
          }}
          driverOption={providerClients.get(driver)}
          liveProvider={provider({
            instanceId,
            version: null,
            models: [
              { slug: "pool-model", name: "Pool model", isCustom: false, capabilities: null },
            ],
          })}
          mode="editor"
          supportsServerSettingsWrite={false}
          onUpdate={() => undefined}
          hiddenModels={[]}
          favoriteModels={[]}
          modelOrder={[]}
          onHiddenModelsChange={onHiddenModelsChange}
          onFavoriteModelsChange={() => undefined}
          onToggleFavorite={onToggleFavorite}
          onModelOrderChange={() => undefined}
        />,
      ),
    );

    expect(container.querySelector('[data-model-slug="pool-model"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Runtime");
    expect(container.textContent).not.toContain("Variables");
    expect(container.querySelector('input[value="/host/bin/codex"]')).toBeNull();
    const picker = container.querySelector<HTMLElement>(
      '[aria-label="Show Pool model in the model picker"]',
    );
    const favorite = container.querySelector<HTMLButtonElement>(
      '[aria-label="Add Pool model to favorites"]',
    );
    expect(picker).not.toBeNull();
    expect(favorite?.disabled).toBe(true);
    await act(async () => {
      picker?.click();
      favorite?.click();
    });
    expect(onHiddenModelsChange).not.toHaveBeenCalled();
    expect(onToggleFavorite).not.toHaveBeenCalled();
  });
});
