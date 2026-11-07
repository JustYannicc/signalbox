import { ABI_VERSION } from "../kernel/KernelAbi.ts";

export const CODE_MODE_HOST_EXECUTABLE = "/bin/codex-code-mode-host";
export const CODE_MODE_UPSTREAM_COMMIT = "092d3acd6bec3e3a14bdc7e7a2810ab628ab759d";
export const CODE_MODE_HOST_MANIFEST = Object.freeze({
  name: "@signalbox/codex-code-mode-host",
  version: "0.162.1-workerd-port.1",
  abiVersion: ABI_VERSION,
  requiredCapabilities: Object.freeze([]),
  entrypoint: `codex-code-mode-v1:${CODE_MODE_UPSTREAM_COMMIT}`,
});
