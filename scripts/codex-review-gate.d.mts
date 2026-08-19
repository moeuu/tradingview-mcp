export const CODEX_BOT_LOGIN: string;
export const CODEX_STATUS_CONTEXT: string;
export const GITHUB_ACTIONS_BOT_LOGIN: string;

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
  reviewRequestReactions: Array<{
    user?: { login?: string | undefined } | undefined;
    content?: string | undefined;
    created_at?: string | undefined;
  }>;
  headSha: string;
  reviewRequestedAt: string;
}

interface CodexReviewGateResult {
  complete: boolean;
  outcome: "review" | "no-suggestions" | "pending";
  completedAt: string | null;
}

export function detectCodexCompletion(
  input: CodexReviewGateInput,
): CodexReviewGateResult;

export function retryableGithubStatus(status: number): boolean;

export function codexRequestReactionState(
  reactions: Array<{
    user?: { login?: string | undefined } | undefined;
    content?: string | undefined;
  }>,
): { acknowledged: boolean; inProgress: boolean };

export function githubRetryAfterMs(value: string | null): number | undefined;
