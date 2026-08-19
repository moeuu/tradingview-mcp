export const CODEX_BOT_LOGIN: string;
export const CODEX_STATUS_CONTEXT: string;

interface CodexReviewGateInput {
  reviews: Array<{
    user?: { login?: string | undefined } | undefined;
    commit_id?: string | undefined;
    submitted_at?: string | undefined;
  }>;
  reactions: Array<{
    user?: { login?: string | undefined } | undefined;
    content?: string | undefined;
    created_at?: string | undefined;
  }>;
  headSha: string;
  headCommittedAt: string;
}

interface CodexReviewGateResult {
  complete: boolean;
  outcome: "review" | "no-suggestions" | "pending";
  completedAt: string | null;
}

export function detectCodexCompletion(
  input: CodexReviewGateInput,
): CodexReviewGateResult;
