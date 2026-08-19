import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadBarsFromCsv } from "./csv.js";
import { normalizeBar, parseBarTime } from "./domain.js";
import { generateDemoBars } from "./demo.js";
import { extractBars } from "./market-service.js";
import type { AppRuntime } from "./runtime.js";
import { buildTradingViewDayContext, tradingViewLookbackRange } from "./tradingview-day.js";
import {
  BarsInputSchema,
  CustomSeriesInputSchema,
  CsvImportSchema,
  IndicatorInputSchema,
  LevelInputSchema,
  MarkerInputSchema,
  OverlayBundleSchema,
  PriceInputSchema,
  QuoteBatchInputSchema,
  QuoteInputSchema,
  SearchInputSchema,
  SnapshotInputSchema,
  TechnicalAnalysisInputSchema,
  TradingViewDayInputSchema,
  TradingViewHistoryInputSchema,
  TradingViewPeriodScreenshotInputSchema,
  ViewInputSchema,
  ZoneInputSchema,
} from "./schemas.js";

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const localWrite = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const upstreamRead = { ...readOnly, openWorldHint: true } as const;
const upstreamWrite = { ...localWrite, openWorldHint: true } as const;
export const TradingViewMcpHistoryInputSchema = TradingViewHistoryInputSchema.extend({
  includeBars: z
    .boolean()
    .default(false)
    .describe(
      "Include every OHLCV bar in the MCP result. Keep false for a compact summary; the full CSV is still archived locally.",
    ),
  keepBrowserOpen: z
    .boolean()
    .default(false)
    .describe("Keep the managed browser alive for follow-up interactive tools."),
});
export const TradingViewAnalyzeInputSchema = TradingViewHistoryInputSchema.omit({
  loadChart: true,
}).extend({
  includeHistoryBars: z
    .boolean()
    .default(false)
    .describe("Include raw OHLCV bars in the response. Leave false to conserve model context."),
  keepBrowserOpen: z
    .boolean()
    .default(false)
    .describe("Keep the managed browser alive for follow-up interactive tools."),
});

export function registerTools(server: McpServer, runtime: AppRuntime): void {
  server.registerTool(
    "market_get_capabilities",
    {
      title: "Inspect market data capabilities",
      description:
        "Report configured providers, browser authentication availability, lazy-runtime state, and the currently loaded chart. Use this before choosing a data workflow.",
      inputSchema: {},
      annotations: readOnly,
    },
    async () =>
      jsonResult({
        providers: {
          tradingView: {
            enabled: runtime.tradingViewBrowser.enabled,
            authenticationConfigured: Boolean(
              runtime.config.tradingViewBrowser.authStatePath ??
                runtime.config.tradingViewBrowser.cookieFile,
            ),
            authenticationMode: runtime.config.tradingViewBrowser.authStatePath
              ? "storage-state-file"
              : runtime.config.tradingViewBrowser.cookieFile
                ? "cookie-file"
                : "none",
            credentialPolicy: {
              acceptedThroughMcp: false,
              allowedCookieNames: runtime.config.tradingViewBrowser.authCookieNames,
              allowedLocalStorageKeys: runtime.config.tradingViewBrowser.authStorageKeys,
            },
            startsOnDemand: true,
            browserActive: runtime.tradingViewBrowser.active,
          },
          rapidApi: { configured: runtime.market.upstreamConfigured },
          localCsvAndInlineData: { available: true },
        },
        viewer: { started: runtime.api.started, startsOnDemand: true },
        screenshots: { enabled: runtime.config.screenshotsEnabled, startsOnDemand: true },
        currentChart: runtime.store.getSummary(),
        recommendedTools: runtime.tradingViewBrowser.enabled
          ? [
              "tradingview_get_day",
              "tradingview_capture_period",
              "tradingview_analyze_symbol",
              "tradingview_get_history",
            ]
          : ["chart_import_csv", "chart_set_data", "chart_analyze"],
      }),
  );

  server.registerTool(
    "market_get_price",
    {
      title: "Get OHLCV price history",
      description:
        "Get OHLCV bars for a symbol from the configured data source or currently loaded local dataset. By default also loads the result into the local chart viewer.",
      inputSchema: PriceInputSchema.shape,
      annotations: upstreamWrite,
    },
    async (raw: unknown) => {
      const input = PriceInputSchema.parse(raw);
      const response = await runtime.market.price(input.symbol, input.timeframe, input.range, {
        ...(input.to ? { to: input.to } : {}),
        ...(input.type ? { type: input.type } : {}),
      });
      let chart;
      if (input.loadChart && runtime.market.upstreamConfigured) {
        const bars = extractBars(response);
        if (bars.length === 0) throw new Error("Price response contained no usable OHLCV bars.");
        chart = runtime.store.setBars({
          bars,
          symbol: input.symbol,
          interval: input.timeframe,
          source: "configured upstream provider",
        });
      }
      return jsonResult({
        response,
        ...(chart ? { chart: summarizeChart(chart) } : {}),
        ...(input.loadChart && !runtime.market.upstreamConfigured
          ? {
              chart: runtime.store.getSummary(),
              chartUnchanged: true,
            }
          : {}),
      });
    },
  );

  server.registerTool(
    "market_get_quote",
    {
      title: "Get a market quote",
      description:
        "Get one current quote and snapshot fields from the configured data source or loaded local bars.",
      inputSchema: QuoteInputSchema.shape,
      annotations: upstreamRead,
    },
    async (raw: unknown) => {
      const input = QuoteInputSchema.parse(raw);
      return jsonResult(
        await runtime.market.quote(input.symbol, {
          ...(input.session ? { session: input.session } : {}),
          ...(input.fields ? { fields: input.fields } : {}),
        }),
      );
    },
  );

  server.registerTool(
    "market_get_quotes",
    {
      title: "Get batch market quotes",
      description: "Get quotes for up to 50 symbols in one call.",
      inputSchema: QuoteBatchInputSchema.shape,
      annotations: upstreamRead,
    },
    async (raw: unknown) => {
      const input = QuoteBatchInputSchema.parse(raw);
      return jsonResult(
        await runtime.market.quoteBatch(input.symbols, {
          ...(input.session ? { session: input.session } : {}),
          ...(input.fields ? { fields: input.fields } : {}),
        }),
      );
    },
  );

  server.registerTool(
    "market_search",
    {
      title: "Search market symbols",
      description: "Search instruments by ticker or company name.",
      inputSchema: SearchInputSchema.shape,
      annotations: upstreamRead,
    },
    async (raw: unknown) => {
      const input = SearchInputSchema.parse(raw);
      return jsonResult(
        await runtime.market.search(input.query, {
          ...(input.filter ? { filter: input.filter } : {}),
          ...(input.hl !== undefined ? { hl: input.hl } : {}),
          ...(input.exchange ? { exchange: input.exchange } : {}),
          ...(input.lang ? { lang: input.lang } : {}),
          ...(input.sort_by_country !== undefined
            ? { sort_by_country: input.sort_by_country }
            : {}),
          ...(input.enable_grouping !== undefined
            ? { enable_grouping: input.enable_grouping }
            : {}),
        }),
      );
    },
  );

  server.registerTool(
    "market_get_ta",
    {
      title: "Get technical analysis",
      description:
        "Get a multi-timeframe recommendation summary, or detailed indicators when interval is set. Local mode calculates deterministic indicators from loaded bars.",
      inputSchema: TechnicalAnalysisInputSchema.shape,
      annotations: upstreamRead,
    },
    async (raw: unknown) => {
      const input = TechnicalAnalysisInputSchema.parse(raw);
      return jsonResult(await runtime.market.technicalAnalysis(input.symbol, input.interval));
    },
  );

  server.registerTool(
    "market_screen",
    {
      title: "Run a market screener",
      description:
        "Run a market screener request. Local mode returns the currently loaded symbol.",
      inputSchema: {
        request: z.record(z.string(), z.unknown()).describe("Compatible /api/screener/scan JSON body."),
      },
      annotations: upstreamRead,
    },
    async (raw: unknown) => {
      const input = z.object({ request: z.record(z.string(), z.unknown()) }).parse(raw);
      return jsonResult(await runtime.market.screenerScan(input.request));
    },
  );

  server.registerTool(
    "market_stock_snapshot",
    {
      title: "Get stock snapshots",
      description:
        "Get normalized symbol snapshots with optional news and server-side filters.",
      inputSchema: SnapshotInputSchema.shape,
      annotations: upstreamRead,
    },
    async (raw: unknown) => {
      const input = SnapshotInputSchema.parse(raw);
      return jsonResult({ items: await runtime.market.stockSnapshots(input) });
    },
  );

  server.registerTool(
    "chart_open",
    {
      title: "Open local chart viewer",
      description:
        "Return the local TradingView Lightweight Charts viewer URL. The viewer reflects chart changes made by other tools.",
      inputSchema: {},
      annotations: readOnly,
    },
    async () => {
      const api = await runtime.api.ensure();
      return jsonResult({
        viewerUrl: `${api.url}/`,
        chart: runtime.store.getSummary(),
        upstreamConfigured: runtime.market.upstreamConfigured,
        ...(runtime.config.apiToken
          ? {
              authentication:
                "Bearer protection is enabled. Open the viewer manually with your configured token; the secret is never returned through MCP.",
            }
          : {}),
      });
    },
  );

  server.registerTool(
    "chart_get_state",
    {
      title: "Get local chart state",
      description: "Get the current chart summary. Set includeBars only when raw OHLCV is needed.",
      inputSchema: { includeBars: z.boolean().default(false) },
      annotations: readOnly,
    },
    async (raw: unknown) => {
      const { includeBars } = z.object({ includeBars: z.boolean().default(false) }).parse(raw);
      return jsonResult(includeBars ? runtime.store.getState() : runtime.store.getSummary());
    },
  );

  server.registerTool(
    "chart_import_csv",
    {
      title: "Import OHLCV CSV",
      description:
        "Load a CSV under MARKET_CHART_DATA_ROOT into the chart. Required columns: time (or timestamp/date), open, high, low, close; volume is optional.",
      inputSchema: CsvImportSchema.shape,
      annotations: localWrite,
    },
    async (raw: unknown) => {
      const input = CsvImportSchema.parse(raw);
      const loaded = await loadBarsFromCsv(input.path, runtime.config.dataRoot);
      const state = runtime.store.setBars({
        bars: loaded.bars,
        symbol: input.symbol,
        interval: input.interval,
        source: `CSV:${path.basename(loaded.path)}`,
      });
      return jsonResult({ importedFile: path.basename(loaded.path), chart: summarizeChart(state) });
    },
  );

  server.registerTool(
    "chart_set_data",
    {
      title: "Set chart OHLCV data",
      description: "Replace the chart with inline, user-provided OHLCV bars (maximum 10,000).",
      inputSchema: BarsInputSchema.shape,
      annotations: localWrite,
    },
    async (raw: unknown) => {
      const input = BarsInputSchema.parse(raw);
      const bars = input.bars.map((bar) => normalizeBar(bar));
      return jsonResult(
        summarizeChart(
          runtime.store.setBars({
            bars,
            symbol: input.symbol,
            interval: input.interval,
            source: input.source,
          }),
        ),
      );
    },
  );

  server.registerTool(
    "chart_set_view",
    {
      title: "Set chart view",
      description: "Change chart metadata or theme without fetching data.",
      inputSchema: ViewInputSchema.shape,
      annotations: localWrite,
    },
    async (raw: unknown) => jsonResult(summarizeChart(runtime.store.setView(ViewInputSchema.parse(raw)))),
  );

  server.registerTool(
    "chart_add_indicator",
    {
      title: "Add chart indicator",
      description: "Add or replace an SMA, EMA, Bollinger Bands, RSI, or MACD study.",
      inputSchema: IndicatorInputSchema.shape,
      annotations: localWrite,
    },
    async (raw: unknown) => jsonResult(runtime.store.addIndicator(IndicatorInputSchema.parse(raw))),
  );

  server.registerTool(
    "chart_remove_indicator",
    {
      title: "Remove chart indicator",
      description: "Remove an indicator by id.",
      inputSchema: { id: z.string().min(1).max(100) },
      annotations: localWrite,
    },
    async (raw: unknown) => {
      const { id } = z.object({ id: z.string().min(1).max(100) }).parse(raw);
      return jsonResult({ id, removed: runtime.store.removeIndicator(id) });
    },
  );

  server.registerTool(
    "chart_add_level",
    {
      title: "Add price level",
      description: "Add a labeled horizontal support, resistance, stop, or target level.",
      inputSchema: LevelInputSchema.shape,
      annotations: localWrite,
    },
    async (raw: unknown) => jsonResult(runtime.store.addLevel(LevelInputSchema.parse(raw))),
  );

  server.registerTool(
    "chart_remove_level",
    {
      title: "Remove price level",
      description: "Remove a labeled horizontal price level by id.",
      inputSchema: { id: z.string().min(1).max(100) },
      annotations: localWrite,
    },
    async (raw: unknown) => {
      const { id } = z.object({ id: z.string().min(1).max(100) }).parse(raw);
      return jsonResult({ id, removed: runtime.store.removeLevel(id) });
    },
  );

  server.registerTool(
    "chart_add_series",
    {
      title: "Add custom chart series",
      description:
        "Add or replace a time-aligned line or histogram series. Price overlays, CVD panes, expected paths, max-pain history, and option-flow series are supported.",
      inputSchema: CustomSeriesInputSchema.shape,
      annotations: localWrite,
    },
    async (raw: unknown) => {
      const input = CustomSeriesInputSchema.parse(raw);
      return jsonResult(runtime.store.addCustomSeries(normalizeCustomSeries(input)));
    },
  );

  server.registerTool(
    "chart_remove_series",
    {
      title: "Remove custom chart series",
      description: "Remove a custom line or histogram series by id.",
      inputSchema: { id: z.string().min(1).max(100) },
      annotations: localWrite,
    },
    async (raw: unknown) => {
      const { id } = z.object({ id: z.string().min(1).max(100) }).parse(raw);
      return jsonResult({ id, removed: runtime.store.removeCustomSeries(id) });
    },
  );

  server.registerTool(
    "chart_add_zone",
    {
      title: "Add chart price zone",
      description:
        "Add or replace a shaded time/price zone for demand, supply, expected ranges, or invalidation areas.",
      inputSchema: ZoneInputSchema.shape,
      annotations: localWrite,
    },
    async (raw: unknown) => jsonResult(runtime.store.addZone(ZoneInputSchema.parse(raw))),
  );

  server.registerTool(
    "chart_remove_zone",
    {
      title: "Remove chart price zone",
      description: "Remove a shaded chart zone by id.",
      inputSchema: { id: z.string().min(1).max(100) },
      annotations: localWrite,
    },
    async (raw: unknown) => {
      const { id } = z.object({ id: z.string().min(1).max(100) }).parse(raw);
      return jsonResult({ id, removed: runtime.store.removeZone(id) });
    },
  );

  server.registerTool(
    "chart_add_marker",
    {
      title: "Add chart event marker",
      description:
        "Add or replace a marker for SQ, signal confirmation, participant-flow events, or scenario triggers.",
      inputSchema: MarkerInputSchema.shape,
      annotations: localWrite,
    },
    async (raw: unknown) => jsonResult(runtime.store.addMarker(MarkerInputSchema.parse(raw))),
  );

  server.registerTool(
    "chart_remove_marker",
    {
      title: "Remove chart marker",
      description: "Remove a chart marker by id.",
      inputSchema: { id: z.string().min(1).max(100) },
      annotations: localWrite,
    },
    async (raw: unknown) => {
      const { id } = z.object({ id: z.string().min(1).max(100) }).parse(raw);
      return jsonResult({ id, removed: runtime.store.removeMarker(id) });
    },
  );

  server.registerTool(
    "chart_apply_overlays",
    {
      title: "Apply an analysis overlay bundle",
      description:
        "Atomically apply indicators, levels, custom series, zones, and markers so clients never observe a half-updated analysis workspace.",
      inputSchema: OverlayBundleSchema.shape,
      annotations: localWrite,
    },
    async (raw: unknown) => {
      const input = OverlayBundleSchema.parse(raw);
      const state = runtime.store.applyOverlayBundle({
        replace: input.replace,
        ...(input.indicators ? { indicators: input.indicators } : {}),
        ...(input.levels ? { levels: input.levels } : {}),
        ...(input.customSeries
          ? { customSeries: input.customSeries.map((entry) => normalizeCustomSeries(entry)) }
          : {}),
        ...(input.zones ? { zones: input.zones } : {}),
        ...(input.markers ? { markers: input.markers } : {}),
      });
      return jsonResult(summarizeChart(state));
    },
  );

  server.registerTool(
    "chart_clear_overlays",
    {
      title: "Clear all analysis overlays",
      description: "Remove indicators, levels, custom series, zones, and markers in one operation.",
      inputSchema: {},
      annotations: localWrite,
    },
    async () => jsonResult(summarizeChart(runtime.store.clearOverlays())),
  );

  server.registerTool(
    "chart_analyze",
    {
      title: "Analyze current chart",
      description:
        "Calculate deterministic trend, SMA/EMA, RSI, MACD, Bollinger Bands, ATR, signals, and support/resistance from the current bars. This is not investment advice.",
      inputSchema: {},
      annotations: readOnly,
    },
    async () => jsonResult(runtime.market.analyzeCurrent()),
  );

  server.registerTool(
    "chart_snapshot",
    {
      title: "Capture chart image",
      description:
        "Render the local chart viewer in an isolated headless browser and return a PNG for visual analysis. The browser and ephemeral viewer close afterward unless keepRuntimeOpen is true.",
      inputSchema: {
        width: z.number().int().min(640).max(2_400).default(1_440),
        height: z.number().int().min(480).max(1_600).default(900),
        keepRuntimeOpen: z.boolean().default(false),
      },
      annotations: readOnly,
    },
    async (raw: unknown) => {
      const input = z
        .object({
          width: z.number().int().min(640).max(2_400).default(1_440),
          height: z.number().int().min(480).max(1_600).default(900),
          keepRuntimeOpen: z.boolean().default(false),
        })
        .parse(raw);
      const api = await runtime.api.ensure();
      try {
        const png = await runtime.screenshots.capture(api.url, {
          width: input.width,
          height: input.height,
          ...(runtime.config.apiToken ? { token: runtime.config.apiToken } : {}),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Local chart capture for ${runtime.store.getSummary().symbol} (${input.width}x${input.height}).`,
            },
            { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
          ],
        };
      } finally {
        if (!input.keepRuntimeOpen) {
          await Promise.allSettled([runtime.screenshots.close(), runtime.api.close()]);
        }
      }
    },
  );

  server.registerTool(
    "chart_load_demo",
    {
      title: "Load deterministic demo chart",
      description: "Reset the chart to deterministic synthetic OHLCV for testing and onboarding.",
      inputSchema: {
        count: z.number().int().min(30).max(10_000).default(320),
        seed: z.number().int().optional(),
        symbol: z.string().min(1).max(80).default("DEMO:MARKET"),
        interval: z.string().min(1).max(10).default("60"),
      },
      annotations: localWrite,
    },
    async (raw: unknown) => {
      const input = z
        .object({
          count: z.number().int().min(30).max(10_000).default(320),
          seed: z.number().int().optional(),
          symbol: z.string().min(1).max(80).default("DEMO:MARKET"),
          interval: z.string().min(1).max(10).default("60"),
        })
        .parse(raw);
      const state = runtime.store.setBars({
        bars: generateDemoBars(input.count, input.seed === undefined ? {} : { seed: input.seed }),
        symbol: input.symbol,
        interval: input.interval,
        source: "synthetic-demo",
      });
      return jsonResult(summarizeChart(state));
    },
  );

  server.registerTool(
    "tradingview_get_history",
    {
      title: "Get official TradingView OHLCV history",
      description:
        "Open an official TradingView symbol/interval, export chart data through Supercharts, archive the CSV, and return a compact summary by default. Set includeBars only when raw OHLCV must enter model context. The browser closes after the operation unless keepBrowserOpen is true. Supports minute, daily, weekly, and monthly intervals. No account upgrade action is attempted.",
      inputSchema: TradingViewMcpHistoryInputSchema.shape,
      annotations: upstreamWrite,
    },
    async (raw: unknown) => {
      const input = TradingViewMcpHistoryInputSchema.parse(raw);
      return jsonResult(
        await getTradingViewHistoryForMcp(runtime.tradingViewBrowser, input),
      );
    },
  );

  server.registerTool(
    "tradingview_analyze_symbol",
    {
      title: "Analyze an official TradingView symbol",
      description:
        "Recommended one-call workflow: fetch and archive official TradingView OHLCV, load it into the local chart, and return deterministic technical analysis with source and delay metadata. The browser closes afterward unless keepBrowserOpen is true.",
      inputSchema: TradingViewAnalyzeInputSchema.shape,
      annotations: upstreamWrite,
    },
    async (raw: unknown) => {
      const input = TradingViewAnalyzeInputSchema.parse(raw);
      return jsonResult(
        await analyzeTradingViewSymbolForMcp(
          runtime.tradingViewBrowser,
          () => runtime.market.analyzeCurrent(),
          input,
        ),
      );
    },
  );

  server.registerTool(
    "tradingview_get_day",
    {
      title: "Get comprehensive TradingView data for one date",
      description:
        "Recommended one-call historical-date workflow. Navigate official TradingView Supercharts to the requested date, export OHLCV through the chart UI, and return the matching session or intraday aggregate, prior/next bars when available, price changes, gaps, ranges, volume, rolling performance, and deterministic technical analysis. Non-trading days return an explicit no_session_bar status instead of substituting another date.",
      inputSchema: TradingViewDayInputSchema.shape,
      annotations: upstreamWrite,
    },
    async (raw: unknown) => {
      const input = TradingViewDayInputSchema.parse(raw);
      return jsonResult(await getTradingViewDayForMcp(runtime.tradingViewBrowser, input));
    },
  );

  server.registerTool(
    "tradingview_capture_period",
    {
      title: "Capture a TradingView chart for an exact date range",
      description:
        "Open an official TradingView symbol and interval, use the Supercharts Custom range control for the requested YYYY-MM-DD dates, and return the resulting chart as a PNG in one call. The browser closes by default and authentication remains local.",
      inputSchema: TradingViewPeriodScreenshotInputSchema.shape,
      annotations: upstreamRead,
    },
    async (raw: unknown) => {
      const input = TradingViewPeriodScreenshotInputSchema.parse(raw);
      const capture = await captureTradingViewPeriodForMcp(
        runtime.tradingViewBrowser,
        input,
      );
      const { png, ...metadata } = capture;
      return {
        content: [
          {
            type: "text" as const,
            text: `TradingView chart capture for ${metadata.state.symbol} ${metadata.state.interval}, ${metadata.requestedRange.from} through ${metadata.requestedRange.to}.`,
          },
          { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
        ],
        structuredContent: {
          ...metadata,
          image: { mimeType: "image/png", bytes: png.byteLength },
        },
      };
    },
  );

  server.registerTool(
    "tradingview_open_chart",
    {
      title: "Open TradingView Supercharts",
      description:
        "Open the official TradingView Supercharts UI for a validated symbol and interval. Optional authentication is loaded only from the configured local state/cookie file and is never returned.",
      inputSchema: {
        symbol: z.string().min(1).max(100),
        interval: z.string().min(1).max(10).default("240"),
        layoutId: z.string().min(4).max(40).optional(),
      },
      annotations: upstreamWrite,
    },
    async (raw: unknown) => {
      const input = z
        .object({
          symbol: z.string().min(1).max(100),
          interval: z.string().min(1).max(10).default("240"),
          layoutId: z.string().min(4).max(40).optional(),
        })
        .parse(raw);
      return jsonResult(await runtime.tradingViewBrowser.openChart(input));
    },
  );

  server.registerTool(
    "tradingview_get_state",
    {
      title: "Inspect TradingView Supercharts state",
      description:
        "Read the current official chart URL, symbol, interval, authentication state, and delayed-data flag without exposing cookies.",
      inputSchema: {},
      annotations: upstreamRead,
    },
    async () => jsonResult(await runtime.tradingViewBrowser.getState()),
  );

  server.registerTool(
    "tradingview_add_indicator",
    {
      title: "Add a TradingView indicator",
      description:
        "Use the official Supercharts indicator dialog to add an exact built-in or user-visible indicator by name.",
      inputSchema: { name: z.string().min(1).max(120) },
      annotations: upstreamWrite,
    },
    async (raw: unknown) => {
      const { name } = z.object({ name: z.string().min(1).max(120) }).parse(raw);
      return jsonResult(await runtime.tradingViewBrowser.addIndicator(name));
    },
  );

  server.registerTool(
    "tradingview_export_chart",
    {
      title: "Export TradingView chart data",
      description:
        "Download the data currently loaded in official Supercharts through its chart-data export UI, including visible indicator columns. Optionally load OHLCV into the local chart for deterministic analysis.",
      inputSchema: {
        loadChart: z.boolean().default(true),
        outputName: z.string().min(5).max(124).optional(),
      },
      annotations: upstreamWrite,
    },
    async (raw: unknown) => {
      const input = z
        .object({ loadChart: z.boolean().default(true), outputName: z.string().min(5).max(124).optional() })
        .parse(raw);
      return jsonResult(await runtime.tradingViewBrowser.exportChartData(input));
    },
  );

  server.registerTool(
    "tradingview_snapshot",
    {
      title: "Capture TradingView Supercharts",
      description:
        "Capture the official TradingView chart region or viewport for visual analysis. Authentication details are excluded from the result.",
      inputSchema: {
        width: z.number().int().min(640).max(2_560).default(1_440),
        height: z.number().int().min(480).max(1_800).default(900),
        chartOnly: z.boolean().default(true),
      },
      annotations: upstreamRead,
    },
    async (raw: unknown) => {
      const input = z
        .object({
          width: z.number().int().min(640).max(2_560).default(1_440),
          height: z.number().int().min(480).max(1_800).default(900),
          chartOnly: z.boolean().default(true),
        })
        .parse(raw);
      const [png, state] = await Promise.all([
        runtime.tradingViewBrowser.snapshot(input),
        runtime.tradingViewBrowser.getState(),
      ]);
      return {
        content: [
          { type: "text" as const, text: `TradingView Supercharts capture: ${state.symbol} ${state.interval}` },
          { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
        ],
        structuredContent: { ...state },
      };
    },
  );

  server.registerTool(
    "tradingview_close",
    {
      title: "Close TradingView Supercharts browser",
      description:
        "Close the managed TradingView browser, context, and page. Authentication files remain local and untouched.",
      inputSchema: {},
      annotations: localWrite,
    },
    async () => {
      await runtime.tradingViewBrowser.close();
      return jsonResult({ closed: true });
    },
  );
}

export async function getTradingViewHistoryForMcp(
  browser: Pick<AppRuntime["tradingViewBrowser"], "close" | "getHistory">,
  input: z.infer<typeof TradingViewMcpHistoryInputSchema>,
) {
  const { includeBars, keepBrowserOpen, ...historyInput } = input;
  try {
    const history = await browser.getHistory(historyInput);
    return historyResult(history, includeBars);
  } finally {
    if (!keepBrowserOpen) await browser.close();
  }
}

export async function analyzeTradingViewSymbolForMcp(
  browser: Pick<AppRuntime["tradingViewBrowser"], "close" | "getHistory">,
  analyzeCurrent: () => unknown,
  input: z.infer<typeof TradingViewAnalyzeInputSchema>,
) {
  const { includeHistoryBars, keepBrowserOpen, ...historyInput } = input;
  try {
    const history = await browser.getHistory({ ...historyInput, loadChart: true });
    return {
      history: historyResult(history, includeHistoryBars),
      analysis: analyzeCurrent(),
    };
  } finally {
    if (!keepBrowserOpen) await browser.close();
  }
}

export async function getTradingViewDayForMcp(
  browser: Pick<AppRuntime["tradingViewBrowser"], "close" | "getDateRangeHistory">,
  input: z.infer<typeof TradingViewDayInputSchema>,
) {
  const {
    date,
    timezone,
    lookbackBars,
    includeBars,
    keepBrowserOpen,
    ...chartInput
  } = input;
  const requestedRange = tradingViewLookbackRange(date, chartInput.interval, lookbackBars);
  try {
    const history = await browser.getDateRangeHistory({
      ...chartInput,
      ...requestedRange,
      bars: lookbackBars,
    });
    return buildTradingViewDayContext(history, { date, timezone, includeBars });
  } finally {
    if (!keepBrowserOpen) await browser.close();
  }
}

export async function captureTradingViewPeriodForMcp(
  browser: Pick<AppRuntime["tradingViewBrowser"], "capturePeriod" | "close">,
  input: z.infer<typeof TradingViewPeriodScreenshotInputSchema>,
) {
  const { keepBrowserOpen, ...captureInput } = input;
  try {
    return await browser.capturePeriod(captureInput);
  } finally {
    if (!keepBrowserOpen) await browser.close();
  }
}

function historyResult(
  history: Awaited<ReturnType<AppRuntime["tradingViewBrowser"]["getHistory"]>>,
  includeBars: boolean,
) {
  if (includeBars) return history;
  const { bars: _bars, ...summary } = history;
  return summary;
}

function normalizeCustomSeries(input: z.infer<typeof CustomSeriesInputSchema>) {
  return {
    ...input,
    data: input.data.map((point) => ({
      time: parseBarTime(point.time),
      value: point.value,
      ...(point.color ? { color: point.color } : {}),
    })),
  };
}

function summarizeChart(state: ReturnType<AppRuntime["store"]["getState"]>) {
  return {
    symbol: state.symbol,
    interval: state.interval,
    source: state.source,
    barCount: state.bars.length,
    revision: state.revision,
    updatedAt: state.updatedAt,
    overlayCounts: {
      indicators: state.indicators.length,
      levels: state.levels.length,
      customSeries: state.customSeries.length,
      zones: state.zones.length,
      markers: state.markers.length,
    },
    firstBar: state.bars[0],
    lastBar: state.bars.at(-1),
  };
}

function jsonResult(value: unknown) {
  const structuredContent =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { result: value };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent,
  };
}
