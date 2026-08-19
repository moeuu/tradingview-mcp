import { pathToFileURL } from "node:url";

export const CODEX_BOT_LOGIN = "chatgpt-codex-connector[bot]";
export const CODEX_STATUS_CONTEXT = "codex-review";

export function detectCodexCompletion({
  reviews,
  reactions,
  headSha,
  headCommittedAt,
}) {
  const review = reviews.find(
    (item) =>
      item?.user?.login === CODEX_BOT_LOGIN &&
      item.commit_id === headSha &&
      typeof item.submitted_at === "string",
  );
  if (review) {
    return {
      complete: true,
      outcome: "review",
      completedAt: review.submitted_at,
    };
  }

  const headCommittedMs = Date.parse(headCommittedAt);
  const reaction = reactions.find(
    (item) =>
      item?.user?.login === CODEX_BOT_LOGIN &&
      item.content === "+1" &&
      typeof item.created_at === "string" &&
      Number.isFinite(headCommittedMs) &&
      Date.parse(item.created_at) >= headCommittedMs,
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

async function githubJson(apiPath, options = {}) {
  const response = await fetch(`https://api.github.com${apiPath}`, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${requiredEnvironment("GITHUB_TOKEN")}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  if (!response.ok) {
    throw new Error(
      `GitHub API ${options.method ?? "GET"} ${apiPath} failed with status ${response.status}.`,
    );
  }
  if (response.status === 204) return null;
  return response.json();
}

async function githubPages(apiPath) {
  const values = [];
  for (let page = 1; page <= 10; page += 1) {
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

async function requestReviewIfNeeded(repository, pullNumber, headSha, action) {
  if (!new Set(["synchronize", "reopened"]).has(action)) return;
  const marker = `<!-- codex-review-gate:${headSha} -->`;
  const comments = await githubPages(`/repos/${repository}/issues/${pullNumber}/comments`);
  if (comments.some((comment) => typeof comment.body === "string" && comment.body.includes(marker))) {
    return;
  }
  await githubJson(`/repos/${repository}/issues/${pullNumber}/comments`, {
    method: "POST",
    body: { body: `@codex review\n\n${marker}` },
  });
}

async function readCompletion(repository, pullNumber, headSha, headCommittedAt) {
  const [reviews, reactions] = await Promise.all([
    githubPages(`/repos/${repository}/pulls/${pullNumber}/reviews`),
    githubPages(`/repos/${repository}/issues/${pullNumber}/reactions`),
  ]);
  return detectCodexCompletion({ reviews, reactions, headSha, headCommittedAt });
}

async function main() {
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const pullNumber = positiveInteger(requiredEnvironment("PR_NUMBER"), "PR_NUMBER");
  const headSha = exactSha(requiredEnvironment("PR_HEAD_SHA"));
  const action = requiredEnvironment("PR_ACTION");
  const commit = await githubJson(`/repos/${repository}/commits/${headSha}`);
  const headCommittedAt = commit?.commit?.committer?.date;
  if (typeof headCommittedAt !== "string") {
    throw new Error("The pull request head commit has no committer date.");
  }

  await setStatus(repository, headSha, "pending", "Waiting for Codex review on this commit");
  try {
    let completion = await readCompletion(
      repository,
      pullNumber,
      headSha,
      headCommittedAt,
    );
    if (!completion.complete) {
      await requestReviewIfNeeded(repository, pullNumber, headSha, action);
    }

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
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      completion = await readCompletion(
        repository,
        pullNumber,
        headSha,
        headCommittedAt,
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
