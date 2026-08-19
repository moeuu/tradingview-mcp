# REST API

Base URL: `http://127.0.0.1:4317`

成功レスポンスは原則 `{ "success": true, "data": ... }`、エラーは次の形です。

```json
{
  "success": false,
  "error": { "code": "INVALID_INPUT", "message": "..." }
}
```

`MARKET_CHART_API_TOKEN`を設定した場合、health以外のAPIへ次のheaderを付けます。

```http
Authorization: Bearer <token>
```

viewerは `http://127.0.0.1:4317/#token=<URL-encoded token>` で開けます。tokenは初期読込時にmemoryへ移されてaddress barから消え、同一originのAPIへBearer headerとして付けられます。serverへURLの一部としては送信されません。

## Market data

```bash
# Current + history（default: timeframe=5, range=10）
curl 'http://127.0.0.1:4317/api/price/DEMO:MARKET?timeframe=60&range=100'

# OHLCV専用route
curl 'http://127.0.0.1:4317/api/price/ohlcv/DEMO:MARKET?timeframe=60&range=100&strictTo=false'

# Quote
curl 'http://127.0.0.1:4317/api/quote/DEMO:MARKET'

# Batch quote
curl -X POST http://127.0.0.1:4317/api/quote/batch \
  -H 'content-type: application/json' \
  -d '{"symbols":["DEMO:MARKET"]}'

# Symbol search
curl 'http://127.0.0.1:4317/api/search/market/DEMO'

# Detailed TA
curl 'http://127.0.0.1:4317/api/ta/DEMO:MARKET/indicators?interval=60'
```

When `TRADINGVIEW_BROWSER_ENABLED=true`, the existing `GET /api/price/ohlcv/:symbol` contract automatically uses authenticated Supercharts export for `timeframe=1`, `240`, `D`, `W`, or `M`. Its response remains `{success,data:{symbol,current,history,info},msg}` with reverse-chronological `history` and `max`/`min` aliases, so existing `extractBars` consumers continue to work. `to` and `strictTo` are accepted for compatibility but are not applied by the browser route; `data.info.toApplied` is `false`, and callers that need an as-of date should filter the returned Unix times.

## Official TradingView history

This route operates the configured TradingView Supercharts browser and returns OHLCV JSON in one request. It is loopback-only and requires the configured Bearer token when `MARKET_CHART_API_TOKEN` is set.

```bash
curl -X POST http://127.0.0.1:4317/api/tradingview/history \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <token>' \
  -d '{"symbol":"NASDAQ:AAPL","interval":"W","bars":750,"loadChart":false}'
```

Request fields:

- `symbol` (required): validated TradingView symbol such as `NASDAQ:AAPL` or `CME_MINI:ES1!`
- `interval`: TradingView interval; default `D`, with `D`, `W`, and `M` supported
- `bars`: most-recent rows to return, `1..10000`; default `1000`
- `layoutId`: optional saved-layout id
- `loadChart`: also publish returned bars to the local viewer; default `false`
- `outputName`: optional simple `.csv` archive name without directories

Success data contains `symbol`, `interval`, `authenticated`, `delayed`, `requestedBars`, `requestedBarsSatisfied`, `barCount`, `sourceBarCount`, `truncated`, relative `file`, `bytes`, `firstBar`, `lastBar`, and ascending `bars`. Each bar uses Unix seconds and numeric `open`, `high`, `low`, `close`, with optional `volume`. `requestedBarsSatisfied=false` means fewer bars were available/loaded; `truncated=true` means older rows existed in the export but were intentionally omitted from the response.

## Official TradingView chart PNG

The managed official chart can also be opened and captured through protected loopback routes. Authentication material is loaded only by the server; cookies and storage-state values are neither accepted by these requests nor returned by their responses.

```bash
# 1. Open the validated symbol, interval, and optional saved layout.
curl -X POST http://127.0.0.1:4317/api/tradingview/chart/open \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <token>' \
  -d '{"symbol":"CME_MINI:ES1!","interval":"240","layoutId":"example_layout"}'

# 2. Optional safe state inspection (no cookie or storage-state values).
curl http://127.0.0.1:4317/api/tradingview/chart/state \
  -H 'authorization: Bearer <token>'

# 3. Save the official chart region directly as PNG.
curl -X POST http://127.0.0.1:4317/api/tradingview/chart/snapshot \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <token>' \
  -d '{"width":1440,"height":900,"chartOnly":true}' \
  --output tradingview-chart.png
```

`open` accepts the same validated TradingView symbol and interval forms as the browser history route; `layoutId` is limited to 4–40 ASCII letters, digits, `_`, or `-`. `snapshot` returns raw `image/png` with `Cache-Control: no-store`. `width` is bounded to `640..2560`, `height` to `480..1800`, and `chartOnly` defaults to `true`. The existing loopback Host check, cross-site request rejection, and configured Bearer authentication apply to all three routes.

For the report-grade six-panel batch, use the stricter JSON endpoint:

```bash
curl -X POST http://127.0.0.1:4317/api/tradingview/chart/capture-batch \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <token>' \
  -d '{
    "symbol":"OSE:NK2251!",
    "intervals":["5","60","240","D","W","M"],
    "layoutId":"example_layout",
    "width":1800,
    "height":850,
    "chartOnly":false,
    "requireAuthenticated":true,
    "allowDelayed":false,
    "expectedOverlayMode":"candles_only"
  }'
```

The fixed fields and ordering are literal schema requirements. Other overlay values are `builtin_ichimoku_only` and `saved_layout_pine`; both require `expectedIndicator:{identity,name}`. Success returns a credential-free JSON manifest and six relative PNG archive paths. Capture uses a disposable read-only page, requires the exact final HTTPS TradingView layout URL, exact symbol and indicator identities, explicit real-time evidence, one chart, and complete overlay/comparison/drawing inventories. Every visible surface in every page frame is scanned for upgrade/trial/purchase/payment text. Any mismatch, unknown DOM setting, incomplete inventory, invalid decoded PNG, or forbidden commerce surface fails the whole request without publishing a new `CURRENT`. `CURRENT` is a versioned JSON pointer bound to the manifest identity and is read back with manifest/PNG hash validation before success is returned.

## Local chart

```bash
# State / project-native detailed analysis
curl http://127.0.0.1:4317/api/chart/state
curl http://127.0.0.1:4317/api/chart/analysis

# Add an indicator
curl -X POST http://127.0.0.1:4317/api/chart/indicators \
  -H 'content-type: application/json' \
  -d '{"id":"ema-21","kind":"ema","period":21,"color":"#22c55e"}'

# Add support level
curl -X POST http://127.0.0.1:4317/api/chart/levels \
  -H 'content-type: application/json' \
  -d '{"id":"support-1","price":100,"label":"Support","color":"#a78bfa"}'

# Atomically replace all analysis overlays
curl -X POST http://127.0.0.1:4317/api/chart/overlays \
  -H 'content-type: application/json' \
  -d '{
    "replace":true,
    "indicators":[{"id":"roman-lines","kind":"bollinger","period":25,"standardDeviations":1}],
    "levels":[{"id":"pain","price":67000,"label":"Max Pain","color":"#a78bfa"}],
    "customSeries":[{
      "id":"cvd","kind":"histogram","label":"CVD","pane":"cvd",
      "color":"#38bdf8","lineWidth":2,"lineStyle":"solid",
      "data":[{"time":1783990800,"value":1200,"color":"#22c55e"}]
    }],
    "zones":[{
      "id":"daily-range","startTime":1783990800,"endTime":1784077200,
      "upper":67500,"lower":66000,"label":"Daily range","color":"#ef4444"
    }],
    "markers":[{
      "id":"signal","time":1783990800,"position":"belowBar","shape":"arrowUp",
      "color":"#22c55e","text":"押し目買い候補"
    }]
  }'

# Clear indicator/level/series/zone/marker overlays together
curl -X DELETE http://127.0.0.1:4317/api/chart/overlays

# Import CSV inside MARKET_CHART_DATA_ROOT
curl -X POST http://127.0.0.1:4317/api/chart/import-csv \
  -H 'content-type: application/json' \
  -d '{"path":"bars.csv","symbol":"NASDAQ:AAPL","interval":"60"}'
```

The viewer polls chart state and analysis, so changes appear without reloading the page.

Individual mutation routes are also available at `/api/chart/series`, `/api/chart/zones`, and `/api/chart/markers`; delete an item with `DELETE /api/chart/<collection>/<id>`.
