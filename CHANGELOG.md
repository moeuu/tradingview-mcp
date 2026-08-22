# Changelog

All notable changes to TradingView MCP are documented here.

The format is based on Keep a Changelog, and this project follows Semantic
Versioning.

## [Unreleased]

### Removed

- Removed the repository-local Codex review gate in favor of the reusable
  `wait-for-codex-review` Codex skill.

## [0.1.0] - 2026-08-19

### Added

- Client-independent MCP stdio configuration and compatibility documentation.
- Lazy, on-demand TradingView browser startup with automatic idle shutdown.
- High-level tools for chart navigation, screenshots, official history,
  deterministic analysis, and compact market-data summaries.
- One-call `tradingview_capture_period` image capture for an exact symbol,
  interval, and calendar range.
- One-call `tradingview_get_day` context with OHLCV, gaps, changes, volume,
  rolling performance, technical analysis, non-trading-day detection, and
  source completeness metadata.
- Preservation of indicator and strategy columns from TradingView chart-data
  exports.
- A local loopback chart API and browser-based chart viewer.
- CI, dependency auditing, public-release safety checks, Dependabot, and a
  commit-specific Codex review gate.

### Changed

- Removed the always-running system service requirement; browsers and viewers
  now start only when requested.
- Generalized configuration, paths, documentation, and client examples for
  portable open-source use.
- Date workflows use TradingView's Custom range UI and report the observed
  chart timezone.
- High-level TradingView tools close the browser by default after completing
  their work.

### Security

- Import only explicitly allowlisted authentication cookies and local-storage
  keys, using exact-case matching and no local-storage defaults.
- Require owner-only authentication files, read them through one verified file
  descriptor, and reject files changed during the read.
- Reject undeclared and credential-like fields from every MCP tool input.
- Use only pull-request read and commit-status write permissions for the Codex
  review gate, without a personal access token or additional secret.
- Bind review evidence to the current head, reject ambiguous concurrent-review
  reactions, and require a new head commit after a pull-request base retarget.

### Fixed

- Preserve complete intraday sessions during date lookup and return structured
  `no_session_bar` results for wholly unavailable ranges.
- Wait for observable chart stability after applying a Custom range.
- Reject intervals that cannot represent one complete session in single-day
  lookup.
- Keep normalized CSV export headers globally unique.
- Preserve supported TSV HttpOnly markers and reject expired authentication
  cookies.
- Recognize TradingView's centered-dot primary-symbol label during capture
  audits.
- Retry symbol navigation when TradingView does not initially confirm the
  requested identity.

[Unreleased]: https://github.com/moeuu/tradingview-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/moeuu/tradingview-mcp/releases/tag/v0.1.0
