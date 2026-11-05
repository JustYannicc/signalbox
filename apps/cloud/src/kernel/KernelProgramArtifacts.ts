import { ABI_VERSION } from "./KernelAbi.ts";

/** Computer can identify pinned programs without importing kernel execution or filesystem code. */
export const KERNEL_GIT_ARTIFACT = Object.freeze({
  repository: "https://github.com/AshishKumar4/Nimbus",
  revision: "e9f019ab4e40cb6037aff7e1a0eaf20842578ed3",
  path: "packages/worker/wasm/git/git.wasm",
  version: "2.53.0+nimbus.e9f019ab.startup-cwd.1",
  patchSha256: "0ced54937ce31b98038c9368ef91d568a61d91adc0d1e794b11203f1ce84bd35",
  sha256: "87c054c0a772fce3a236f5721f486707461d98144af8a9ff9a1424e40b9b9f36",
  bytes: 3_678_759,
  gitVersion: "2.53.0",
  license: "GPL-2.0-only",
});

export const KERNEL_GIT_PROGRAM_MANIFEST = Object.freeze({
  name: "git",
  version: KERNEL_GIT_ARTIFACT.version,
  abiVersion: ABI_VERSION,
  requiredCapabilities: Object.freeze(["process.spawn", "process.wait", "process.signal"] as const),
  entrypoint: "git-nimbus-2.53.0",
});

export const KERNEL_RIPGREP_ARTIFACT = Object.freeze({
  path: "bin/rg.wasm",
  bytes: 2_208_556,
  sha256: "791b862a433f1a5a9b6a7ce982546d33f4146dcb019dba5da1e78be7bffc7ca7",
  version: "15.1.0",
});

export const KERNEL_RIPGREP_PROGRAM_MANIFEST = Object.freeze({
  name: "ripgrep",
  version: KERNEL_RIPGREP_ARTIFACT.version,
  abiVersion: ABI_VERSION,
  requiredCapabilities: Object.freeze([]),
  entrypoint: "ripgrep-15.1.0",
});

export const KERNEL_BASH_ARTIFACT = Object.freeze({
  repository: "https://github.com/AshishKumar4/Nimbus",
  revision: "e9f019ab4e40cb6037aff7e1a0eaf20842578ed3",
  path: "build/bash.async.wasm",
  version: "5.2.37+nimbus.e9f019ab.fd-flags.2",
  patchSha256: "5df897065b403d5a545431edcf7b17453d1c391206b317898013436931acbfb1",
  sha256: "c3e8dc79b9660a21ed1873f8c900a0c1f195d274c183706cf5f68ff9e5fb9e00",
  bytes: 3_890_330,
});

export const KERNEL_BUSYBOX_ARTIFACT = Object.freeze({
  repository: "https://github.com/AshishKumar4/Nimbus",
  revision: "e9f019ab4e40cb6037aff7e1a0eaf20842578ed3",
  path: "bin/busybox.wasm",
  version: "1.37.0+nimbus.e9f019ab.io-buffer.1",
  buildRecipe: "infra/kernelPrograms/coreutils/build-busybox-buffered.sh",
  sha256: "6aefd645a67065f611b6cbdf78a5899def4404e01917375164a02426750d47ba",
  bytes: 295_812,
});

export const PRODUCT_COMPUTER_BUSYBOX_ARTIFACT = Object.freeze({
  repository: "https://github.com/AshishKumar4/Nimbus",
  revision: "e9f019ab4e40cb6037aff7e1a0eaf20842578ed3",
  path: "product-busybox.wasm",
  version: "1.37.0+nimbus.e9f019ab.io-buffer.1.id.1",
  buildRecipe: "infra/kernelPrograms/coreutils/build-busybox-buffered.sh",
  sourceBuildRecipe: "packages/worker/wasm/bash/coreutils/build-busybox.sh",
  sourceBuildRecipeSha256: "277f73c60d488d4441417cee01519f3d4c0cbd6cf324beb47d1f90f59dce0d3b",
  sha256: "fa08b36470ad99eb7d968a0cbffcfcabc383ffb075edba51c4f441b15dedf191",
  bytes: 297_870,
});

export const KERNEL_COREUTILS_VERSION = "0.3.5";

export const KERNEL_BUSYBOX_VERSION = "1.37.0+nimbus.e9f019ab";

export const PRODUCT_COMPUTER_BUSYBOX_VERSION = PRODUCT_COMPUTER_BUSYBOX_ARTIFACT.version;
