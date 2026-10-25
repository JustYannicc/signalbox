export interface WorkflowRun {
  readonly runId: string;
  readonly url: string;
  readonly workflowFile: string;
  readonly headSha: string;
  readonly displayTitle: string;
  readonly status: string;
  readonly conclusion: string | null;
}

export interface WorkflowDispatchInput {
  readonly workflowFile: string;
  readonly ref: string;
  readonly headSha: string;
  readonly correlationId: string;
  readonly inputs: Readonly<Record<string, string>>;
}

export interface WorkflowReadInput {
  readonly workflowFile: string;
  readonly runId: string;
  readonly headSha: string;
}

export interface WorkflowArtifactInput extends WorkflowReadInput {
  readonly artifactName: string;
  readonly entryPath: string;
}

export interface WorkflowArtifactResult {
  readonly run: WorkflowRun;
  readonly artifact: {
    readonly id: string;
    readonly name: string;
    /** GitHub's SHA-256 digest of the downloaded ZIP archive. */
    readonly digest: string;
    readonly entryPath: string;
    /** SHA-256 of the exact extracted entry bytes. */
    readonly sha256: string;
    readonly bytes: number;
  };
  readonly text: string;
}

export interface CreateIssueInput {
  readonly title: string;
  readonly body: string;
  readonly correlationId: string;
}

export interface GitHubIssue {
  readonly number: number;
  readonly url: string;
  readonly title: string;
}
