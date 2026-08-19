import { z } from "zod";
import { MAX_BARS } from "./domain.js";

const finiteNumberInput = (options: { nonnegative?: boolean } = {}) =>
  z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() !== "" ? Number(value.trim()) : value,
    options.nonnegative ? z.number().finite().nonnegative() : z.number().finite(),
  );

export const SymbolSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/!+-]*$/)
  .describe("Market symbol, preferably EXCHANGE:TICKER (for example NASDAQ:AAPL). ");

export const TimeframeSchema = z
  .string()
  .min(1)
  .max(10)
  .regex(/^[A-Za-z0-9]+$/)
  .describe("Bar interval such as 1, 5, 60, 1D, 1W, or 1M.");

export const PriceTimeframeSchema = z
  .enum(["1", "5", "15", "30", "60", "240", "D", "W", "M"])
  .describe("Price interval.");

export const BarInputSchema = z.object({
  time: z.union([z.number(), z.string()]),
  open: finiteNumberInput(),
  high: finiteNumberInput(),
  low: finiteNumberInput(),
  close: finiteNumberInput(),
  volume: finiteNumberInput({ nonnegative: true }).optional(),
});

export const BarsInputSchema = z.object({
  symbol: SymbolSchema,
  interval: TimeframeSchema,
  source: z.string().min(1).max(120).default("user-provided"),
  bars: z.array(BarInputSchema).min(1).max(10_000),
});

export const CsvImportSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(1_000)
    .describe("CSV path inside MARKET_CHART_DATA_ROOT. Columns: time/open/high/low/close/volume."),
  symbol: SymbolSchema,
  interval: TimeframeSchema,
});

export const ViewInputSchema = z.object({
  symbol: SymbolSchema.optional(),
  interval: TimeframeSchema.optional(),
  theme: z.enum(["dark", "light"]).optional(),
});

export const IndicatorInputSchema = z.object({
  id: z.string().min(1).max(100).optional(),
  kind: z.enum(["sma", "ema", "bollinger", "rsi", "macd"]),
  period: z.number().int().min(2).max(500).optional(),
  fastPeriod: z.number().int().min(2).max(200).optional(),
  slowPeriod: z.number().int().min(3).max(500).optional(),
  signalPeriod: z.number().int().min(2).max(200).optional(),
  standardDeviations: z.number().positive().max(10).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

export const LevelInputSchema = z.object({
  id: z.string().min(1).max(100).optional(),
  price: z.number().finite(),
  label: z.string().min(1).max(80),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#a78bfa"),
});

export const SeriesPointInputSchema = z.object({
  time: z.union([z.number(), z.string()]),
  value: finiteNumberInput(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

export const CustomSeriesInputSchema = z.object({
  id: z.string().min(1).max(100).optional(),
  kind: z.enum(["line", "histogram"]),
  label: z.string().min(1).max(80),
  pane: z.enum(["price", "cvd", "oscillator"]).default("price"),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#38bdf8"),
  lineWidth: z.number().int().min(1).max(4).default(2),
  lineStyle: z.enum(["solid", "dashed", "dotted"]).default("solid"),
  data: z.array(SeriesPointInputSchema).min(1).max(20_000),
});

export const ZoneInputSchema = z.object({
  id: z.string().min(1).max(100).optional(),
  startTime: z.union([z.number(), z.string()]),
  endTime: z.union([z.number(), z.string()]),
  upper: finiteNumberInput(),
  lower: finiteNumberInput(),
  label: z.string().min(1).max(80),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#f59e0b"),
});

export const MarkerInputSchema = z.object({
  id: z.string().min(1).max(100).optional(),
  time: z.union([z.number(), z.string()]),
  position: z.enum(["aboveBar", "belowBar", "inBar"]),
  shape: z.enum(["circle", "square", "arrowUp", "arrowDown"]),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#f8fafc"),
  text: z.string().min(1).max(120),
});

export const OverlayBundleSchema = z.object({
  replace: z.boolean().default(true),
  indicators: z.array(IndicatorInputSchema).max(32).optional(),
  levels: z.array(LevelInputSchema).max(256).optional(),
  customSeries: z.array(CustomSeriesInputSchema).max(64).optional(),
  zones: z.array(ZoneInputSchema).max(128).optional(),
  markers: z.array(MarkerInputSchema).max(1_000).optional(),
});

export const TradingViewIntervalSchema = z
  .string()
  .trim()
  .min(1)
  .max(10)
  .regex(/^(?:[1-9]\d{0,3}[STHDWM]?|[DWM])$/i);

export const TradingViewDayIntervalSchema = z
  .string()
  .trim()
  .min(1)
  .max(10)
  .regex(/^(?:D|1D|[1-9]\d{0,3}|[1-9]\d{0,3}S|[1-9]\d{0,2}H)$/i, {
    message: "Day lookup interval must be daily, seconds, minutes, or hours.",
  })
  .refine((value) => {
    const normalized = value.toUpperCase();
    if (normalized === "D" || normalized === "1D") return true;
    const match = /^(\d+)([SH]?)$/.exec(normalized);
    if (!match) return false;
    const unitSeconds = match[2] === "S" ? 1 : match[2] === "H" ? 3_600 : 60;
    const durationSeconds = Number(match[1]) * unitSeconds;
    return durationSeconds >= 9 && durationSeconds <= 86_400;
  }, "Day lookup interval must span at least 9 seconds and no more than 24 hours.");

export const TradingViewLayoutIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{4,40}$/);

export const TradingViewOpenChartInputSchema = z
  .object({
    symbol: SymbolSchema.describe(
      "TradingView symbol, for example NASDAQ:AAPL or CME_MINI:ES1!.",
    ),
    interval: TradingViewIntervalSchema.default("240"),
    layoutId: TradingViewLayoutIdSchema.optional(),
  })
  .strict();

export const TradingViewSnapshotInputSchema = z
  .object({
    width: z.number().int().min(640).max(2_560).default(1_440),
    height: z.number().int().min(480).max(1_800).default(900),
    chartOnly: z.boolean().default(true),
  })
  .strict();

export const DateOnlySchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Date must be a real calendar date in YYYY-MM-DD format.");

export const IanaTimezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
      return true;
    } catch {
      return false;
    }
  }, "Timezone must be a valid IANA timezone such as UTC, America/New_York, or Asia/Tokyo.");

const TradingViewDateRangeSchema = z
  .object({
    symbol: SymbolSchema.describe(
      "TradingView symbol, preferably EXCHANGE:TICKER such as NASDAQ:AAPL.",
    ),
    interval: TradingViewIntervalSchema.default("D"),
    from: DateOnlySchema.describe("First visible calendar date, in YYYY-MM-DD format."),
    to: DateOnlySchema.describe("Last visible calendar date, in YYYY-MM-DD format."),
    layoutId: TradingViewLayoutIdSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.from > input.to) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: "The end date must be on or after the start date.",
      });
    }
  });

export const TradingViewPeriodScreenshotInputSchema = TradingViewDateRangeSchema.safeExtend({
  width: z.number().int().min(640).max(2_560).default(1_440),
  height: z.number().int().min(480).max(1_800).default(900),
  chartOnly: z.boolean().default(true),
  keepBrowserOpen: z.boolean().default(false),
}).strict();

export const TradingViewDayInputSchema = z
  .object({
    symbol: SymbolSchema.describe(
      "TradingView symbol, preferably EXCHANGE:TICKER such as NASDAQ:AAPL.",
    ),
    date: DateOnlySchema.describe("Requested market date in YYYY-MM-DD format."),
    interval: TradingViewDayIntervalSchema.default("D").describe(
      "D returns the session candle; an intraday interval of at least 9 seconds returns and aggregates every exported bar on that date.",
    ),
    timezone: IanaTimezoneSchema.default("UTC").describe(
      "IANA timezone used to decide which exported bars belong to the requested calendar date.",
    ),
    lookbackBars: z.number().int().min(2).max(MAX_BARS).default(500).describe(
      "Maximum exported bars retained through the requested date for comparisons and technical analysis.",
    ),
    includeBars: z.boolean().default(false).describe(
      "Include every matching intraday bar. The default response keeps only the aggregate and analysis.",
    ),
    layoutId: TradingViewLayoutIdSchema.optional(),
    keepBrowserOpen: z.boolean().default(false),
  })
  .strict();

export const TradingViewCaptureIntervalSchema = z.enum(["5", "60", "240", "D", "W", "M"]);

export const TradingViewCaptureIntervalOrderSchema = z.tuple([
  z.literal("5"),
  z.literal("60"),
  z.literal("240"),
  z.literal("D"),
  z.literal("W"),
  z.literal("M"),
]);

export const TradingViewCaptureOverlayModeSchema = z.enum([
  "candles_only",
  "builtin_ichimoku_only",
  "saved_layout_pine",
]);

function credentialLikeIndicatorText(value: string): boolean {
  return (
    /[\u0000-\u001f\u007f]/.test(value) ||
    /\bbearer\s+\S+/i.test(value) ||
    /\bbasic\s+[A-Za-z0-9+/]{12,}={0,2}(?:\s|$)/i.test(value) ||
    /\b(?:cookie|set-cookie|sessionid|session_id|authorization|password|passwd|token|secret|key|access[_-]?token|refresh[_-]?token|api[_ -]?key|client[_-]?secret)\b\s*[:=]\s*["']?\S+/i.test(
      value,
    ) ||
    /https?:\/\/[^\s/:@]+:[^\s/@]+@/i.test(value) ||
    /(?:^|[^A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})(?:$|[^A-Za-z0-9_])/i.test(
      value,
    ) ||
    /(?:^|[^A-Za-z0-9])sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}(?:$|[^A-Za-z0-9_-])/i.test(
      value,
    ) ||
    /(?:^|[^A-Za-z0-9])(?:AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[0-9A-Za-z-]{10,})(?:$|[^A-Za-z0-9_-])/.test(
      value,
    ) ||
    /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----/.test(value) ||
    /(?:^|\s)eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\s|$)/.test(
      value,
    )
  );
}

const TradingViewExpectedIndicatorTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine((value) => !credentialLikeIndicatorText(value), {
    message: "Credential-like values are forbidden in expected indicator metadata.",
  });

const TradingViewExpectedIndicatorSchema = z
  .object({
    identity: TradingViewExpectedIndicatorTextSchema,
    name: TradingViewExpectedIndicatorTextSchema,
  })
  .strict();

export const TradingViewCaptureBatchInputSchema = z
  .object({
    symbol: z.literal("OSE:NK2251!"),
    intervals: TradingViewCaptureIntervalOrderSchema,
    layoutId: TradingViewLayoutIdSchema,
    width: z.literal(1_800),
    height: z.literal(850),
    chartOnly: z.literal(false),
    requireAuthenticated: z.literal(true),
    allowDelayed: z.literal(false),
    expectedOverlayMode: TradingViewCaptureOverlayModeSchema,
    expectedIndicator: TradingViewExpectedIndicatorSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.expectedOverlayMode === "candles_only" && input.expectedIndicator !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["expectedIndicator"],
        message: "expectedIndicator is forbidden for candles_only captures.",
      });
    }
    if (input.expectedOverlayMode !== "candles_only" && input.expectedIndicator === undefined) {
      context.addIssue({
        code: "custom",
        path: ["expectedIndicator"],
        message: "expectedIndicator is required for Ichimoku or saved Pine captures.",
      });
    }
  });

const TradingViewCaptureEvidenceSchema = z
  .object({
    selector: z.string().min(1).max(240),
    value: z.string().min(1).max(240),
  })
  .strict();

const TradingViewObservedIndicatorSchema = z
  .object({
    identity: z.string().min(1).max(160),
    name: z.string().min(1).max(160),
    source: z.enum(["builtin", "pine"]),
  })
  .strict();

export const TradingViewCaptureObservedStateSchema = z
  .object({
    pageUrl: z.string().url().max(500),
    symbol: z.literal("OSE:NK2251!"),
    exchange: z.literal("OSE"),
    interval: TradingViewCaptureIntervalSchema,
    intervalLabel: z.string().min(1).max(80),
    chartAriaLabel: z.string().min(1).max(240),
    chartType: z.literal("candles"),
    chartTypeLabel: z.string().min(1).max(120),
    authenticated: z.literal(true),
    delayed: z.literal(false),
    realtime: z.literal(true),
    timezone: z.literal("Asia/Tokyo"),
    session: z.literal("ose_full_day_and_night"),
    backAdjustment: z.literal(false),
    settlementAsClose: z.literal(false),
    overlayMode: TradingViewCaptureOverlayModeSchema,
    chartCount: z.literal(1),
    studyCount: z.number().int().min(0).max(1),
    collapsedStudyCount: z.literal(0),
    comparisonCount: z.literal(0),
    drawingCount: z.literal(0),
    indicator: TradingViewObservedIndicatorSchema.optional(),
    evidence: z.array(TradingViewCaptureEvidenceSchema).min(14).max(32),
  })
  .strict();

const TradingViewCapturePanelSchema = z
  .object({
    index: z.number().int().min(0).max(5),
    requestedInterval: TradingViewCaptureIntervalSchema,
    captureStartedAt: z.string().datetime(),
    captureEndedAt: z.string().datetime(),
    observedBefore: TradingViewCaptureObservedStateSchema,
    observedAfter: TradingViewCaptureObservedStateSchema,
    png: z
      .object({
        path: z.string().regex(/^tradingview-captures\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.png$/),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        bytes: z.number().int().positive().max(50 * 1024 * 1024),
        width: z.literal(1_800),
        height: z.literal(850),
      })
      .strict(),
  })
  .strict();

export const TradingViewCaptureBatchManifestSchema = z
  .object({
    schemaVersion: z.literal("tradingview-capture-batch/v1"),
    source: z.literal("TradingView Supercharts official browser UI"),
    batchId: z.string().regex(/^[A-Za-z0-9._-]{8,100}$/),
    manifestIdentity: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    batchStartedAt: z.string().datetime(),
    batchEndedAt: z.string().datetime(),
    captureSkewMs: z.number().int().nonnegative().max(86_400_000),
    symbol: z.literal("OSE:NK2251!"),
    layoutId: TradingViewLayoutIdSchema,
    intervalOrder: TradingViewCaptureIntervalOrderSchema,
    requested: TradingViewCaptureBatchInputSchema,
    panels: z.array(TradingViewCapturePanelSchema).length(6),
    upgradeAttempted: z.literal(false),
  })
  .strict()
  .superRefine((manifest, context) => {
    const batchStartedMs = Date.parse(manifest.batchStartedAt);
    const batchEndedMs = Date.parse(manifest.batchEndedAt);
    if (batchEndedMs < batchStartedMs) {
      context.addIssue({
        code: "custom",
        path: ["batchEndedAt"],
        message: "Capture batch timestamps must be chronological.",
      });
    }
    if (
      manifest.symbol !== manifest.requested.symbol ||
      manifest.layoutId !== manifest.requested.layoutId ||
      manifest.intervalOrder.some(
        (interval, index) => interval !== manifest.requested.intervals[index],
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["requested"],
        message: "Top-level capture identity/order must match the exact request.",
      });
    }
    const order = manifest.panels.map((panel) => panel.requestedInterval);
    if (order.some((interval, index) => interval !== manifest.intervalOrder[index])) {
      context.addIssue({
        code: "custom",
        path: ["panels"],
        message: "Capture panels must use the declared exact interval order.",
      });
    }
    const paths = new Set<string>();
    let previousCaptureEndedMs: number | undefined;
    const captureStartedValues: number[] = [];
    for (const [index, panel] of manifest.panels.entries()) {
      const captureStartedMs = Date.parse(panel.captureStartedAt);
      const captureEndedMs = Date.parse(panel.captureEndedAt);
      captureStartedValues.push(captureStartedMs);
      if (
        captureStartedMs < batchStartedMs ||
        captureEndedMs < captureStartedMs ||
        captureEndedMs > batchEndedMs
      ) {
        context.addIssue({
          code: "custom",
          path: ["panels", index, "captureStartedAt"],
          message: "Panel timestamps must be chronological and contained by the batch.",
        });
      }
      if (previousCaptureEndedMs !== undefined && captureStartedMs < previousCaptureEndedMs) {
        context.addIssue({
          code: "custom",
          path: ["panels", index, "captureStartedAt"],
          message: "Panel captures cannot overlap or run backward.",
        });
      }
      previousCaptureEndedMs = captureEndedMs;
      if (panel.index !== index) {
        context.addIssue({
          code: "custom",
          path: ["panels", index, "index"],
          message: "Panel index must match its ordered array position.",
        });
      }
      if (
        panel.observedBefore.interval !== panel.requestedInterval ||
        panel.observedAfter.interval !== panel.requestedInterval
      ) {
        context.addIssue({
          code: "custom",
          path: ["panels", panel.index],
          message: "Observed interval does not match the requested panel interval.",
        });
      }
      for (const [side, observed] of [
        ["observedBefore", panel.observedBefore],
        ["observedAfter", panel.observedAfter],
      ] as const) {
        let observedUrl: URL | undefined;
        try {
          observedUrl = new URL(observed.pageUrl);
        } catch {
          observedUrl = undefined;
        }
        if (
          observedUrl === undefined ||
          observedUrl.protocol !== "https:" ||
          (observedUrl.hostname !== "tradingview.com" &&
            !observedUrl.hostname.endsWith(".tradingview.com")) ||
          observedUrl.username !== "" ||
          observedUrl.password !== "" ||
          observedUrl.port !== "" ||
          observedUrl.pathname !== `/chart/${manifest.layoutId}/` ||
          observedUrl.hash !== "" ||
          [...observedUrl.searchParams.entries()].length !== 2 ||
          observedUrl.searchParams.get("symbol") !== manifest.symbol ||
          observedUrl.searchParams.get("interval") !== panel.requestedInterval
        ) {
          context.addIssue({
            code: "custom",
            path: ["panels", index, side, "pageUrl"],
            message: "Observed page URL must prove the exact HTTPS TradingView layout/symbol/interval.",
          });
        }
        if (observed.overlayMode !== manifest.requested.expectedOverlayMode) {
          context.addIssue({
            code: "custom",
            path: ["panels", index, side, "overlayMode"],
            message: "Observed overlay mode must match the requested mode.",
          });
        }
        const expected = manifest.requested.expectedIndicator;
        const expectedSource =
          manifest.requested.expectedOverlayMode === "builtin_ichimoku_only"
            ? "builtin"
            : manifest.requested.expectedOverlayMode === "saved_layout_pine"
              ? "pine"
              : undefined;
        if (
          expected === undefined
            ? observed.indicator !== undefined
            : observed.indicator === undefined ||
              observed.indicator.identity !== expected.identity ||
              observed.indicator.name !== expected.name ||
              observed.indicator.source !== expectedSource
        ) {
          context.addIssue({
            code: "custom",
            path: ["panels", index, side, "indicator"],
            message: "Observed indicator must exactly match the requested identity and name.",
          });
        }
        const expectedStudyCount = expected === undefined ? 0 : 1;
        if (observed.studyCount !== expectedStudyCount) {
          context.addIssue({
            code: "custom",
            path: ["panels", index, side, "studyCount"],
            message: "Observed study inventory must contain exactly the requested indicator only.",
          });
        }
      }
      if (!panel.png.path.startsWith(`tradingview-captures/${manifest.batchId}/`)) {
        context.addIssue({
          code: "custom",
          path: ["panels", index, "png", "path"],
          message: "PNG path must be contained in this manifest's batch directory.",
        });
      }
      if (paths.has(panel.png.path)) {
        context.addIssue({
          code: "custom",
          path: ["panels", index, "png", "path"],
          message: "Every panel must have a unique PNG path.",
        });
      }
      paths.add(panel.png.path);
    }
    const computedSkewMs = captureStartedValues.at(-1)! - captureStartedValues[0]!;
    if (manifest.captureSkewMs !== computedSkewMs) {
      context.addIssue({
        code: "custom",
        path: ["captureSkewMs"],
        message: "Capture skew must equal the first-to-last panel start-time difference.",
      });
    }
  });

export type TradingViewCaptureBatchInput = z.infer<typeof TradingViewCaptureBatchInputSchema>;
export type TradingViewCaptureBatchManifest = z.infer<
  typeof TradingViewCaptureBatchManifestSchema
>;
export type TradingViewCaptureObservedState = z.infer<
  typeof TradingViewCaptureObservedStateSchema
>;

export const TradingViewHistoryInputSchema = z.object({
  symbol: SymbolSchema.describe("TradingView symbol, for example NASDAQ:AAPL or CME_MINI:ES1!."),
  interval: TradingViewIntervalSchema
    .default("D")
    .describe("TradingView interval, including 1-minute, 240-minute, D, W, and M bars."),
  bars: z
    .number()
    .int()
    .min(1)
    .max(MAX_BARS)
    .default(1_000)
    .describe("Maximum number of most-recent OHLCV bars to return."),
  layoutId: TradingViewLayoutIdSchema.optional(),
  loadChart: z
    .boolean()
    .default(false)
    .describe("Also replace the local viewer data with the returned bars."),
  outputName: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.csv$/i)
    .optional()
    .describe("Optional archive filename without directories."),
}).strict();

export const PriceInputSchema = z.object({
  symbol: SymbolSchema,
  timeframe: PriceTimeframeSchema.default("5"),
  range: z.number().int().min(1).max(5_000).default(10),
  to: z.number().int().positive().optional(),
  type: z.enum(["Japanese", "HeikinAshi", "Range"]).optional(),
  loadChart: z.boolean().default(true),
});

export const QuoteInputSchema = z.object({
  symbol: SymbolSchema,
  session: z.string().min(1).max(30).optional(),
  fields: z.string().min(1).max(500).optional(),
});

export const QuoteBatchInputSchema = z.object({
  symbols: z.array(SymbolSchema).min(1).max(50),
  session: z.string().min(1).max(30).optional(),
  fields: z.string().min(1).max(500).optional(),
});

export const SearchInputSchema = z.object({
  query: z.string().min(1).max(100),
  filter: z.string().min(1).max(50).optional(),
  hl: z.union([z.literal(0), z.literal(1)]).optional(),
  exchange: z.string().min(1).max(40).optional(),
  lang: z.string().min(1).max(20).optional(),
  sort_by_country: z.string().min(1).max(8).optional(),
  enable_grouping: z.boolean().optional(),
});

export const TechnicalAnalysisInputSchema = z.object({
  symbol: SymbolSchema,
  interval: TimeframeSchema.optional(),
});

export const FilterOperationSchema = z.enum([
  "less",
  "less_or_equal",
  "greater",
  "greater_or_equal",
  "equal",
  "nequal",
]);

export const SnapshotInputSchema = z.object({
  symbols: z.array(SymbolSchema).min(1).max(50),
  exchange: z.string().min(1).max(40).optional(),
  customFilters: z
    .array(
      z.object({
        left: z.enum([
          "close",
          "change",
          "volume",
          "volume_change",
          "market_cap_basic",
          "price_earnings_ttm",
          "earnings_per_share_diluted_ttm",
          "sector",
          "ROC",
          "earnings_release_next_date",
        ]),
        operation: FilterOperationSchema,
        right: z.union([z.string(), z.number()]),
      }),
    )
    .max(20)
    .optional(),
  scrapeNewsHeadlines: z.boolean().default(false),
  // Accepted for input compatibility; the local implementation ignores proxy settings.
  proxy: z.unknown().optional(),
});
