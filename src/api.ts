import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { AppConfig } from "./config.js";
import { loadBarsFromCsv } from "./csv.js";
import { normalizeBar, parseBarTime } from "./domain.js";
import { generateDemoBars } from "./demo.js";
import type { ChartStore } from "./chart-store.js";
import type { MarketService } from "./market-service.js";
import { UpstreamError } from "./rapidapi.js";
import type {
  TradingViewBrowserService,
  TradingViewHistoryResult,
} from "./tradingview-browser.js";
import {
  BarsInputSchema,
  CustomSeriesInputSchema,
  CsvImportSchema,
  IndicatorInputSchema,
  LevelInputSchema,
  MarkerInputSchema,
  OverlayBundleSchema,
  QuoteBatchInputSchema,
  SnapshotInputSchema,
  TradingViewCaptureBatchInputSchema,
  TradingViewHistoryInputSchema,
  TradingViewOpenChartInputSchema,
  TradingViewSnapshotInputSchema,
  ViewInputSchema,
  ZoneInputSchema,
} from "./schemas.js";

export interface ApiDependencies {
  config: AppConfig;
  store: ChartStore;
  market: MarketService;
  tradingViewBrowser: Pick<
    TradingViewBrowserService,
    "captureBatch" | "getHistory" | "openChart" | "getState" | "snapshot"
  >;
}

export interface StartedApi {
  app: FastifyInstance;
  url: string;
  close(): Promise<void>;
}

export async function createApiServer(dependencies: ApiDependencies): Promise<FastifyInstance> {
  const { config, store, market, tradingViewBrowser } = dependencies;
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024, trustProxy: false });

  app.addHook("onRequest", async (request, reply) => {
    const routePath = request.routeOptions.url ?? request.url;
    if (!isAllowedHost(request.headers.host)) {
      await reply.code(421).send(errorEnvelope("INVALID_HOST", "Loopback Host header required."));
      return;
    }
    if (isProtectedPath(routePath) && request.headers["sec-fetch-site"] === "cross-site") {
      return reply
        .code(403)
        .send(errorEnvelope("CROSS_SITE_REQUEST", "Cross-site browser API requests are blocked."));
    }
    if (
      config.apiToken &&
      isProtectedPath(routePath) &&
      routePath !== "/api/health" &&
      request.headers.authorization !== `Bearer ${config.apiToken}`
    ) {
      return reply.code(401).send(errorEnvelope("UNAUTHORIZED", "Valid Bearer token required."));
    }
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cache-control", "no-store");
    reply.header(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'sha256-3pRED1tOXas1FXFoPb9TGCjmYe9XQsmO9OV23khV2nY='; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    return payload;
  });

  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof UpstreamError ? error.status ?? 502 : 400;
    const code =
      error instanceof UpstreamError
        ? "UPSTREAM_ERROR"
        : error instanceof ZodError
          ? "INVALID_INPUT"
          : "REQUEST_FAILED";
    void reply.code(status).send(errorEnvelope(code, safeErrorMessage(error)));
  });

  app.get("/api/health", async () => ({
    success: true,
    data: {
      status: "ok",
      service: "market-chart-mcp",
      upstreamConfigured: market.upstreamConfigured,
      tradingViewBrowserEnabled: config.tradingViewBrowser.enabled,
      revision: store.getSummary().revision,
    },
  }));

  app.post("/api/tradingview/history", async (request) => {
    const input = TradingViewHistoryInputSchema.parse(request.body);
    return { success: true, data: await tradingViewBrowser.getHistory(input) };
  });

  app.post("/api/tradingview/chart/open", async (request) => {
    const input = TradingViewOpenChartInputSchema.parse(request.body);
    return { success: true, data: await tradingViewBrowser.openChart(input) };
  });

  app.get("/api/tradingview/chart/state", async () => ({
    success: true,
    data: await tradingViewBrowser.getState(),
  }));

  app.post("/api/tradingview/chart/snapshot", async (request, reply) => {
    const input = TradingViewSnapshotInputSchema.parse(request.body ?? {});
    const png = await tradingViewBrowser.snapshot(input);
    return reply
      .type("image/png")
      .header("content-length", String(png.byteLength))
      .send(png);
  });

  app.post("/api/tradingview/chart/capture-batch", async (request) => {
    const input = TradingViewCaptureBatchInputSchema.parse(request.body);
    return { success: true, data: await tradingViewBrowser.captureBatch(input) };
  });

  // Market data endpoints.
  app.get("/api/price/:symbol", async (request) => {
    const { symbol } = request.params as { symbol: string };
    const query = request.query as Record<string, string | undefined>;
    return market.price(
      symbol,
      query.timeframe ?? "5",
      parseInteger(query.range, 10),
      {
        ...(query.to ? { to: parseInteger(query.to) } : {}),
        ...(query.type ? { type: query.type } : {}),
      },
    );
  });

  app.get("/api/price/ohlcv/:symbol", async (request) => {
    const { symbol } = request.params as { symbol: string };
    const query = request.query as Record<string, string | undefined>;
    const timeframe = query.timeframe ?? "5";
    const range = parseInteger(query.range, 10);
    const to = query.to ? parseInteger(query.to) : undefined;
    const strictTo = query.strictTo ? parseQueryBoolean(query.strictTo) : undefined;
    if (
      config.tradingViewBrowser.enabled &&
      ["1", "5", "60", "240", "D", "W", "M"].includes(timeframe.toUpperCase())
    ) {
      const input = TradingViewHistoryInputSchema.parse({
        symbol,
        interval: timeframe,
        bars: range,
        loadChart: false,
      });
      const history = await tradingViewBrowser.getHistory(input);
      return tradingViewOhlcvCompatibilityResponse(history, to, strictTo);
    }
    return market.ohlcv(symbol, timeframe, range, {
      ...(to !== undefined ? { to } : {}),
      ...(strictTo !== undefined ? { strictTo } : {}),
    });
  });

  app.post("/api/price/batch", async (request) => {
    const body = request.body as { requests?: Array<Record<string, unknown>> };
    const requests = (body.requests ?? []).map((entry) => ({
      symbol: String(entry.symbol ?? ""),
      ...(entry.timeframe !== undefined ? { timeframe: String(entry.timeframe) } : {}),
      ...(entry.range !== undefined ? { range: Number(entry.range) } : {}),
      ...(entry.type !== undefined ? { type: String(entry.type) } : {}),
    }));
    return market.priceBatch(requests);
  });

  app.get("/api/quote/:symbol", async (request) => {
    const { symbol } = request.params as { symbol: string };
    const query = request.query as Record<string, string | undefined>;
    return market.quote(symbol, {
      ...(query.session ? { session: query.session } : {}),
      ...(query.fields ? { fields: query.fields } : {}),
    });
  });

  app.post("/api/quote/batch", async (request) => {
    const input = QuoteBatchInputSchema.parse(request.body);
    return market.quoteBatch(input.symbols, {
      ...(input.session ? { session: input.session } : {}),
      ...(input.fields ? { fields: input.fields } : {}),
    });
  });

  app.get("/api/search/market/:query", async (request) => {
    const { query: text } = request.params as { query: string };
    const query = request.query as Record<string, string | undefined>;
    return market.search(text, {
      ...(query.filter ? { filter: query.filter } : {}),
      ...(query.hl ? { hl: parseEnumInteger(query.hl, [0, 1], "hl") } : {}),
      ...(query.exchange ? { exchange: query.exchange } : {}),
      ...(query.lang ? { lang: query.lang } : {}),
      ...(query.sort_by_country ? { sort_by_country: query.sort_by_country } : {}),
      ...(query.enable_grouping
        ? { enable_grouping: parseQueryBoolean(query.enable_grouping) }
        : {}),
    });
  });

  app.get("/api/ta/:symbol", async (request) => {
    const { symbol } = request.params as { symbol: string };
    return market.technicalAnalysis(symbol);
  });

  app.get("/api/ta/:symbol/indicators", async (request) => {
    const { symbol } = request.params as { symbol: string };
    const query = request.query as Record<string, string | undefined>;
    return market.technicalAnalysis(symbol, query.interval ?? "1D");
  });

  app.post("/api/screener/scan", async (request) =>
    market.screenerScan(asObject(request.body ?? {}, "Screener body must be a JSON object.")),
  );

  app.get("/api/news", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    return market.news(query);
  });

  // Normalized stock snapshot endpoints.
  const actorHandler = async (body: unknown) => {
    const input = SnapshotInputSchema.parse(body);
    return market.stockSnapshots(input);
  };
  app.post("/api/actor/tradingview-stock-scraper", async (request) => actorHandler(request.body));
  app.post(
    "/v2/acts/mscraper~tradingview-stock-scraper/run-sync-get-dataset-items",
    async (request) => actorHandler(request.body),
  );

  // Local chart and analysis API used by the MCP server and viewer.
  app.get("/api/chart/state", async () => store.getState());
  app.get("/api/chart/summary", async () => store.getSummary());
  app.get("/api/chart/analysis", async () => market.analyzeCurrent());

  app.post("/api/chart/data", async (request) => {
    const input = BarsInputSchema.parse(request.body);
    const bars = input.bars.map((bar) => normalizeBar(bar));
    return store.setBars({ bars, symbol: input.symbol, interval: input.interval, source: input.source });
  });

  app.post("/api/chart/import-csv", async (request) => {
    const input = CsvImportSchema.parse(request.body);
    const loaded = await loadBarsFromCsv(input.path, config.dataRoot);
    const state = store.setBars({
      bars: loaded.bars,
      symbol: input.symbol,
      interval: input.interval,
      source: `CSV:${path.basename(loaded.path)}`,
    });
    return { ...state, importedPath: loaded.path };
  });

  app.patch("/api/chart/view", async (request) => store.setView(ViewInputSchema.parse(request.body)));
  app.post("/api/chart/indicators", async (request) =>
    store.addIndicator(IndicatorInputSchema.parse(request.body)),
  );
  app.delete("/api/chart/indicators/:id", async (request) => ({
    removed: store.removeIndicator((request.params as { id: string }).id),
  }));
  app.delete("/api/chart/indicators", async () => store.clearIndicators());
  app.post("/api/chart/levels", async (request) =>
    store.addLevel(LevelInputSchema.parse(request.body)),
  );
  app.delete("/api/chart/levels/:id", async (request) => ({
    removed: store.removeLevel((request.params as { id: string }).id),
  }));
  app.delete("/api/chart/levels", async () => store.clearLevels());
  app.post("/api/chart/series", async (request) => {
    const input = CustomSeriesInputSchema.parse(request.body);
    return store.addCustomSeries(normalizeCustomSeries(input));
  });
  app.delete("/api/chart/series/:id", async (request) => ({
    removed: store.removeCustomSeries((request.params as { id: string }).id),
  }));
  app.post("/api/chart/zones", async (request) =>
    store.addZone(ZoneInputSchema.parse(request.body)),
  );
  app.delete("/api/chart/zones/:id", async (request) => ({
    removed: store.removeZone((request.params as { id: string }).id),
  }));
  app.post("/api/chart/markers", async (request) =>
    store.addMarker(MarkerInputSchema.parse(request.body)),
  );
  app.delete("/api/chart/markers/:id", async (request) => ({
    removed: store.removeMarker((request.params as { id: string }).id),
  }));
  app.post("/api/chart/overlays", async (request) => {
    const input = OverlayBundleSchema.parse(request.body);
    return store.applyOverlayBundle({
      replace: input.replace,
      ...(input.indicators ? { indicators: input.indicators } : {}),
      ...(input.levels ? { levels: input.levels } : {}),
      ...(input.customSeries
        ? { customSeries: input.customSeries.map((entry) => normalizeCustomSeries(entry)) }
        : {}),
      ...(input.zones ? { zones: input.zones } : {}),
      ...(input.markers ? { markers: input.markers } : {}),
    });
  });
  app.delete("/api/chart/overlays", async () => store.clearOverlays());
  app.post("/api/chart/demo", async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const count = body.count === undefined ? 320 : parseInteger(String(body.count));
    const seed = body.seed === undefined ? undefined : parseInteger(String(body.seed));
    return store.setBars({
      bars: generateDemoBars(count, seed === undefined ? {} : { seed }),
      symbol: typeof body.symbol === "string" ? body.symbol : "DEMO:MARKET",
      interval: typeof body.interval === "string" ? body.interval : "60",
      source: "synthetic-demo",
    });
  });

  const staticRoot = fileURLToPath(new URL("../dist-web", import.meta.url));
  const hasStatic = await access(staticRoot).then(
    () => true,
    () => false,
  );
  if (hasStatic) {
    await app.register(fastifyStatic, { root: staticRoot, wildcard: false });
  } else {
    app.get("/", async () => ({
      service: "market-chart-mcp",
      message: "Viewer assets are not built. Run npm run build.",
      chartState: "/api/chart/state",
    }));
  }

  return app;
}

export async function startApiServer(dependencies: ApiDependencies): Promise<StartedApi> {
  const app = await createApiServer(dependencies);
  const address = await app.listen({ host: dependencies.config.host, port: dependencies.config.port });
  const url = normalizeListenAddress(address, dependencies.config.host);
  return {
    app,
    url,
    close: () => app.close(),
  };
}

function normalizeListenAddress(address: string, host: string): string {
  const parsed = new URL(address);
  parsed.hostname = host === "::1" ? "[::1]" : "127.0.0.1";
  return parsed.toString().replace(/\/$/, "");
}

function isAllowedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.trim().toLowerCase();
  return (
    /^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/.test(host) ||
    /^(?:\[::1\](?::\d{1,5})?|::1)$/.test(host)
  );
}

function isProtectedPath(requestUrl: string): boolean {
  return requestUrl.startsWith("/api/") || requestUrl.startsWith("/v2/acts/");
}

function parseInteger(value: string | undefined, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`Expected an integer; received ${value}.`);
  return number;
}

function parseQueryBoolean(value: string): boolean {
  if (["1", "true"].includes(value.toLowerCase())) return true;
  if (["0", "false"].includes(value.toLowerCase())) return false;
  throw new Error(`Expected a boolean; received ${value}.`);
}

function parseEnumInteger(value: string, allowed: number[], name: string): number {
  const parsed = parseInteger(value);
  if (!allowed.includes(parsed)) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}.`);
  }
  return parsed;
}

function asObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  }
  return error instanceof Error ? error.message : "Request failed.";
}

function errorEnvelope(code: string, message: string) {
  return { success: false, error: { code, message } };
}

function tradingViewOhlcvCompatibilityResponse(
  result: TradingViewHistoryResult,
  requestedTo: number | undefined,
  strictTo: boolean | undefined,
) {
  const bars = [...result.bars].reverse().map((bar) => ({
    time: bar.time,
    open: bar.open,
    close: bar.close,
    max: bar.high,
    min: bar.low,
    volume: bar.volume ?? null,
  }));
  return {
    success: true,
    data: {
      symbol: result.symbol,
      current: bars[0]!,
      history: bars,
      info: {
        source: result.source,
        interval: result.interval,
        authenticated: result.authenticated,
        delayed: result.delayed,
        requestedBars: result.requestedBars,
        requestedBarsSatisfied: result.requestedBarsSatisfied,
        sourceBarCount: result.sourceBarCount,
        ...(requestedTo !== undefined
          ? { requestedTo, strictTo: strictTo ?? false, toApplied: false }
          : {}),
      },
    },
    msg: "Success",
  };
}

function normalizeCustomSeries(input: ReturnType<typeof CustomSeriesInputSchema.parse>) {
  return {
    ...input,
    data: input.data.map((point) => ({
      time: parseBarTime(point.time),
      value: point.value,
      ...(point.color ? { color: point.color } : {}),
    })),
  };
}
