import { describe, expect, it } from "vitest";

import {
  CODEX_BOT_LOGIN,
  GITHUB_ACTIONS_BOT_LOGIN,
  detectCodexCompletion,
  retryableGithubStatus,
} from "../scripts/codex-review-gate.mjs";

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const REVIEW_REQUESTED_AT = "2026-08-19T08:00:00Z";

describe("Codex review gate", () => {
  it("pins the trusted identities used by the gate", () => {
    expect(CODEX_BOT_LOGIN).toBe("chatgpt-codex-connector[bot]");
    expect(GITHUB_ACTIONS_BOT_LOGIN).toBe("github-actions[bot]");
  });

  it("accepts a submitted Codex review only for the current head", () => {
    const result = detectCodexCompletion({
      headSha: HEAD_SHA,
      reviewRequestedAt: REVIEW_REQUESTED_AT,
      reviews: [
        {
          user: { login: CODEX_BOT_LOGIN },
          commit_id: HEAD_SHA,
          submitted_at: "2026-08-19T08:05:00Z",
        },
      ],
      reviewRequestReactions: [],
    });

    expect(result).toMatchObject({ complete: true, outcome: "review" });
  });

  it("rejects a review for an obsolete head", () => {
    const result = detectCodexCompletion({
      headSha: HEAD_SHA,
      reviewRequestedAt: REVIEW_REQUESTED_AT,
      reviews: [
        {
          user: { login: CODEX_BOT_LOGIN },
          commit_id: "fedcba9876543210fedcba9876543210fedcba98",
          submitted_at: "2026-08-19T08:05:00Z",
        },
      ],
      reviewRequestReactions: [],
    });

    expect(result).toEqual({ complete: false, outcome: "pending", completedAt: null });
  });

  it("rejects an exact-head review submitted before this gate request", () => {
    const result = detectCodexCompletion({
      headSha: HEAD_SHA,
      reviewRequestedAt: REVIEW_REQUESTED_AT,
      reviews: [
        {
          user: { login: CODEX_BOT_LOGIN },
          commit_id: HEAD_SHA,
          submitted_at: "2026-08-19T07:59:59Z",
        },
      ],
      reviewRequestReactions: [],
    });

    expect(result).toEqual({ complete: false, outcome: "pending", completedAt: null });
  });

  it("accepts a no-suggestions reaction on the head-specific request", () => {
    const result = detectCodexCompletion({
      headSha: HEAD_SHA,
      reviewRequestedAt: REVIEW_REQUESTED_AT,
      reviews: [],
      reviewRequestReactions: [
        {
          user: { login: CODEX_BOT_LOGIN },
          content: "+1",
          created_at: "2026-08-19T08:05:00Z",
        },
      ],
    });

    expect(result).toMatchObject({ complete: true, outcome: "no-suggestions" });
  });

  it("rejects stale reactions and lookalike bot accounts", () => {
    const result = detectCodexCompletion({
      headSha: HEAD_SHA,
      reviewRequestedAt: REVIEW_REQUESTED_AT,
      reviews: [],
      reviewRequestReactions: [
        {
          user: { login: CODEX_BOT_LOGIN },
          content: "+1",
          created_at: "2026-08-19T07:59:59Z",
        },
        {
          user: { login: "chatgpt-codex-connector" },
          content: "+1",
          created_at: "2026-08-19T08:05:00Z",
        },
      ],
    });

    expect(result).toEqual({ complete: false, outcome: "pending", completedAt: null });
  });

  it("retries only transient GitHub response statuses", () => {
    expect([429, 500, 502, 503, 504].every(retryableGithubStatus)).toBe(true);
    expect([400, 401, 403, 404, 422].some(retryableGithubStatus)).toBe(false);
  });
});
