# TradingView Supercharts browser

This service uses Playwright to operate the official TradingView Supercharts UI. It does not call undocumented chart websocket protocols and does not return authentication material to MCP clients.

## Authentication

Enable the browser and provide one authentication source. A minimal cookie export is preferred over a full browser profile or storage-state export:

```bash
export TRADINGVIEW_BROWSER_ENABLED=true
export TRADINGVIEW_BROWSER_BASE_URL=https://www.tradingview.com
export TRADINGVIEW_BROWSER_COOKIE_FILE=/absolute/path/cookies.txt
export TRADINGVIEW_BROWSER_AUTH_COOKIE_NAMES=sessionid,sessionid_sign,device_t
# Alternative source: TRADINGVIEW_BROWSER_AUTH_STATE=/absolute/path/state.json
```

Only the configured cookie names from `tradingview.com` domains are imported. The default allowlist is `sessionid`, `sessionid_sign`, and `device_t`; unrelated preference, analytics, and third-party cookies are discarded. Expired, empty, or oversized cookies are discarded. The file must be non-empty, smaller than 1 MiB, and owner-only on POSIX systems.

Storage-state local storage is removed by default, including data from valid TradingView origins. A workflow can opt in to individual keys with a comma-separated `TRADINGVIEW_BROWSER_AUTH_STORAGE_KEYS` allowlist. Configure only one of `TRADINGVIEW_BROWSER_AUTH_STATE` and `TRADINGVIEW_BROWSER_COOKIE_FILE`.

Authentication values are never accepted through MCP or REST arguments, returned in results, written back to disk, or included in reported capabilities. Keep the source file outside Git and rotate the session if its values have been pasted into chat, logs, client configuration, or shell history.

## MCP workflow

For deterministic OHLCV retrieval, use the atomic operation:

```text
tradingview_get_history({symbol:"NASDAQ:AAPL", interval:"D", bars:1000, loadChart:false})
tradingview_get_history({symbol:"CME_MINI:ES1!", interval:"W", bars:750, loadChart:false})
```

MCP responses omit raw history bars and close the browser by default. Set `includeBars:true` only when raw OHLCV must enter model context, and `keepBrowserOpen:true` only for immediate follow-up work in the same Supercharts page.

It opens the requested chart, scrolls left to load the requested history, exports the official chart data, parses the most-recent requested bars, and returns normalized JSON without exposing cookies or storage state. Browser operations are serialized so concurrent REST/MCP callers cannot switch the symbol while another export is in progress. TradingView only exports bars already loaded by Supercharts, so the service repeats bounded UI scrolling/export attempts. `requestedBarsSatisfied` is false when the symbol/account has fewer available rows or the loaded history stops growing.

For interactive chart work:

1. `tradingview_open_chart({symbol:"CME_MINI:ES1!", interval:"240"})`
2. `tradingview_get_state()` to confirm `authenticated` and `delayed`
3. `tradingview_add_indicator({name:"MACD"})` as needed
4. `tradingview_export_chart({loadChart:true})` to archive official CSV and populate the local viewer
5. `chart_apply_overlays(...)` for CVD, Max Pain, expected ranges, trajectories, and markers
6. `tradingview_snapshot()` for visual inspection
7. `tradingview_close()` when finished

`layoutId` can be passed to `tradingview_open_chart` when an authenticated account should use a saved layout. Symbols, intervals, layout IDs, export filenames, and output sizes are validated before use.

## Loopback REST and CLI

With `npm run serve` running, official OHLCV history is available from the protected loopback endpoint:

```http
POST /api/tradingview/history
Content-Type: application/json

{"symbol":"NASDAQ:AAPL","interval":"M","bars":360,"loadChart":false}
```

The response is `{ "success": true, "data": { ... } }`; `data.bars` is ascending OHLCV with Unix seconds. `barCount` is the number returned, `sourceBarCount` is the row count in the official export, and `truncated` indicates whether older rows were omitted.

Daily automation can also open and capture the official chart without receiving authentication material:

```http
POST /api/tradingview/chart/open
Content-Type: application/json

{"symbol":"CME_MINI:ES1!","interval":"240","layoutId":"example_layout"}
```

```http
GET /api/tradingview/chart/state
```

```http
POST /api/tradingview/chart/snapshot
Content-Type: application/json

{"width":1440,"height":900,"chartOnly":true}
```

The snapshot response is raw `image/png`, not a JSON/base64 wrapper. Width is limited to 640-2560 and height to 480-1800. All three routes retain the API's loopback Host restriction, cross-site rejection, optional Bearer-token requirement, and `Cache-Control: no-store`. Open/state responses contain chart metadata only; request schemas reject cookie or storage-state fields.

### Optional hardened Nikkei 225 capture preset

`POST /api/tradingview/chart/capture-batch` is a deliberately specialized, fail-closed report preset retained for Nikkei 225 futures workflows. It is not the generic capture API. It accepts only `OSE:NK2251!`, the exact order `5,60,240,D,W,M`, a caller-supplied validated saved-layout ID, an 1800x850 full-viewport capture, authenticated/non-delayed requirements, and one declared overlay mode:

```json
{
  "symbol": "OSE:NK2251!",
  "intervals": ["5", "60", "240", "D", "W", "M"],
  "layoutId": "example_layout",
  "width": 1800,
  "height": 850,
  "chartOnly": false,
  "requireAuthenticated": true,
  "allowDelayed": false,
  "expectedOverlayMode": "saved_layout_pine",
  "expectedIndicator": {
    "identity": "PUB;example/indicator",
    "name": "Example Ichimoku"
  }
}
```

`expectedIndicator` is required for `builtin_ichimoku_only` and `saved_layout_pine`, and forbidden for `candles_only`. Credential-like identity/name values are rejected before a browser is acquired. Production capture creates a fresh isolated BrowserContext for each batch, clones only the filtered TradingView authentication state in memory, blocks service workers, and destroys the whole context in `finally`. It never writes storage state or cookies back to disk and never navigates the shared interactive page.

Before navigation, HTTP and WebSocket guards are installed. Chart/layout save and autosave messages are intercepted before transmission; nonessential telemetry writes are also blocked but do not make an otherwise safe capture fatal. Upgrade, trial, purchase, checkout, subscription, and payment requests or visible controls make the operation fail closed, and no such control is clicked. Read-only static assets are not classified as commerce merely because their filename contains a word such as `upgrade`.

All six navigations, UI audits, and screenshots execute inside one browser critical section. For each interval the isolated page opens Object Tree and chart settings, inventories studies/comparisons/drawings, and directly audits timezone, session, back-adjustment, and settlement controls. `candles_only` may remove structured Object Tree rows only inside the disposable context; all resulting save/autosave traffic remains blocked. Immediately before and after every screenshot the browser must prove the exact final credential-free HTTPS TradingView origin/layout URL, exact `OSE:NK2251!` chart identity from the rendered chart canvas, exactly one chart, selected interval, standard candlesticks, authenticated UI, explicit main-series real-time data, Asia/Tokyo, the OSE combined regular day-and-night session, back-adjustment off, settlement-as-close off, and complete empty comparison/drawing inventories. Study mode additionally requires exactly one study whose structured identity and name equal the request. Cached service fields, a watchlist quote's realtime label, absence of a delay label alone, URL query intent, substring indicator matches, and an incomplete DOM inventory are not accepted as observed state.

Rendered proof requires visible chart canvases, OHLC text, price/time-axis evidence, no loading surface, and stable pre/post observations. Each raw PNG is chunk/CRC/IHDR/zlib/scanline/dimension checked, PNG filters are decoded, and visually blank/uniform rasters are rejected before hashing and atomic archival under `MARKET_CHART_DATA_ROOT/tradingview-captures/<batch-id>/`. Archive directories are held through no-follow directory descriptors, files are fsynced, a cross-process publication lock serializes writers, and the temporary-directory inode is rechecked before rename. The JSON response is a credential-free manifest with requested and pre/post observed states, sanitized selector evidence, capture timestamps/skew, relative PNG paths/hashes/bytes/dimensions, and a logical identity that includes sanitized evidence values while excluding paths, timestamps, and filesystem inode metadata. `CURRENT` is a versioned JSON pointer containing both batch ID and manifest identity; it is CAS-checked and atomically replaced only after the complete batch and manifest are durable. The exported `loadCurrentTradingViewCaptureManifest` reader rejects symlinks, malformed pointers/manifests, identity mismatches, and PNG hash/size/decode failures. If failure occurs after `CURRENT` publication, restoration is verified byte-for-byte before the final batch directory is removed; if restoration cannot be verified, that final directory is retained so `CURRENT` cannot dangle.

These checks deliberately fail closed. If the current TradingView DOM does not expose a complete local audit that proves one of the required properties, the batch is rejected. The operation never opens, dismisses, or clicks an upgrade, trial, purchase, subscription, or payment control. It checks for these surfaces before and after every browser action/capture and aborts immediately when one is visible. Any permitted candles-only cleanup is local to the isolated context, and persistence attempts are blocked rather than accepted.

The standalone CLI launches the same managed browser, writes only JSON to stdout, and closes it after the export:

```bash
npm run --silent history -- --symbol NASDAQ:AAPL --interval D --bars 1000 --pretty
```

## Limits and failure behavior

Seconds intervals are selected through the chart UI because a URL with
`interval=1S` can silently leave a saved layout on one-minute bars. If the
signed-in plan does not include seconds charts, the request fails before export
and no upgrade action is attempted. One-minute history remains available through
`timeframe=1`.

- TradingView account-plan, exchange entitlement, export availability, and delayed/live status remain authoritative.
- A session with chart-data export entitlement is required; an anonymous Basic session can open the export dialog but cannot download its CSV.
- The browser uses the English TradingView origin and `en-US` browser locale. UI changes can require selector maintenance.
- Exports are capped at 50 MB and saved below `MARKET_CHART_DATA_ROOT/tradingview-exports`.
- Archive writes use a temporary file followed by an atomic rename; output names cannot contain directories.
- An export over 10,000 bars is kept intact; only its most recent 10,000 bars are loaded into the local Lightweight Charts view.
- `chart_apply_overlays` validates the entire bundle before changing chart state, so a bad item cannot leave half-applied analysis.
