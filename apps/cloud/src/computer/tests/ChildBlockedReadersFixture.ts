import type { KernelCommandChild } from "../../kernel/KernelCommandForwarder.ts";
import { bashArtifactAvailable, createBashGateway } from "./ChildBashGatewayFixture.ts";
import {
  captureText,
  cleanupGatewayCommand,
  publicCommand,
  within,
} from "./ChildBashGatewayCommand.ts";

export { bashArtifactAvailable };

export async function startBlockedBashReaders(readerCount: number) {
  const run = createBashGateway();
  const controller = new AbortController();
  const expectedReads = readerCount + 1;
  const readersEntered = Promise.withResolvers<number>();
  let readEntries = 0;
  let forks = 0;
  const pushTrace = run.forkTrace.push.bind(run.forkTrace);
  run.forkTrace.push = (...events) => {
    for (const event of events) {
      if (event.event === "fork" && event.childPid !== undefined) forks++;
      if (
        event.event === "syscall" &&
        event.name === "fd_read" &&
        Array.isArray(event.args) &&
        Number(event.args[0]) === 0
      ) {
        readEntries++;
        if (readEntries === expectedReads) readersEntered.resolve(readEntries);
      }
    }
    return pushTrace(...events);
  };
  let child: KernelCommandChild | undefined;
  let settled: Promise<unknown> = Promise.resolve();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await cleanupGatewayCommand(run, child, controller, true);
      await settled;
    } finally {
      run.forkTrace.push = pushTrace;
    }
  };
  try {
    child = await publicCommand(
      run,
      `coproc F { read -r z; }; exec 5<&\${F[0]}; for i in {1..${readerCount}}; do ( read -r x <&5 ) & done; wait`,
      controller.signal,
    );
    const stdout = captureText(child.stdout);
    const stderr = captureText(child.stderr);
    settled = Promise.allSettled([stdout.settled, stderr.settled, child.exited]);
    const startup = await within(
      Promise.race([
        readersEntered.promise,
        child.exited.then(
          () => -1,
          () => -1,
        ),
      ]),
      30_000,
    );
    if (startup.kind !== "completed" || startup.value !== expectedReads) {
      throw new Error(
        `Only ${readEntries} fd_read(0) entries across ${forks} forks; expected ${expectedReads}; stderr: ${stderr.text()}`,
      );
    }
    return {
      fdReadEntries: () => readEntries,
      forkCount: () => forks,
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Blocked Bash reader startup and cleanup failed");
    }
    throw error;
  }
}
