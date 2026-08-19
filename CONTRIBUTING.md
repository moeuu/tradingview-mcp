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
observes that review and publishes its commit-specific status. When a clean
automatic review produces only an ambiguous pull request reaction, the gate
requests one commit-bound verification. It uses the ephemeral GitHub Actions
token and requires no personal access token or extra secret. The gate runs only
trusted code from the default branch and never checks out or executes pull
request code with its scoped token.

The gate runs when a pull request is opened, marked ready for review, or receives
a new commit. After retargeting an existing pull request to `main`, push a new
commit so Codex reviews the new base diff and publishes a current status.

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
