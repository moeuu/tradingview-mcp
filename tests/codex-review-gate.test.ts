import { describe, expect, it } from "vitest";

import {
  CODEX_BOT_LOGIN,
  detectCodexCompletion,
} from "../scripts/codex-review-gate.mjs";

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const HEAD_COMMITTED_AT = "2026-08-19T08:00:00Z";

describe("Codex review gate", () => {
  it("accepts a submitted Codex review only for the current head", () => {
    const result = detectCodexCompletion({
      headSha: HEAD_SHA,
      headCommittedAt: HEAD_COMMITTED_AT,
      reviews: [
        {
          user: { login: CODEX_BOT_LOGIN },
          commit_id: HEAD_SHA,
          submitted_at: "2026-08-19T08:05:00Z",
        },
      ],
      reactions: [],
    });

    expect(result).toMatchObject({ complete: true, outcome: "review" });
  });

  it("rejects a review for an obsolete head", () => {
    const result = detectCodexCompletion({
      headSha: HEAD_SHA,
      headCommittedAt: HEAD_COMMITTED_AT,
      reviews: [
        {
          user: { login: CODEX_BOT_LOGIN },
          commit_id: "fedcba9876543210fedcba9876543210fedcba98",
          submitted_at: "2026-08-19T08:05:00Z",
        },
      ],
      reactions: [],
    });

    expect(result).toEqual({ complete: false, outcome: "pending", completedAt: null });
  });

  it("accepts a no-suggestions reaction created after the head commit", () => {
    const result = detectCodexCompletion({
      headSha: HEAD_SHA,
      headCommittedAt: HEAD_COMMITTED_AT,
      reviews: [],
      reactions: [
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
      headCommittedAt: HEAD_COMMITTED_AT,
      reviews: [],
      reactions: [
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
});
