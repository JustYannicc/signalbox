import type { DeviceAgentCommandFailure } from "@t3tools/contracts";

export function DeviceAgentCommandFailureNotice(props: {
  readonly failure: DeviceAgentCommandFailure;
}) {
  const { failure } = props;
  const hasDiagnostics = failure.diagnosticId !== undefined || failure.logPath !== undefined;

  return (
    <div role="alert" className="border-b bg-destructive/5 px-3 py-2 text-xs text-destructive">
      <p className="font-medium">agent-device {failure.command} failed</p>
      <p className="mt-1 whitespace-pre-wrap break-words">{failure.message}</p>
      {failure.hint ? <p className="mt-1 whitespace-pre-wrap break-words">{failure.hint}</p> : null}
      {hasDiagnostics ? (
        <details className="mt-1">
          <summary className="w-fit cursor-pointer underline decoration-dotted underline-offset-2">
            Diagnostic details
          </summary>
          <dl className="mt-1 grid gap-1 break-words">
            {failure.diagnosticId ? (
              <div>
                <dt className="inline font-medium">Diagnostic ID: </dt>
                <dd className="inline">{failure.diagnosticId}</dd>
              </div>
            ) : null}
            {failure.logPath ? (
              <div>
                <dt className="inline font-medium">Log path: </dt>
                <dd className="inline break-all font-mono">{failure.logPath}</dd>
              </div>
            ) : null}
          </dl>
        </details>
      ) : null}
    </div>
  );
}
