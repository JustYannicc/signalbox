export const KERNEL_GNU_SED_ARTIFACT = Object.freeze({
  repository: "https://ftp.gnu.org/gnu/sed/",
  version: "4.9+wasi.1",
  path: "sed.wasm",
  buildRecipe: "infra/kernelPrograms/gnu/build-sed.sh",
  sha256: "40c8bb93b7e43f501f7c7ddd5497a51fef0f5d88ec51d1b581f5efaae36af2c4",
  bytes: 245_369,
});
