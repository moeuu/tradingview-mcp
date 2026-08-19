# TradingView MCP

[![CI](https://github.com/moeuu/tradingview-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/moeuu/tradingview-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933.svg)](package.json)

A local-first Model Context Protocol server and loopback REST API for market data, deterministic technical analysis, chart rendering, and optional TradingView Supercharts browser workflows.

The server runs over stdio and starts its local viewer and Playwright browsers only when a tool needs them. High-level history and analysis tools close the managed browser automatically by default.

> [!IMPORTANT]
> This is an independent open-source project. It is not affiliated with, sponsored by, or endorsed by TradingView. TradingView and Lightweight Charts are trademarks of TradingView, Inc. Users are responsible for complying with TradingView's terms, account permissions, exchange entitlements, and applicable data licenses.

## Features

- MCP tools for market discovery, quotes, OHLCV, analysis, and chart state
- One-call official TradingView screenshots for an exact symbol, interval, and date range
- One-call historical-date context with OHLCV, gaps, changes, volume, exported indicator fields, rolling performance, and technical analysis
- Deterministic SMA, EMA, RSI, MACD, Bollinger Bands, ATR, trend, signal, and support/resistance calculations
- Local Lightweight Charts viewer with PNG capture
- CSV, inline OHLCV, demo data, and optional configured upstream support
- Atomic indicator, level, custom-series, price-zone, and marker overlays
- Opt-in Playwright workflows for account-authorized TradingView Supercharts navigation, CSV export, indicators, and screenshots
- Compact MCP results by default so large OHLCV arrays do not consume model context unnecessarily
- Loopback-only HTTP binding, path containment, input validation, credential filtering, and fail-closed browser checks

## Architecture

```text
MCP client -- stdio --+-- deterministic analysis and chart state
                      +-- on-demand local viewer / PNG capture
                      +-- optional on-demand TradingView browser

REST client -- loopback HTTP -- local viewer and compatible JSON endpoints
```

The local viewer is a deterministic rendering surface; it is not a clone of proprietary TradingView charting features. See [the compatibility boundary](docs/COMPATIBILITY.md).

## Requirements

- Node.js 22 or newer
- npm
- Chromium installed through Playwright when screenshot or browser tools are used

## Install from source

```bash
git clone https://github.com/moeuu/tradingview-mcp.git
cd tradingview-mcp
npm ci
npx playwright install chromium
npm run build
```

For Linux CI or a machine without Chromium system dependencies:

```bash
npx playwright install --with-deps chromium
```

## Connect an MCP client

TradingView MCP is client-independent. It uses the standard MCP stdio transport and does not call client-specific APIs. Any MCP client that can launch a local process can use:

```text
node /absolute/path/to/tradingview-mcp/dist/mcp.js
```

Many desktop and editor clients use this common configuration shape:

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "node",
      "args": ["/absolute/path/to/tradingview-mcp/dist/mcp.js"],
      "env": {
        "MARKET_CHART_PORT": "0",
        "MARKET_CHART_DATA_ROOT": "/absolute/path/to/tradingview-mcp/data"
      }
    }
  }
}
```

Adapt the outer configuration keys to your client if needed; the command, arguments, environment, and MCP protocol remain the same. Restart the client after changing its configuration. `MARKET_CHART_PORT=0` selects an ephemeral viewer port and avoids a permanently listening service.

See [MCP client setup and compatibility](docs/MCP_CLIENTS.md) for transport behavior, lifecycle, and troubleshooting.

## Recommended MCP workflow

1. Call `market_get_capabilities` when provider availability is unclear.
2. Use `tradingview_get_day` for comprehensive information about a symbol on a specific date.
3. Use `tradingview_capture_period` for an official Supercharts PNG covering exact calendar dates.
4. Use `tradingview_analyze_symbol` for one-call recent history plus deterministic analysis.
5. Use `tradingview_get_history` when only recent history is needed.
6. Use `chart_import_csv` or `chart_set_data` for local/user-provided data.
7. Use `chart_analyze`, `chart_apply_overlays`, and `chart_snapshot` for local analysis and visualization.

Example calls:

```json
{
  "name": "tradingview_capture_period",
  "arguments": {
    "symbol": "NASDAQ:AAPL",
    "interval": "D",
    "from": "2024-01-02",
    "to": "2024-03-28"
  }
}
```

```json
{
  "name": "tradingview_get_day",
  "arguments": {
    "symbol": "NASDAQ:AAPL",
    "date": "2024-01-03",
    "interval": "D",
    "timezone": "America/New_York"
  }
}
```

`tradingview_get_day` returns an explicit `no_session_bar` status for weekends, holidays, and unavailable dates rather than silently substituting a nearby session. On a matching date it returns session OHLCV, previous and next bars when loaded, prior-close and open-gap changes, intraday range, rolling 5/20/50/200-period performance, deterministic indicators and signals, and every additional indicator column present in the official TradingView chart export. Set an intraday `interval` and `includeBars:true` to receive all exported bars assigned to that date.

High-level TradingView tools close the browser by default. Set `includeBars: true` only when raw bars are required in the MCP response, and `keepBrowserOpen: true` only for immediate follow-up browser tools.

The server exposes both high-level and granular tools. Clients that support an `enabled_tools` allowlist can expose only the tools needed for a given workflow.

## Optional TradingView browser workflow

Browser automation is disabled by default. A cookie export is the preferred authentication source because it can contain only the required session cookies. Never paste credential values into MCP arguments, repository files, client configuration, or prompts.

```bash
chmod 600 /absolute/path/to/tradingview-cookies.txt
export TRADINGVIEW_BROWSER_ENABLED=true
export TRADINGVIEW_BROWSER_BASE_URL=https://www.tradingview.com
export TRADINGVIEW_BROWSER_COOKIE_FILE=/absolute/path/to/tradingview-cookies.txt
export TRADINGVIEW_BROWSER_AUTH_COOKIE_NAMES=sessionid,sessionid_sign,device_t
export TRADINGVIEW_BROWSER_HEADLESS=true
export TRADINGVIEW_BROWSER_TIMEOUT_MS=120000
```

The authentication file must remain outside the repository, be smaller than 1 MiB, and have owner-only permissions on POSIX systems. The default policy imports only `sessionid`, `sessionid_sign`, and `device_t` from TradingView domains. Local storage is not imported by default. Cookie values, storage values, and authentication file paths are never accepted as MCP tool arguments or returned by MCP or REST responses.

A Playwright storage-state file can be used with `TRADINGVIEW_BROWSER_AUTH_STATE` when a cookie export is unavailable. The same cookie allowlist applies. Set `TRADINGVIEW_BROWSER_AUTH_STORAGE_KEYS` only when a verified workflow requires specific local-storage keys; its default is empty.

Supercharts UI availability, selectors, exports, account plans, exchange entitlements, and delayed/live status are controlled by TradingView and can change independently of this project. The automation never attempts an account upgrade or purchase.

See [TradingView browser workflows](docs/TRADINGVIEW_BROWSER.md) for details and limitations.

## Standalone REST API and viewer

The REST API is optional and does not need to run for normal MCP use.

```bash
npm run serve
```

It binds to `127.0.0.1:4317` by default:

```bash
curl http://127.0.0.1:4317/api/health
curl 'http://127.0.0.1:4317/api/price/DEMO:MARKET?timeframe=60&range=20'
```

Set a bearer token before enabling a paid/configured upstream or exposing sensitive local chart data to another local process:

```bash
export MARKET_CHART_API_TOKEN='replace-with-a-long-random-value'
npm run serve
```

HTTP binding is restricted to loopback addresses. See the [REST API reference](docs/API.md).

## Configuration

Copy `.env.example` as a reference, but load real values from your shell, process manager, or secret store. The application does not automatically read `.env` files.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MARKET_CHART_HOST` | `127.0.0.1` | Loopback bind address only |
| `MARKET_CHART_PORT` | `4317` | REST/viewer port; use `0` for an ephemeral MCP viewer |
| `MARKET_CHART_DATA_ROOT` | `./data` | Contained CSV, export, and capture root |
| `MARKET_CHART_API_TOKEN` | unset | Optional REST bearer token |
| `MARKET_CHART_SCREENSHOTS` | `true` | Enable local viewer PNG capture |
| `TRADINGVIEW_BROWSER_ENABLED` | `false` | Enable Supercharts browser tools |
| `TRADINGVIEW_BROWSER_BASE_URL` | `https://www.tradingview.com` | Allowed TradingView origin |
| `TRADINGVIEW_BROWSER_AUTH_STATE` | unset | External Playwright storage-state path |
| `TRADINGVIEW_BROWSER_COOKIE_FILE` | unset | External cookie-export path |
| `TRADINGVIEW_BROWSER_AUTH_COOKIE_NAMES` | `sessionid,sessionid_sign,device_t` | Cookie-name allowlist; values stay in the external file |
| `TRADINGVIEW_BROWSER_AUTH_STORAGE_KEYS` | empty | Opt-in local-storage key allowlist |
| `TRADINGVIEW_BROWSER_HEADLESS` | `true` | Run managed Chromium headlessly |
| `TRADINGVIEW_BROWSER_TIMEOUT_MS` | `30000` | Browser operation timeout, 5-120 seconds |
| `TRADINGVIEW_RAPIDAPI_KEY` | unset | Optional compatible upstream key |
| `TRADINGVIEW_RAPIDAPI_HOST` | provider default | Optional compatible upstream host |

## Local CSV format

CSV imports must resolve inside `MARKET_CHART_DATA_ROOT`, contain ascending timestamps, and stay within configured limits.

```csv
time,open,high,low,close,volume
2026-01-02T00:00:00Z,100,104,99,103,1200000
2026-01-03T00:00:00Z,103,106,101,105,1350000
```

`timestamp` or `date` can replace `time`; Unix seconds and milliseconds are also accepted.

## Security model

- No network listener is created by an idle stdio MCP process.
- Local HTTP routes bind only to loopback and validate the `Host` header.
- Imported files use real-path containment and reject symlink traversal.
- Browser authentication is read from one external owner-only file and filtered by domain, cookie name, expiry, size, and optional local-storage key allowlists.
- MCP and REST request schemas do not accept cookies, tokens, storage state, or authentication file paths.
- Browser operations serialize stateful UI work and reject credential-like tool inputs.
- Generated browser artifacts, credentials, `.env` files, traces, and local market data are ignored by Git.
- Results are analytical observations, not investment advice or a guarantee of future performance.

Please report vulnerabilities according to [SECURITY.md](SECURITY.md).

## Development

```bash
npm ci
npx playwright install chromium
npm run check
```

`npm run check` runs public-release safety checks, repository-wide English-only text validation, strict TypeScript checking, the full Vitest suite, and the production build.

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). By participating, you agree to follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License and attribution

The project source is available under the [MIT License](LICENSE). The bundled viewer uses TradingView Lightweight Charts under Apache-2.0; required notices are in [NOTICE](NOTICE), [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md), and [licenses/Apache-2.0.txt](licenses/Apache-2.0.txt).
