import { pathToFileURL } from "node:url";

export const CODEX_BOT_LOGIN = "chatgpt-codex-connector[bot]";
export const CODEX_STATUS_CONTEXT = "codex-review";
const GITHUB_RETRY_BUDGET_MS = 30 * 60 * 1_000;

export function detectCodexCompletion({
  reviews,
  reviewSummaryComments = [],
  headSha,
  reviewTriggeredAt,
}) {
  const reviewTriggeredMs = Date.parse(reviewTriggeredAt);
  const review = reviews.find(
    (item) =>
      item?.user?.login === CODEX_BOT_LOGIN &&
      item.commit_id === headSha &&
      typeof item.submitted_at === "string" &&
      Number.isFinite(reviewTriggeredMs) &&
      Date.parse(item.submitted_at) >= reviewTriggeredMs,
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
      !Number.isFinite(reviewTriggeredMs) ||
      Date.parse(item.created_at) < reviewTriggeredMs
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

  return { complete: false, outcome: "pending", completedAt: null };
}

export function retryableGithubStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export function githubRetryAfterMs(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

async function githubJson(apiPath, options = {}) {
  const method = options.method ?? "GET";
  const attempts = method === "GET" || options.retryTransient === true ? 4 : 1;
  const retryDeadline = Date.now() + GITHUB_RETRY_BUDGET_MS;
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
    const retryAfterMs = githubRetryAfterMs(response.headers.get("retry-after"));
    const retryDelay = retryAfterMs ?? retryDelayMs(attempt);
    if (retryDelay > retryDeadline - Date.now()) break;
    await delay(retryDelay);
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
    retryTransient: true,
    body: {
      state,
      context: CODEX_STATUS_CONTEXT,
      description,
      target_url: runUrl,
    },
  });
}

async function readCompletion(repository, pullNumber, headSha, reviewTriggeredAt) {
  const [reviews, reviewSummaryComments] = await Promise.all([
    githubPages(`/repos/${repository}/pulls/${pullNumber}/reviews`),
    githubPages(
      `/repos/${repository}/issues/${pullNumber}/comments?since=${encodeURIComponent(reviewTriggeredAt)}`,
    ),
  ]);
  return detectCodexCompletion({
    reviews,
    reviewSummaryComments,
    headSha,
    reviewTriggeredAt,
  });
}

async function main() {
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const pullNumber = positiveInteger(requiredEnvironment("PR_NUMBER"), "PR_NUMBER");
  const headSha = exactSha(requiredEnvironment("PR_HEAD_SHA"));
  const reviewTriggeredAt = exactTimestamp(
    requiredEnvironment("PR_EVENT_AT"),
    "PR_EVENT_AT",
  );

  await setStatus(repository, headSha, "pending", "Waiting for Codex review on this commit");
  try {
    let completion = await readCompletion(
      repository,
      pullNumber,
      headSha,
      reviewTriggeredAt,
    );

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
      await delay(pollMs);
      completion = await readCompletion(
        repository,
        pullNumber,
        headSha,
        reviewTriggeredAt,
      );
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

function exactTimestamp(value, name) {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${name} must be an ISO timestamp.`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
