# MCP client compatibility

TradingView MCP uses the standard Model Context Protocol over stdio. It does
not require a client-specific extension, account, transport, callback, or API.

## Process contract

An MCP client launches this command and exchanges JSON-RPC messages through
stdin and stdout:

```text
node /absolute/path/to/tradingview-mcp/dist/mcp.js
```

Diagnostics are written to stderr so stdout remains a valid MCP transport.
The automated suite performs a complete SDK handshake, tool discovery, tool
calls, structured-result validation, and graceful shutdown through a generic
MCP client.

## Common configuration

Clients often use a JSON object similar to this one:

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

Some clients use different names for the outer server collection, working
directory, startup timeout, tool timeout, or tool allowlist. Those settings are
client concerns. The executable and protocol do not change.

## Lifecycle

- The MCP process is started and stopped by the client.
- No HTTP listener starts during initialization.
- The local viewer starts only when a viewer or screenshot tool needs it.
- Chromium starts only when a browser tool needs it.
- High-level history and analysis tools close Chromium by default.
- High-level date lookup and period-capture tools close Chromium by default.
- `tradingview_close` explicitly releases browser resources after interactive
  work.

Use `MARKET_CHART_PORT=0` for an ephemeral viewer port when the client does not
need a stable URL.

## Authentication boundary

Authentication is configured only in the server process environment. Tool
arguments cannot contain cookies, tokens, storage state, or authentication file
paths. The recommended client configuration therefore contains only a path to
an owner-only cookie file, never the credential values themselves:

```json
{
  "env": {
    "TRADINGVIEW_BROWSER_ENABLED": "true",
    "TRADINGVIEW_BROWSER_COOKIE_FILE": "/absolute/path/to/tradingview-cookies.txt",
    "TRADINGVIEW_BROWSER_AUTH_COOKIE_NAMES": "sessionid,sessionid_sign,device_t"
  }
}
```

The server imports only allowlisted names from TradingView domains. Local
storage is excluded unless `TRADINGVIEW_BROWSER_AUTH_STORAGE_KEYS` explicitly
allows individual keys.

## Client capability notes

The server returns both text and `structuredContent` for JSON tools. Clients
that render only text can still use the tools. Clients that understand tool
annotations receive read-only, destructive, idempotent, and open-world hints.
Image results use MCP image content where applicable.

## High-level TradingView calls

The following calls are designed to require no browser choreography from the MCP client:

```json
{
  "name": "tradingview_capture_period",
  "arguments": {
    "symbol": "NASDAQ:AAPL",
    "interval": "D",
    "from": "2024-01-02",
    "to": "2024-01-31"
  }
}
```

The result contains standard MCP image content plus structured symbol, interval, requested range, chart timezone, authentication, and delayed-data metadata.

```json
{
  "name": "tradingview_get_day",
  "arguments": {
    "symbol": "TSE:7203",
    "date": "2024-06-03",
    "timezone": "Asia/Tokyo"
  }
}
```

The date lookup returns structured JSON and does not require the client to parse prose. It distinguishes a missing session from a successful match and includes provenance for every result. An intraday interval can aggregate one local calendar day; `includeBars:true` adds its individual bars.

If a client cannot connect, verify that it supports local stdio servers, that
Node.js 22 or newer is on the client's process path, and that the absolute
entrypoint exists after `npm run build`.
