import {
  KERNEL_BUSYBOX_VERSION,
  PRODUCT_COMPUTER_BUSYBOX_VERSION,
} from "../../kernel/KernelProgramArtifacts.ts";
import { CHILD_BUSYBOX_APPLETS, CHILD_PRODUCT_BUSYBOX_APPLETS } from "../ChildProgramSet.ts";
import type { ChildProgramCodes } from "../ChildProgramCodes.ts";
import { childProgramManifest, type ChildProgramFactory } from "./ChildProgramFactory.ts";

/** Base and product-only applets retain their separate executable pins. */
export function createChildBusyboxBindings(options: {
  readonly programs: Pick<
    ChildProgramCodes,
    "busyboxCat" | "busyboxApplets" | "productBusyboxApplets"
  >;
  readonly child: ChildProgramFactory;
}) {
  const { programs, child } = options;
  const register = (
    names: readonly string[],
    code: ChildProgramCodes["busyboxCat"],
    version: string,
  ) => {
    for (const name of names)
      child(
        `/bin/${name}`,
        code,
        "busybox",
        childProgramManifest(`@nimbus/busybox/${name}`, version, `busybox-${version}:${name}`),
      );
  };
  register(
    programs.busyboxApplets === undefined ? ["cat"] : CHILD_BUSYBOX_APPLETS,
    programs.busyboxApplets ?? programs.busyboxCat,
    KERNEL_BUSYBOX_VERSION,
  );
  if (programs.productBusyboxApplets !== undefined)
    register(
      CHILD_PRODUCT_BUSYBOX_APPLETS,
      programs.productBusyboxApplets,
      PRODUCT_COMPUTER_BUSYBOX_VERSION,
    );
}
