export const CODEX_BOT_LOGIN: string;
export const CODEX_STATUS_CONTEXT: string;

interface CodexReviewGateInput {
  reviews: Array<{
    user?: { login?: string | undefined } | undefined;
    commit_id?: string | undefined;
    submitted_at?: string | undefined;
  }>;
  reviewSummaryComments?: Array<{
    user?: { login?: string | undefined } | undefined;
    body?: string | undefined;
    created_at?: string | undefined;
  }> | undefined;
  pullRequestReactions?: Array<{
    user?: { login?: string | undefined } | undefined;
    content?: string | undefined;
    created_at?: string | undefined;
  }> | undefined;
  reviewRequestComments?: Array<{
    author_association?: string | undefined;
    body?: string | undefined;
    created_at?: string | undefined;
    reactions?: Array<{
      user?: { login?: string | undefined } | undefined;
      content?: string | undefined;
      created_at?: string | undefined;
    }> | undefined;
  }> | undefined;
  headSha: string;
  reviewTriggeredAt: string;
}

interface CodexReviewGateResult {
  complete: boolean;
  outcome:
    | "review"
    | "no-suggestions"
    | "clean-reaction"
    | "in-progress"
    | "pending";
  completedAt: string | null;
  acknowledged: boolean;
}

export function detectCodexCompletion(
  input: CodexReviewGateInput,
): CodexReviewGateResult;

export function retryableGithubStatus(status: number): boolean;

export function githubRetryAfterMs(value: string | null): number | undefined;

export function previousReviewIsIncomplete(
  statuses: Array<{
    context?: string | undefined;
    state?: string | undefined;
  }>,
): boolean;
