// @effect-diagnostics nodeBuiltinImport:off - reads the Dockerfile beside it.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import packageJson from "../../../../package.json" with { type: "json" };
import { previewBrowserRelease } from "../../../preview/PreviewBrowser.ts";

/**
 * The Runner image's browser (#402) is the one the server's browser pins, so
 * bumping that pin moves both. The image can't import it, so this keeps the
 * Dockerfile's copy honest.
 */

const dockerfile = NodeFS.readFileSync(NodePath.join(import.meta.dirname, "Dockerfile"), "utf8");
const arg = (name: string) => new RegExp(`^ARG ${name}=(\\S+)$`, "m").exec(dockerfile)?.[1];

describe("Runner image pins", () => {
  it("fetches the headless shell PreviewBrowser pins, by its checksums", () => {
    for (const arch of ["x64", "arm64"] as const) {
      const release = previewBrowserRelease("linux", arch)!;
      expect(arg("CHROME_HEADLESS_SHELL_VERSION")).toBe(release.version);
      expect(dockerfile).toContain(
        `ADD --checksum=sha256:${release.sha256} \\\n  ${release.url.replace(release.version, "${CHROME_HEADLESS_SHELL_VERSION}")} /chrome.zip`,
      );
    }
  });

  it("installs the Playwright the server pins", () => {
    expect(arg("PLAYWRIGHT_CORE_VERSION")).toBe(packageJson.dependencies["playwright-core"]);
  });

  it("installs the oxc the automation compiler pins", () => {
    expect(arg("OXC_VERSION")).toBe(packageJson.dependencies["oxc-parser"]);
    expect(arg("OXC_VERSION")).toBe(packageJson.dependencies["oxc-transform"]);
  });
});
