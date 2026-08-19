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

The review gate runs only trusted code from the default branch. It does not
check out or execute pull request code with its write-scoped workflow token.

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
