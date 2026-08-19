import { pathToFileURL } from "node:url";

export const CODEX_BOT_LOGIN = "chatgpt-codex-connector[bot]";
export const CODEX_STATUS_CONTEXT = "codex-review";
export const GITHUB_ACTIONS_BOT_LOGIN = "github-actions[bot]";

export function detectCodexCompletion({
  reviews,
  reviewSummaryComments = [],
  reviewRequestReactions,
  headSha,
  reviewRequestedAt,
}) {
  const reviewRequestedMs = Date.parse(reviewRequestedAt);
  const review = reviews.find(
    (item) =>
      item?.user?.login === CODEX_BOT_LOGIN &&
      item.commit_id === headSha &&
      typeof item.submitted_at === "string" &&
      Number.isFinite(reviewRequestedMs) &&
      Date.parse(item.submitted_at) >= reviewRequestedMs,
  );
  if (review) {
    return {
      complete: true,
      outcome: "review",
      completedAt: review.submitted_at,
    };
  }

  const summary = reviewSummaryComments.find((item) => {
    if (
      item?.user?.login !== CODEX_BOT_LOGIN ||
      typeof item.body !== "string" ||
      typeof item.created_at !== "string" ||
      !Number.isFinite(reviewRequestedMs) ||
      Date.parse(item.created_at) < reviewRequestedMs
    ) return false;
    const reviewedCommit = /\*\*Reviewed commit:\*\*\s*`([a-f0-9]{10,40})`/i.exec(
      item.body,
    )?.[1];
    return reviewedCommit !== undefined && headSha.startsWith(reviewedCommit.toLowerCase());
  });
  if (summary) {
    return {
      complete: true,
      outcome: "no-suggestions",
      completedAt: summary.created_at,
    };
  }

  const reaction = reviewRequestReactions.find(
    (item) =>
      item?.user?.login === CODEX_BOT_LOGIN &&
      item.content === "+1" &&
      typeof item.created_at === "string" &&
      Number.isFinite(reviewRequestedMs) &&
      Date.parse(item.created_at) >= reviewRequestedMs,
  );
  if (reaction) {
    return {
      complete: true,
      outcome: "no-suggestions",
      completedAt: reaction.created_at,
    };
  }

  return { complete: false, outcome: "pending", completedAt: null };
}

export function retryableGithubStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export function codexRequestReactionState(reactions) {
  const contents = reactions
    .filter((item) => item?.user?.login === CODEX_BOT_LOGIN)
    .map((item) => item.content);
  return {
    acknowledged: contents.includes("eyes") || contents.includes("+1"),
    inProgress: contents.includes("eyes"),
  };
}

async function githubJson(apiPath, options = {}) {
  const method = options.method ?? "GET";
  const attempts = method === "GET" ? 4 : 1;
  let lastStatus;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response;
    try {
      response = await fetch(`https://api.github.com${apiPath}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${requiredEnvironment("GITHUB_TOKEN")}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch (error) {
      if (attempt + 1 >= attempts) throw error;
      await delay(retryDelayMs(attempt));
      continue;
    }
    if (response.ok) {
      if (response.status === 204) return null;
      return response.json();
    }
    lastStatus = response.status;
    if (!retryableGithubStatus(response.status) || attempt + 1 >= attempts) break;
    const retryAfterSeconds = Number(response.headers.get("retry-after"));
    await delay(
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
        ? Math.min(10_000, retryAfterSeconds * 1_000)
        : retryDelayMs(attempt),
    );
  }
  throw new Error(`GitHub API ${method} ${apiPath} failed with status ${lastStatus ?? "unknown"}.`);
}

async function githubPages(apiPath) {
  const values = [];
  for (let page = 1; ; page += 1) {
    const separator = apiPath.includes("?") ? "&" : "?";
    const next = await githubJson(`${apiPath}${separator}per_page=100&page=${page}`);
    if (!Array.isArray(next)) throw new Error("Expected a paginated GitHub API array.");
    values.push(...next);
    if (next.length < 100) break;
  }
  return values;
}

async function setStatus(repository, headSha, state, description) {
  const runUrl = `${requiredEnvironment("GITHUB_SERVER_URL")}/${repository}/actions/runs/${requiredEnvironment("GITHUB_RUN_ID")}`;
  await githubJson(`/repos/${repository}/statuses/${headSha}`, {
    method: "POST",
    body: {
      state,
      context: CODEX_STATUS_CONTEXT,
      description,
      target_url: runUrl,
    },
  });
}

async function createReviewRequest(repository, pullNumber, headSha) {
  const marker = `<!-- codex-review-gate:${headSha}:${requiredEnvironment("GITHUB_RUN_ID")}:${requiredEnvironment("GITHUB_RUN_ATTEMPT")} -->`;
  const created = await githubJson(`/repos/${repository}/issues/${pullNumber}/comments`, {
    method: "POST",
    body: { body: `@codex review\n\n${marker}` },
  });
  return reviewRequest(created);
}

async function readCompletion(repository, pullNumber, headSha, request) {
  const [reviews, reviewSummaryComments, reviewRequestReactions] = await Promise.all([
    githubPages(`/repos/${repository}/pulls/${pullNumber}/reviews`),
    githubPages(
      `/repos/${repository}/issues/${pullNumber}/comments?since=${encodeURIComponent(request.createdAt)}`,
    ),
    githubPages(`/repos/${repository}/issues/comments/${request.id}/reactions`),
  ]);
  return {
    completion: detectCodexCompletion({
      reviews,
      reviewSummaryComments,
      reviewRequestReactions,
      headSha,
      reviewRequestedAt: request.createdAt,
    }),
    requestState: codexRequestReactionState(reviewRequestReactions),
  };
}

async function main() {
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const pullNumber = positiveInteger(requiredEnvironment("PR_NUMBER"), "PR_NUMBER");
  const headSha = exactSha(requiredEnvironment("PR_HEAD_SHA"));

  await setStatus(repository, headSha, "pending", "Waiting for Codex review on this commit");
  try {
    const request = await createReviewRequest(repository, pullNumber, headSha);
    let snapshot = await readCompletion(repository, pullNumber, headSha, request);
    let requestAcknowledged = snapshot.requestState.acknowledged;
    let settledSamples = 0;
    let completion = { complete: false, outcome: "pending", completedAt: null };

    const timeoutMs = positiveInteger(
      process.env.CODEX_REVIEW_TIMEOUT_MS ?? "1800000",
      "CODEX_REVIEW_TIMEOUT_MS",
    );
    const pollMs = positiveInteger(
      process.env.CODEX_REVIEW_POLL_MS ?? "15000",
      "CODEX_REVIEW_POLL_MS",
    );
    const deadline = Date.now() + timeoutMs;
    while (!completion.complete && Date.now() < deadline) {
      requestAcknowledged ||= snapshot.requestState.acknowledged;
      settledSamples = requestAcknowledged && !snapshot.requestState.inProgress
        ? settledSamples + 1
        : 0;
      if (settledSamples >= 2) completion = snapshot.completion;
      if (completion.complete) break;
      await delay(pollMs);
      snapshot = await readCompletion(repository, pullNumber, headSha, request);
    }
    if (!completion.complete) {
      throw new Error("Codex did not finish reviewing the current pull request head in time.");
    }
    const description = completion.outcome === "review"
      ? "Codex review completed for this commit"
      : "Codex completed with no suggestions";
    await setStatus(repository, headSha, "success", description);
    process.stdout.write(`${description}.\n`);
  } catch (error) {
    await setStatus(repository, headSha, "failure", "Codex review did not complete").catch(
      () => undefined,
    );
    throw error;
  }
}

function reviewRequest(value) {
  if (
    !value ||
    value?.user?.login !== GITHUB_ACTIONS_BOT_LOGIN ||
    !Number.isSafeInteger(value.id) ||
    typeof value.created_at !== "string" ||
    !Number.isFinite(Date.parse(value.created_at))
  ) {
    throw new Error("The Codex review request comment response was incomplete.");
  }
  return { id: value.id, createdAt: value.created_at };
}

function retryDelayMs(attempt) {
  return Math.min(2_000, 250 * 2 ** attempt);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function exactSha(value) {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error("PR_HEAD_SHA must be a full commit SHA.");
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
