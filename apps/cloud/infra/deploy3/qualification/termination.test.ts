import { expect, it } from "vite-plus/test";
import { classifyV8Termination } from "./termination.ts";

const verifiedHeapTermination = {
  exitCode: 1,
  signal: null,
  waited: true,
  timedOut: false,
  identityVerified: true,
  allocationRequestVerified: true,
  stderr: "FATAL ERROR: JavaScript heap out of memory",
};

it("classifies only the verified non-timeout V8 heap failure as the EC1 outcome", () => {
  expect(classifyV8Termination(verifiedHeapTermination)).toBe("V8_HEAP_OOM_PROCESS_TERMINATED");
  expect(
    classifyV8Termination({
      ...verifiedHeapTermination,
      timedOut: true,
    }),
  ).toBe("OTHER_TERMINATION");
  expect(
    classifyV8Termination({
      ...verifiedHeapTermination,
      identityVerified: false,
    }),
  ).toBe("OTHER_TERMINATION");
  expect(
    classifyV8Termination({
      ...verifiedHeapTermination,
      allocationRequestVerified: false,
    }),
  ).toBe("OTHER_TERMINATION");
});

it("requires an observed wait plus a nonzero exit or nonblank signal", () => {
  expect(classifyV8Termination({ ...verifiedHeapTermination, waited: false })).toBe(
    "NO_VERIFIED_TERMINATION",
  );
  expect(classifyV8Termination({ ...verifiedHeapTermination, exitCode: 0 })).toBe(
    "NO_VERIFIED_TERMINATION",
  );
  expect(
    classifyV8Termination({ ...verifiedHeapTermination, exitCode: undefined, signal: "  " }),
  ).toBe("NO_VERIFIED_TERMINATION");
  expect(
    classifyV8Termination({ ...verifiedHeapTermination, exitCode: undefined, signal: "SIGKILL" }),
  ).toBe("V8_HEAP_OOM_PROCESS_TERMINATED");
  expect(classifyV8Termination({ ...verifiedHeapTermination, stderr: "out of memory" })).toBe(
    "OTHER_TERMINATION",
  );
});
