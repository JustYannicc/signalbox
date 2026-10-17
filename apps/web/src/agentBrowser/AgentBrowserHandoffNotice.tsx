import { waitingQuestionForRun } from "@t3tools/client-runtime/automations/list";
import type { EnvironmentId } from "@t3tools/contracts";
import { CreditCardIcon } from "lucide-react";
import { memo } from "react";

import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { AskAnswer } from "../components/automations/AskAnswer";
import { useAllAutomations } from "../components/automations/useAutomations";

/**
 * A tab the agent handed to the person (#579): what they're asked to do, and
 * the "Payment" automation's question answered right here, so paying and
 * saying how it went never leave the browser panel.
 */
export const AgentBrowserHandoffNotice = memo(function AgentBrowserHandoffNotice(props: {
  readonly environmentId: EnvironmentId;
  readonly site: string;
  readonly runId: string | null;
  readonly ownBrowserUrl: string | null;
}) {
  const { environmentId, site, runId, ownBrowserUrl } = props;
  const { entries } = useAllAutomations();
  const question =
    runId === null ? undefined : waitingQuestionForRun(entries, environmentId, runId);

  return (
    <div className="shrink-0 border-b p-2">
      <Alert variant="warning">
        <CreditCardIcon aria-hidden />
        <AlertTitle>Finish the payment on {site}</AlertTitle>
        <AlertDescription>
          <p>
            Take over and pay here
            {ownBrowserUrl === null ? null : (
              <>
                , or{" "}
                <a
                  href={ownBrowserUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2"
                >
                  in your own browser
                </a>
              </>
            )}
            . The agent waits until you say how it went.
          </p>
          {question === undefined ? null : (
            <AskAnswer
              environmentId={environmentId}
              question={question}
              density="rail"
              showTitle={false}
              showQuestion={false}
              showOpen={false}
            />
          )}
        </AlertDescription>
      </Alert>
    </div>
  );
});
