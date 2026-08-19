# Contributing

Thank you for helping improve TradingView MCP.

## Development setup

Requirements:

- Node.js 22 or newer
- npm
- Chromium installed through Playwright

```bash
npm ci
npx playwright install chromium
npm run check
```

Use a focused branch and keep changes small enough to review. Add tests for new
behavior and update documentation when an MCP tool, API route, configuration
variable, or security boundary changes.

## Pull requests

Before opening a pull request:

1. Run `npm run check`.
2. Run `npm audit --audit-level=high`.
3. Confirm that no credentials, browser storage, screenshots, traces, private
   market data, or machine-specific paths are included.
4. Explain the user-visible behavior and verification performed.

The required `codex-review` status remains pending until Codex has completed a
review of the pull request's current head commit. Codex submits a review with
inline comments when it has suggestions and reacts to the pull request with a
thumbs-up when it has none. Resolve every review thread before merging. A new
commit invalidates the previous result and requests another Codex review.

Repository Codex settings request an automatic review for every push. The gate
observes that review and publishes its commit-specific status. It uses only the
ephemeral GitHub Actions token with pull request read and commit status write
permissions; no personal access token or extra secret is required. The gate
runs only trusted code from the default branch and never checks out or executes
pull request code with its scoped token.

For a clean automatic review, the gate accepts a thumbs-up only after observing
a fresh in-progress acknowledgement for the current pull request event and
confirming the previous head had no pending Codex review. If Codex does not
acknowledge within two minutes, the pending status asks a maintainer to comment
`@codex review` while the gate continues waiting. A clean manual result is
bound to that trusted maintainer comment, while a review with suggestions is
bound directly to the pull request head commit.

The gate runs when a pull request is opened, marked ready for review, receives a
new commit, or is retargeted to `main`. A base retarget immediately invalidates
the previous status and waits for a maintainer-triggered review of the new diff.

Repository text must use English and ASCII characters only. This includes
source strings, tests, documentation, examples, issue templates, and
configuration files. `npm run check:public` enforces this rule.

By contributing, you agree that your contribution is licensed under the MIT
License included in this repository.

## Scope

Portable MCP tools, loopback APIs, browser lifecycle improvements, data import,
tests, and documentation are welcome. Personal infrastructure wiring, private
hostnames, account-specific defaults, and credentials do not belong in this
repository.
