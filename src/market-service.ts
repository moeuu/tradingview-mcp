import type { AnalysisResult } from "./analysis.js";
import { analyzeBars } from "./analysis.js";
import type { ChartStore } from "./chart-store.js";
import type { Bar } from "./domain.js";
import { normalizeBar, validateBars } from "./domain.js";
import type { TradingViewDataClient } from "./rapidapi.js";

export type FilterOperation =
  | "less"
  | "less_or_equal"
  | "greater"
  | "greater_or_equal"
  | "equal"
  | "nequal";

export interface SnapshotFilter {
  left: string;
  operation: FilterOperation;
  right: string | number;
}

export interface StockSnapshot {
  url: string;
  symbol: string;
  ticker: string;
  description: string | null;
  price: string | number | null;
  change: string | number | null;
  volume: string | number | null;
  volumeChange: string | number | null;
  marketCapitalization: string | number | null;
  priceToEarningsRatio: string | number | null;
  earningsPerShareDiluted: string | number | null;
  sector: string | null;
  logoUrl: string | null;
  rate_of_change: string | number | null;
  earningsReleaseNextDate: string | number | null;
  news: Array<{ url: string; title: string; published: string | null }>;
}

export class MarketService {
  constructor(
    private readonly store: ChartStore,
    private readonly upstream: TradingViewDataClient,
  ) {}

  get upstreamConfigured(): boolean {
    return this.upstream.configured;
  }

  async price(
    symbol: string,
    timeframe = "5",
    range = 10,
    options: { to?: number; type?: string } = {},
  ): Promise<unknown> {
    const safeSymbol = normalizeSymbol(symbol);
    const safeTimeframe = normalizePriceTimeframe(timeframe);
    const safeRange = boundedInteger(range, "range", 1, 5_000);
    const safeType = normalizePriceType(options.type);
    if (this.upstream.configured) {
      return this.upstream.get(`/api/price/${encodeURIComponent(safeSymbol)}`, {
        timeframe: safeTimeframe,
        range: safeRange,
        to: options.to,
        type: safeType,
      });
    }
    if (safeType && safeType !== "Japanese") {
      throw new Error(
        `${safeType} candles require TRADINGVIEW_RAPIDAPI_KEY; local mode only supports standard OHLCV.`,
      );
    }
    return localPriceResponse(this.store, safeSymbol, safeTimeframe, safeRange, options.to);
  }

  async ohlcv(
    symbol: string,
    timeframe = "5",
    range = 10,
    options: { to?: number; strictTo?: boolean } = {},
  ): Promise<unknown> {
    const safeSymbol = normalizeSymbol(symbol);
    const safeTimeframe = normalizePriceTimeframe(timeframe);
    const safeRange = boundedInteger(range, "range", 1, 5_000);
    if (this.upstream.configured) {
      return this.upstream.get(`/api/price/ohlcv/${encodeURIComponent(safeSymbol)}`, {
        timeframe: safeTimeframe,
        range: safeRange,
        to: options.to,
        strictTo: options.strictTo,
      });
    }
    return localPriceResponse(
      this.store,
      safeSymbol,
      safeTimeframe,
      safeRange,
      options.to,
      options.strictTo,
    );
  }

  async priceBatch(
    requests: Array<{ symbol: string; timeframe?: string; range?: number; type?: string }>,
  ): Promise<unknown> {
    if (requests.length === 0 || requests.length > 50) {
      throw new Error("Price batch accepts from 1 through 50 requests.");
    }
    const normalized = requests.map((request) => ({
      symbol: normalizeSymbol(request.symbol),
      ...(request.timeframe !== undefined
        ? { timeframe: normalizePriceTimeframe(request.timeframe) }
        : {}),
      ...(request.range !== undefined
        ? { range: boundedInteger(request.range, "range", 1, 5_000) }
        : {}),
      ...(request.type !== undefined ? { type: normalizePriceType(request.type) } : {}),
    }));
    if (this.upstream.configured) {
      return this.upstream.post("/api/price/batch", { requests: normalized });
    }
    const data = normalized.map((request) => {
      try {
        const timeframe = request.timeframe ?? "5";
        const range = request.range ?? 10;
        if (request.type && request.type !== "Japanese") {
          throw new Error(
            `${request.type} candles require TRADINGVIEW_RAPIDAPI_KEY; local mode only supports standard OHLCV.`,
          );
        }
        const response = localPriceResponse(
          this.store,
          request.symbol,
          timeframe,
          range,
        ) as { data: Record<string, unknown> };
        return { success: true, symbol: request.symbol, ...response.data };
      } catch (error) {
        return {
          success: false,
          symbol: request.symbol,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
    return {
      success: true,
      data: {
        total: data.length,
        successful: data.filter((entry) => entry.success).length,
        failed: data.filter((entry) => !entry.success).length,
        data,
      },
      msg: "Success",
    };
  }

  async loadPriceIntoChart(symbol: string, timeframe = "5", range = 10) {
    const response = await this.price(symbol, timeframe, range);
    const bars = extractBars(response);
    if (bars.length === 0) {
      throw new Error("The price response did not contain OHLCV bars.");
    }
    return this.store.setBars({
      bars,
      symbol: normalizeSymbol(symbol),
      interval: normalizePriceTimeframe(timeframe),
      source: this.upstream.configured ? "tradingviewapi.com via RapidAPI" : "local chart store",
    });
  }

  async quote(
    symbol: string,
    options: { session?: string; fields?: string } = {},
  ): Promise<unknown> {
    const safeSymbol = normalizeSymbol(symbol);
    if (this.upstream.configured) {
      return this.upstream.get(`/api/quote/${encodeURIComponent(safeSymbol)}`, options);
    }
    return localQuoteResponse(this.store, safeSymbol);
  }

  async quoteBatch(
    symbols: string[],
    options: { session?: string; fields?: string } = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (symbols.length === 0 || symbols.length > 50) {
      throw new Error("Quote batch accepts from 1 through 50 symbols.");
    }
    const normalized = symbols.map(normalizeSymbol);
    if (this.upstream.configured) {
      return this.upstream.post(
        "/api/quote/batch",
        { symbols: normalized, ...options },
        signal ? { signal } : {},
      );
    }
    const data = normalized.map((symbol) => {
      try {
        return { success: true, symbol, data: localQuoteRecord(this.store, symbol) };
      } catch (error) {
        return {
          success: false,
          symbol,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
    return {
      success: true,
      data: {
        total: data.length,
        successful: data.filter((entry) => entry.success).length,
        failed: data.filter((entry) => !entry.success).length,
        data,
      },
      msg: "Success",
    };
  }

  async search(
    query: string,
    options: {
      filter?: string;
      hl?: string | number;
      exchange?: string;
      lang?: string;
      sort_by_country?: string;
      enable_grouping?: boolean;
    } = {},
  ): Promise<unknown> {
    const safeQuery = query.trim();
    if (safeQuery.length < 1 || safeQuery.length > 100) {
      throw new Error("Search query must contain from 1 through 100 characters.");
    }
    if (this.upstream.configured) {
      return this.upstream.get(`/api/search/market/${encodeURIComponent(safeQuery)}`, {
        filter: options.filter?.trim() || undefined,
        hl: options.hl,
        exchange: options.exchange?.trim() || undefined,
        lang: options.lang?.trim() || undefined,
        sort_by_country: options.sort_by_country?.trim() || undefined,
        enable_grouping: options.enable_grouping,
      });
    }
    const state = this.store.getSummary();
    const matches = state.symbol.toLowerCase().includes(safeQuery.toLowerCase());
    return {
      success: true,
      data: {
        markets: matches
          ? [
              {
                id: state.symbol,
                exchange: state.symbol.split(":")[0] ?? "LOCAL",
                symbol: state.symbol.split(":").at(-1),
                full_name: state.symbol,
                type: "local",
                description: `Loaded local dataset (${state.source})`,
                logoid: null,
                currency_code: null,
                country: null,
              },
            ]
          : [],
        count: matches ? 1 : 0,
      },
      msg: "Success",
    };
  }

  async technicalAnalysis(symbol: string, interval?: string): Promise<unknown> {
    const safeSymbol = normalizeSymbol(symbol);
    if (this.upstream.configured) {
      const suffix = interval ? "/indicators" : "";
      return this.upstream.get(`/api/ta/${encodeURIComponent(safeSymbol)}${suffix}`, {
        interval: interval ? normalizeTimeframe(interval) : undefined,
      });
    }
    assertLoadedSymbol(this.store, safeSymbol);
    if (interval && !equivalentAnalysisInterval(interval, this.store.getSummary().interval)) {
      throw new Error(
        `Only loaded interval ${this.store.getSummary().interval} is available without TRADINGVIEW_RAPIDAPI_KEY.`,
      );
    }
    const analysis = analyzeBars(this.store.getState().bars);
    if (interval) {
      const normalizedInterval = normalizeTimeframe(interval);
      const outputInterval = canonicalAnalysisInterval(normalizedInterval);
      return {
        success: true,
        data: indicatorCompatibility(analysis),
        ...(outputInterval === "1D"
          ? {}
          : { interval: /^\d+$/.test(outputInterval) ? Number(outputInterval) : outputInterval }),
        msg: "Success",
      };
    }
    const score = scoreAnalysis(analysis);
    const state = this.store.getSummary();
    return {
      success: true,
      data: {
        [canonicalAnalysisInterval(state.interval)]: {
          Other: score.other,
          All: score.all,
          MA: score.movingAverage,
        },
      },
      msg: "Success",
    };
  }

  async screenerScan(body: Record<string, unknown>): Promise<unknown> {
    if (this.upstream.configured) {
      return this.upstream.post("/api/screener/scan", body);
    }
    const state = this.store.getSummary();
    const quote = localQuoteRecord(this.store, state.symbol);
    return {
      success: true,
      data: {
        totalCount: 1,
        data: [{ symbol: state.symbol, ...quote }],
        source: "local chart store",
      },
    };
  }

  async news(
    query: Record<string, string | number | boolean | undefined>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.upstream.configured) {
      return this.upstream.get("/api/news", query, signal ? { signal } : {});
    }
    return {
      success: true,
      data: { items: [] },
      msg: "Success",
      sourceMessage: "No local news provider is configured.",
    };
  }

  analyzeCurrent(): AnalysisResult {
    return analyzeBars(this.store.getState().bars);
  }

  async stockSnapshots(input: {
    symbols: string[];
    exchange?: string | undefined;
    customFilters?: SnapshotFilter[] | undefined;
    scrapeNewsHeadlines?: boolean | undefined;
  }): Promise<StockSnapshot[]> {
    if (input.symbols.length === 0 || input.symbols.length > 50) {
      throw new Error("Stock snapshot accepts from 1 through 50 symbols.");
    }
    const resolvedSymbols = input.symbols.map((symbol) =>
      normalizeSymbol(symbol.includes(":") || !input.exchange ? symbol : `${input.exchange}:${symbol}`),
    );
    const operationSignal = AbortSignal.timeout(45_000);
    const quotes = await this.quoteBatch(resolvedSymbols, {}, operationSignal);
    const quotesBySymbol = extractQuoteBatch(quotes);
    const snapshots = resolvedSymbols
      .map((symbol) => {
        const quote = quotesBySymbol.get(symbol);
        if (!quote) throw new Error(`Batch quote did not return ${symbol}.`);
        return snapshotFromQuote(symbol, quote);
      })
      .filter((snapshot) => matchesFilters(snapshot, input.customFilters ?? []));

    if (input.scrapeNewsHeadlines && this.upstream.configured) {
      await forEachConcurrent(snapshots, 5, async (snapshot) => {
        const news = await this.news({ symbol: snapshot.symbol, lang: "en" }, operationSignal);
        snapshot.news = extractNews(news);
      });
    }
    return snapshots;
  }
}

function localPriceResponse(
  store: ChartStore,
  symbol: string,
  timeframe: string,
  range: number,
  to?: number,
  strictTo = false,
): unknown {
  assertLoadedSymbol(store, symbol);
  const state = store.getState();
  if (!equivalentPriceInterval(timeframe, state.interval)) {
    throw new Error(
      `Only loaded interval ${state.interval} is available without TRADINGVIEW_RAPIDAPI_KEY.`,
    );
  }
  const eligible = to === undefined ? state.bars : state.bars.filter((bar) => bar.time <= to);
  // strictTo controls upstream cache behavior. Local bars are already deterministic,
  // so the ordinary `to` cutoff is the closest meaningful equivalent.
  void strictTo;
  const bars = eligible.slice(-range).reverse().map(toCompatibilityBar);
  if (bars.length === 0) {
    throw new Error("No local bars matched the requested time range.");
  }
  return {
    success: true,
    data: {
      symbol,
      current: bars[0],
      history: bars,
      info: { source: state.source },
    },
    msg: "Success",
  };
}

function localQuoteResponse(store: ChartStore, symbol: string): unknown {
  return {
    success: true,
    data: { symbol, data: localQuoteRecord(store, symbol) },
    msg: "Success",
  };
}

function localQuoteRecord(store: ChartStore, symbol: string): Record<string, unknown> {
  assertLoadedSymbol(store, symbol);
  const state = store.getState();
  const last = state.bars.at(-1)!;
  const previous = state.bars.at(-2) ?? last;
  const change = last.close - previous.close;
  const changePercent = previous.close === 0 ? 0 : (change / previous.close) * 100;
  return {
    lp: last.close,
    price: last.close,
    change,
    change_percent: changePercent,
    ch: change,
    chp: changePercent,
    open_price: last.open,
    high_price: last.high,
    low_price: last.low,
    volume: last.volume ?? null,
    description: `Loaded local dataset (${state.source})`,
    exchange: state.symbol.split(":")[0] ?? "LOCAL",
  };
}

function toCompatibilityBar(bar: Bar) {
  return {
    time: bar.time,
    open: bar.open,
    close: bar.close,
    max: bar.high,
    min: bar.low,
    volume: bar.volume ?? null,
  };
}

export function extractBars(payload: unknown): Bar[] {
  const root = asRecord(payload) ?? {};
  const data = asRecord(root.data) ?? root;
  const candidates = [data.history, data.bars, root.history, root.bars].find(Array.isArray);
  const values: unknown[] = candidates ? [...candidates] : [];
  if (data?.current) values.push(data.current);
  const byTime = new Map<number, Bar>();
  for (const entry of values) {
    const record = asRecord(entry);
    if (!record) continue;
    try {
      const bar = normalizeBar({
        time: record.time ?? record.timestamp,
        open: record.open ?? record.o,
        high: record.high ?? record.max ?? record.h,
        low: record.low ?? record.min ?? record.l,
        close: record.close ?? record.c,
        volume: record.volume ?? record.v,
      });
      byTime.set(bar.time, bar);
    } catch {
      // Ignore non-bar records in permissive upstream payloads.
    }
  }
  const bars = [...byTime.values()].sort((a, b) => a.time - b.time);
  if (bars.length > 0) validateBars(bars);
  return bars;
}

function assertLoadedSymbol(store: ChartStore, symbol: string): void {
  const loaded = store.getSummary().symbol;
  if (loaded.toUpperCase() !== symbol.toUpperCase()) {
    throw new Error(
      `Only ${loaded} is loaded locally. Configure TRADINGVIEW_RAPIDAPI_KEY or import this symbol's CSV.`,
    );
  }
}

function normalizeSymbol(symbol: string): string {
  const value = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._:/-]{0,79}$/.test(value)) {
    throw new Error(`Invalid symbol: ${symbol}`);
  }
  return value;
}

function normalizeTimeframe(timeframe: string): string {
  const value = timeframe.trim();
  if (!/^[A-Za-z0-9]{1,10}$/.test(value)) {
    throw new Error(`Invalid timeframe: ${timeframe}`);
  }
  return value;
}

function normalizePriceTimeframe(timeframe: string): string {
  const value = timeframe.trim();
  if (!["1", "5", "15", "30", "60", "240", "D", "W", "M"].includes(value)) {
    throw new Error(`Invalid price timeframe: ${timeframe}`);
  }
  return value;
}

function normalizePriceType(type: string | undefined): "Japanese" | "HeikinAshi" | "Range" | undefined {
  if (type === undefined) return undefined;
  if (type === "Japanese" || type === "HeikinAshi" || type === "Range") return type;
  throw new Error(`Invalid price type: ${type}`);
}

function equivalentPriceInterval(priceInterval: string, loadedInterval: string): boolean {
  const canonical = (value: string) => {
    const normalized = value.trim().toUpperCase();
    if (normalized === "1D") return "D";
    if (normalized === "1W") return "W";
    if (normalized === "1M") return "M";
    return normalized;
  };
  return canonical(priceInterval) === canonical(loadedInterval);
}

function equivalentAnalysisInterval(requestedInterval: string, loadedInterval: string): boolean {
  return canonicalAnalysisInterval(requestedInterval) === canonicalAnalysisInterval(loadedInterval);
}

function canonicalAnalysisInterval(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (normalized === "D" || normalized === "1D") return "1D";
  if (normalized === "W" || normalized === "1W") return "1W";
  if (normalized === "M" || normalized === "1M") return "1M";
  if (normalized === "1H") return "60";
  if (normalized === "2H") return "120";
  if (normalized === "4H") return "240";
  return normalized;
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function scoreAnalysis(analysis: AnalysisResult): {
  other: number;
  all: number;
  movingAverage: number;
} {
  const all = Number((analysis.trend.score / 50).toFixed(3));
  const otherVotes = analysis.signals.reduce(
    (score, signal) => score + (signal.direction === "bullish" ? 1 : signal.direction === "bearish" ? -1 : 0),
    0,
  );
  const other = Number(
    ((otherVotes / Math.max(1, analysis.signals.length)) * 2).toFixed(3),
  );
  return { other, all, movingAverage: all };
}

function indicatorCompatibility(analysis: AnalysisResult): Record<string, number | null> {
  const score = scoreAnalysis(analysis);
  return {
    close: analysis.latest.close,
    RSI: analysis.indicators.rsi14,
    SMA20: analysis.indicators.sma20,
    SMA50: analysis.indicators.sma50,
    SMA200: analysis.indicators.sma200,
    EMA12: analysis.indicators.ema12,
    EMA26: analysis.indicators.ema26,
    "MACD.macd": analysis.indicators.macd?.macd ?? null,
    "MACD.signal": analysis.indicators.macd?.signal ?? null,
    "Recommend.All": Number((score.all / 2).toFixed(3)),
    "Recommend.MA": Number((score.movingAverage / 2).toFixed(3)),
    "Recommend.Other": Number((score.other / 2).toFixed(3)),
  };
}

function extractQuoteBatch(payload: unknown): Map<string, unknown> {
  const root = asRecord(payload) ?? {};
  const data = asRecord(root.data) ?? root;
  const entries = Array.isArray(data.data) ? data.data : [];
  const bySymbol = new Map<string, unknown>();
  for (const entry of entries) {
    const record = asRecord(entry);
    if (!record || record.success === false || typeof record.symbol !== "string") continue;
    bySymbol.set(normalizeSymbol(record.symbol), record);
  }
  return bySymbol;
}

function snapshotFromQuote(symbol: string, payload: unknown): StockSnapshot {
  const root = asRecord(payload) ?? {};
  const envelope = asRecord(root.data) ?? root;
  const data = asRecord(envelope.data) ?? envelope;
  const ticker = symbol.split(":").at(-1) ?? symbol;
  return {
    url: `https://www.tradingview.com/symbols/${encodeURIComponent(symbol.replace(/[:/]/g, "-"))}/`,
    symbol,
    ticker,
    description: pickText(data, ["description", "name"]),
    price: pick(data, ["price", "lp", "last", "close"], null),
    change: pick(data, ["chp", "change_percent", "change"], null),
    volume: pick(data, ["volume", "volume_24h"], null),
    volumeChange: pick(data, ["volumeChange", "volume_change"], null),
    marketCapitalization: pick(data, ["marketCapitalization", "market_cap_basic"], null),
    priceToEarningsRatio: pick(data, ["priceToEarningsRatio", "price_earnings_ttm"], null),
    earningsPerShareDiluted: pick(
      data,
      ["earningsPerShareDiluted", "earnings_per_share_diluted_ttm"],
      null,
    ),
    sector: pickText(data, ["sector"]),
    logoUrl: resolveLogoUrl(data),
    rate_of_change: pick(data, ["rate_of_change", "rateOfChange", "ROC"], null),
    earningsReleaseNextDate: pick(
      data,
      ["earningsReleaseNextDate", "earnings_release_next_date"],
      null,
    ),
    news: extractNews(payload),
  };
}

function extractNews(payload: unknown): StockSnapshot["news"] {
  const root = asRecord(payload);
  const dataRecord = asRecord(root?.data);
  const candidates = root?.news ?? dataRecord?.news ?? dataRecord?.items ?? root?.data;
  if (!Array.isArray(candidates)) return [];
  return candidates.flatMap((entry) => {
    const record = asRecord(entry);
    const rawUrl = record?.url ?? record?.storyPath;
    const title = record?.title;
    if (typeof rawUrl !== "string" || typeof title !== "string") return [];
    const url = rawUrl.startsWith("/") ? `https://www.tradingview.com${rawUrl}` : rawUrl;
    if (!/^https?:\/\//.test(url)) return [];
    const published = record?.published;
    return [
      {
        url,
        title,
        published:
          typeof published === "number" && Number.isFinite(published)
            ? new Date(published * 1_000).toISOString()
            : typeof published === "string"
              ? published
              : null,
      },
    ];
  });
}

function resolveLogoUrl(record: Record<string, unknown>): string | null {
  const explicit = pickText(record, ["logoUrl", "logo"]);
  if (explicit && /^https?:\/\//.test(explicit)) return explicit;
  const logoid = pickText(record, ["logoid"]);
  if (!logoid || !/^[a-zA-Z0-9_-]{1,100}$/.test(logoid)) return null;
  return `https://s3-symbol-logo.tradingview.com/${encodeURIComponent(logoid)}.svg`;
}

function pick<T>(
  record: Record<string, unknown>,
  names: string[],
  fallback: T,
): string | number | T {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" || typeof value === "number") return value;
  }
  return fallback;
}

function pickText(record: Record<string, unknown>, names: string[]): string | null {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string") return value;
  }
  return null;
}

function matchesFilters(snapshot: StockSnapshot, filters: SnapshotFilter[]): boolean {
  const aliases: Record<string, keyof StockSnapshot> = {
    close: "price",
    change: "change",
    volume: "volume",
    volume_change: "volumeChange",
    market_cap_basic: "marketCapitalization",
    price_earnings_ttm: "priceToEarningsRatio",
    earnings_per_share_diluted_ttm: "earningsPerShareDiluted",
    sector: "sector",
    ROC: "rate_of_change",
    earnings_release_next_date: "earningsReleaseNextDate",
  };
  return filters.every((filter) => {
    const key = aliases[filter.left];
    if (!key) throw new Error(`Unsupported snapshot filter field: ${filter.left}`);
    return compare(snapshot[key], filter.operation, filter.right);
  });
}

function compare(
  left: StockSnapshot[keyof StockSnapshot],
  operation: FilterOperation,
  right: string | number,
): boolean {
  const leftPrimitive = Array.isArray(left) ? "" : left;
  if (leftPrimitive === null || leftPrimitive === undefined || leftPrimitive === "") return false;
  const leftNumber = parseNumeric(leftPrimitive);
  const rightNumber = parseNumeric(right);
  const numeric = leftNumber !== undefined && rightNumber !== undefined;
  const a = numeric ? leftNumber : String(leftPrimitive ?? "").toLowerCase();
  const b = numeric ? rightNumber : String(right).toLowerCase();
  switch (operation) {
    case "less":
      return a < b;
    case "less_or_equal":
      return a <= b;
    case "greater":
      return a > b;
    case "greater_or_equal":
      return a >= b;
    case "equal":
      return a === b;
    case "nequal":
      return a !== b;
  }
}

async function forEachConcurrent<T>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(values[index]!);
    }
  });
  await Promise.all(runners);
}

function parseNumeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[$,%\s]/g, "").toUpperCase();
  const match = normalized.match(/^(-?\d+(?:\.\d+)?)([KMBT])?/);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const factor = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[match[2] ?? ""] ?? 1;
  return amount * factor;
}
