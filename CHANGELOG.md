# Changelog

All notable changes to TradingView MCP are documented here.

The format is based on Keep a Changelog, and this project follows Semantic
Versioning.

## [Unreleased]

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

[Unreleased]: https://github.com/moeuu/tradingview-mcp/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/moeuu/tradingview-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/moeuu/tradingview-mcp/releases/tag/v0.2.0
