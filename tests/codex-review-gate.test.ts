import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CODEX_BOT_LOGIN,
  detectCodexCompletion,
  githubRetryAfterMs,
  retryableGithubStatus,
} from "../scripts/codex-review-gate.mjs";

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const REVIEW_TRIGGERED_AT = "2026-08-19T08:00:00Z";
const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("Codex review gate", () => {
  it("pins the trusted identities used by the gate", () => {
    expect(CODEX_BOT_LOGIN).toBe("chatgpt-codex-connector[bot]");
  });

  it("uses only pull request and status scopes for automatic review verification", () => {
    const gate = readFileSync(
      `${REPOSITORY_ROOT}/.github/workflows/codex-review-gate.yml`,
      "utf8",
    );

    expect(gate).toContain("pull_request_target:");
    expect(gate).toContain("types: [edited, opened, ready_for_review, synchronize]");
    expect(gate).toContain("github.event.changes.base.ref.from != null");
    expect(gate).toContain("REQUIRE_COMMIT_BOUND_REVIEW:");
    expect(gate).toContain("PR_PREVIOUS_SHA:");
    expect(gate).toContain("timeout-minutes: 35");
    expect(gate).not.toContain("issues: write");
    expect(gate).toContain("pull-requests: read");
    expect(gate).not.toContain("pull-requests: write");
    expect(gate).toContain("statuses: write");
    expect(gate).toContain("github.event.pull_request.updated_at");
    const gateScript = readFileSync(
      `${REPOSITORY_ROOT}/scripts/codex-review-gate.mjs`,
      "utf8",
    );
    expect(gateScript).toContain("AbortSignal.timeout(requestBudgetMs)");
    expect(gateScript).toContain(
      "process.env.REQUIRE_COMMIT_BOUND_REVIEW === \"true\"",
    );
    expect(gateScript).toContain("previousReviewIsPending");
    expect(gateScript).toContain("CODEX_AUTO_START_GRACE_MS");
  });

  it("accepts a submitted Codex review only for the current head", () => {
    const result = detectCodexCompletion({
      headSha: HEAD_SHA,
      reviewTriggeredAt: REVIEW_TRIGGERED_AT,
      reviews: [
        {
          user: { login: CODEX_BOT_LOGIN },
          commit_id: HEAD_SHA,
          submitted_at: "2026-08-19T08:05:00Z",
        },
      ],
    });

    expect(result).toMatchObject({ complete: true, outcome: "review" });
  });

  it("rejects a review for an obsolete head", () => {
    const result = detectCodexCompletion({
      headSha: HEAD_SHA,
      reviewTriggeredAt: REVIEW_TRIGGERED_AT,
      reviews: [
        {
          user: { login: CODEX_BOT_LOGIN },
          commit_id: "fedcba9876543210fedcba9876543210fedcba98",
          submitted_at: "2026-08-19T08:05:00Z",
        },
      ],
    });

    expect(result).toEqual({
      complete: false,
      outcome: "pending",
      completedAt: null,
      acknowledged: false,
    });
  });

  it("rejects an exact-head review submitted before the pull request event", () => {
    const result = detectCodexCompletion({
      headSha: HEAD_SHA,
      reviewTriggeredAt: REVIEW_TRIGGERED_AT,
      reviews: [
        {
          user: { login: CODEX_BOT_LOGIN },
          commit_id: HEAD_SHA,
          submitted_at: "2026-08-19T07:59:59Z",
        },
      ],
    });

    expect(result).toEqual({
      complete: false,
      outcome: "pending",
      completedAt: null,
      acknowledged: false,
    });
  });

  it("keeps an automatic thumbs-up separate from commit-bound evidence", () => {
    const result = detectCodexCompletion({
      headSha: HEAD_SHA,
      reviewTriggeredAt: REVIEW_TRIGGERED_AT,
      reviews: [],
      pullRequestReactions: [
        {
          user: { login: CODEX_BOT_LOGIN },
          content: "+1",
          created_at: "2026-08-19T08:05:00Z",
        },
      ],
    });

    expect(result).toEqual({
      complete: false,
      outcome: "clean-reaction",
      completedAt: "2026-08-19T08:05:00Z",
      acknowledged: false,
    });
  });

  it("rejects an automatic reaction at the pull request event boundary", () => {
    const result = detectCodexCompletion({
      headSha: HEAD_SHA,
      reviewTriggeredAt: REVIEW_TRIGGERED_AT,
      reviews: [],
      pullRequestReactions: [
        {
          user: { login: CODEX_BOT_LOGIN },
          content: "+1",
          created_at: REVIEW_TRIGGERED_AT,
        },
        {
          user: { login: CODEX_BOT_LOGIN },
          content: "eyes",
          created_at: "2026-08-19T08:00:10Z",
        },
      ],
    });

    expect(result).toEqual({
      complete: false,
      outcome: "in-progress",
      completedAt: "2026-08-19T08:00:10Z",
      acknowledged: true,
    });
  });

  it("preserves an acknowledgement observed with a clean reaction", () => {
    const result = detectCodexCompletion({
      headSha: HEAD_SHA,
      reviewTriggeredAt: REVIEW_TRIGGERED_AT,
      reviews: [],
      pullRequestReactions: [
        {
          user: { login: CODEX_BOT_LOGIN },
          content: "eyes",
          created_at: "2026-08-19T08:00:10Z",
        },
        {
          user: { login: CODEX_BOT_LOGIN },
          content: "+1",
          created_at: "2026-08-19T08:05:00Z",
        },
      ],
    });

    expect(result).toEqual({
      complete: false,
      outcome: "clean-reaction",
      completedAt: "2026-08-19T08:05:00Z",
      acknowledged: true,
    });
  });

  it("recognizes a fresh automatic-review acknowledgement", () => {
    const result = detectCodexCompletion({
      headSha: HEAD_SHA,
      reviewTriggeredAt: REVIEW_TRIGGERED_AT,
      reviews: [],
      pullRequestReactions: [
        {
          user: { login: CODEX_BOT_LOGIN },
          content: "eyes",
          created_at: "2026-08-19T08:00:10Z",
        },
      ],
    });

    expect(result).toEqual({
      complete: false,
      outcome: "in-progress",
      completedAt: "2026-08-19T08:00:10Z",
      acknowledged: true,
    });
  });

  it("accepts a clean manual review bound to a trusted request comment", () => {
    const result = detectCodexCompletion({
      headSha: HEAD_SHA,
      reviewTriggeredAt: REVIEW_TRIGGERED_AT,
      reviews: [],
      reviewRequestComments: [
        {
          author_association: "OWNER",
          body: "@codex review",
          created_at: "2026-08-19T08:01:00Z",
          reactions: [
            {
              user: { login: CODEX_BOT_LOGIN },
              content: "+1",
              created_at: "2026-08-19T08:05:00Z",
            },
          ],
        },
      ],
    });

    expect(result).toEqual({
      complete: true,
      outcome: "no-suggestions",
      completedAt: "2026-08-19T08:05:00Z",
      acknowledged: false,
    });
  });

  it("rejects a clean review request from an untrusted commenter", () => {
    const result = detectCodexCompletion({
      headSha: HEAD_SHA,
      reviewTriggeredAt: REVIEW_TRIGGERED_AT,
      reviews: [],
      reviewRequestComments: [
        {
          author_association: "NONE",
          body: "@codex review",
          created_at: "2026-08-19T08:01:00Z",
          reactions: [
            {
              user: { login: CODEX_BOT_LOGIN },
              content: "+1",
              created_at: "2026-08-19T08:05:00Z",
            },
          ],
        },
      ],
    });

    expect(result).toEqual({
      complete: false,
      outcome: "pending",
      completedAt: null,
      acknowledged: false,
    });
  });

  it("accepts a post-event Codex summary naming the current head", () => {
    const result = detectCodexCompletion({
      headSha: HEAD_SHA,
      reviewTriggeredAt: REVIEW_TRIGGERED_AT,
      reviews: [],
      reviewSummaryComments: [
        {
          user: { login: CODEX_BOT_LOGIN },
          body: "No major issues.\n\n**Reviewed commit:** `0123456789`",
          created_at: "2026-08-19T08:05:00Z",
        },
      ],
    });

    expect(result).toMatchObject({ complete: true, outcome: "no-suggestions" });
  });

  it("rejects stale or mismatched no-suggestions summaries", () => {
    const result = detectCodexCompletion({
      headSha: HEAD_SHA,
      reviewTriggeredAt: REVIEW_TRIGGERED_AT,
      reviews: [],
      reviewSummaryComments: [
        {
          user: { login: CODEX_BOT_LOGIN },
          body: "**Reviewed commit:** `0123456789`",
          created_at: "2026-08-19T07:59:59Z",
        },
        {
          user: { login: CODEX_BOT_LOGIN },
          body: "**Reviewed commit:** `fedcba9876`",
          created_at: "2026-08-19T08:05:00Z",
        },
      ],
    });

    expect(result).toEqual({
      complete: false,
      outcome: "pending",
      completedAt: null,
      acknowledged: false,
    });
  });

  it("retries only transient GitHub response statuses", () => {
    expect([429, 500, 502, 503, 504].every(retryableGithubStatus)).toBe(true);
    expect([400, 401, 403, 404, 422].some(retryableGithubStatus)).toBe(false);
  });

  it("honors GitHub Retry-After durations without a ten-second cap", () => {
    expect(githubRetryAfterMs("45")).toBe(45_000);
    expect(githubRetryAfterMs("invalid")).toBeUndefined();
  });
});
