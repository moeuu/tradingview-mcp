# Changelog

All notable changes to TradingView MCP are documented here.

The format is based on Keep a Changelog, and this project follows Semantic
Versioning.

## [Unreleased]

### Fixed

- Route Codex review requests through a trusted `workflow_run` so Dependabot
  and fork pull requests can use the gate without a personal access token.

## [0.4.1] - 2026-08-19

### Added

- A commit-specific GitHub status gate that waits for Codex review completion before a pull request can merge.
- Explicit source metadata showing whether the requested TradingView analysis lookback was fully available.

### Fixed

- Preserve complete intraday sessions during date lookup and return `no_session_bar` for wholly unavailable ranges.
- Wait for observable TradingView chart rendering stability after selecting a Custom range.
- Reject weekly, monthly, multi-day, and sub-nine-second intervals from single-day lookup so one complete session remains representable.
- Keep normalized CSV export headers globally unique even when generated suffixes collide.
- Preserve exact-case authentication allowlists, supported TSV HttpOnly markers, and current cookies only.
- Read authentication files through one verified descriptor and reject files changed during the read.
- Reject undeclared fields, including credential-like fields, from every TradingView MCP tool input.
- Recognize TradingView's centered-dot primary-symbol label during capture audits.

## [0.4.0] - 2026-08-19

### Added

- One-call `tradingview_capture_period` MCP image capture for an exact symbol, interval, and calendar range.
- One-call `tradingview_get_day` market context with OHLCV, gaps, changes, volume, rolling performance, technical analysis, non-trading-day detection, and source metadata.
- Preservation of additional indicator and strategy columns from official TradingView chart-data exports.

### Changed

- Date-oriented browser workflows now use TradingView's Custom range UI and return the observed chart timezone.
- Symbol navigation retries once when the official chart does not confirm the requested identity after its first load.

## [0.3.0] - 2026-08-19

### Added

- Client-independent stdio configuration and compatibility documentation.
- Explicit cookie-name and local-storage-key authentication allowlists.
- Owner-only authentication file checks and repository-wide English-only text checks.

### Changed

- Renamed the MCP server identity to `tradingview-mcp`.
- Switched browser automation and the local viewer to English-only UI text.
- Reduced the default browser authentication import to three session-related cookies and no local storage.

## [0.2.0] - 2026-08-19

### Added

- Lazy, on-demand TradingView browser startup with automatic idle shutdown.
- High-level MCP tools for chart opening, screenshots, history retrieval, and
  compact market-data summaries.
- Configurable browser origins, navigation timeouts, and authenticated storage
  state outside the repository.
- Public-release safety checks, CI, Dependabot, and security documentation.

### Changed

- Removed the requirement for an always-running system service.
- Generalized defaults, examples, paths, and documentation for public use.
- Updated production and development dependencies.

[Unreleased]: https://github.com/moeuu/tradingview-mcp/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/moeuu/tradingview-mcp/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/moeuu/tradingview-mcp/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/moeuu/tradingview-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/moeuu/tradingview-mcp/releases/tag/v0.2.0
