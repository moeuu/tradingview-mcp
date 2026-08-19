# Changelog

All notable changes to TradingView MCP are documented here.

The format is based on Keep a Changelog, and this project follows Semantic
Versioning.

## [Unreleased]

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

[Unreleased]: https://github.com/moeuu/tradingview-mcp/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/moeuu/tradingview-mcp/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/moeuu/tradingview-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/moeuu/tradingview-mcp/releases/tag/v0.2.0
