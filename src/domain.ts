import { randomUUID } from "node:crypto";

export const MAX_BARS = 10_000;

export interface Bar {
  /** Unix time in whole seconds (UTC). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export type Theme = "dark" | "light";

export type IndicatorKind = "sma" | "ema" | "bollinger" | "rsi" | "macd";

export interface IndicatorSpec {
  id: string;
  kind: IndicatorKind;
  period?: number | undefined;
  fastPeriod?: number | undefined;
  slowPeriod?: number | undefined;
  signalPeriod?: number | undefined;
  standardDeviations?: number | undefined;
  color?: string | undefined;
}

export interface PriceLevel {
  id: string;
  price: number;
  label: string;
  color: string;
}

export type CustomSeriesKind = "line" | "histogram";
export type ChartPane = "price" | "cvd" | "oscillator";
export type ChartLineStyle = "solid" | "dashed" | "dotted";

export interface SeriesPoint {
  /** Unix time in whole seconds (UTC). */
  time: number;
  value: number;
  color?: string | undefined;
}

export interface CustomSeries {
  id: string;
  kind: CustomSeriesKind;
  label: string;
  pane: ChartPane;
  color: string;
  lineWidth: number;
  lineStyle: ChartLineStyle;
  data: SeriesPoint[];
}

export interface ChartZone {
  id: string;
  startTime: number;
  endTime: number;
  upper: number;
  lower: number;
  label: string;
  color: string;
}

export type ChartMarkerPosition = "aboveBar" | "belowBar" | "inBar";
export type ChartMarkerShape = "circle" | "square" | "arrowUp" | "arrowDown";

export interface ChartMarker {
  id: string;
  time: number;
  position: ChartMarkerPosition;
  shape: ChartMarkerShape;
  color: string;
  text: string;
}

export interface ChartState {
  version: 1;
  symbol: string;
  interval: string;
  theme: Theme;
  source: string;
  bars: Bar[];
  indicators: IndicatorSpec[];
  levels: PriceLevel[];
  customSeries: CustomSeries[];
  zones: ChartZone[];
  markers: ChartMarker[];
  revision: number;
  updatedAt: string;
}

export type IndicatorInput = Omit<IndicatorSpec, "id"> & { id?: string | undefined };
export type PriceLevelInput = Omit<PriceLevel, "id"> & { id?: string | undefined };
export type CustomSeriesInput = Omit<CustomSeries, "id"> & { id?: string | undefined };
export type ChartZoneInput = Omit<ChartZone, "id" | "startTime" | "endTime"> & {
  id?: string | undefined;
  startTime: number | string;
  endTime: number | string;
};
export type ChartMarkerInput = Omit<ChartMarker, "id" | "time"> & {
  id?: string | undefined;
  time: number | string;
};

export function createIndicator(input: IndicatorInput): IndicatorSpec {
  return {
    ...input,
    id: input.id?.trim() || randomUUID(),
  };
}

export function createPriceLevel(input: PriceLevelInput): PriceLevel {
  return {
    ...input,
    id: input.id?.trim() || randomUUID(),
  };
}

export function createCustomSeries(input: CustomSeriesInput): CustomSeries {
  return {
    ...input,
    id: input.id?.trim() || randomUUID(),
    data: input.data.map((point) => ({ ...point })),
  };
}

export function createChartZone(input: ChartZoneInput): ChartZone {
  return {
    ...input,
    id: input.id?.trim() || randomUUID(),
    startTime: parseBarTime(input.startTime),
    endTime: parseBarTime(input.endTime),
  };
}

export function createChartMarker(input: ChartMarkerInput): ChartMarker {
  return {
    ...input,
    id: input.id?.trim() || randomUUID(),
    time: parseBarTime(input.time),
  };
}

export function parseBarTime(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    const seconds = value > 10_000_000_000 ? value / 1_000 : value;
    return Math.trunc(seconds);
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Bar time must be a Unix timestamp or an ISO-8601 date/time string.");
  }
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return parseBarTime(Number(trimmed));
  }
  const milliseconds = Date.parse(trimmed);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`Invalid bar time: ${trimmed}`);
  }
  return Math.trunc(milliseconds / 1_000);
}

export function normalizeBar(input: Record<string, unknown>): Bar {
  const optionalVolume = input.volume;
  const bar: Bar = {
    time: parseBarTime(input.time ?? input.timestamp ?? input.date),
    open: numberField(input.open, "open"),
    high: numberField(input.high, "high"),
    low: numberField(input.low, "low"),
    close: numberField(input.close, "close"),
  };
  if (optionalVolume !== undefined && optionalVolume !== null && optionalVolume !== "") {
    bar.volume = numberField(optionalVolume, "volume");
  }
  return bar;
}

export function validateBars(
  bars: readonly Bar[],
  options: { minimum?: number; maximum?: number } = {},
): void {
  const minimum = options.minimum ?? 1;
  const maximum = options.maximum ?? MAX_BARS;
  if (bars.length < minimum) {
    throw new Error(`At least ${minimum} bar(s) are required; received ${bars.length}.`);
  }
  if (bars.length > maximum) {
    throw new Error(`At most ${maximum} bars are accepted; received ${bars.length}.`);
  }

  let previousTime = -Infinity;
  bars.forEach((bar, index) => {
    const prefix = `Bar ${index}`;
    for (const [name, value] of Object.entries(bar)) {
      if (value !== undefined && !Number.isFinite(value)) {
        throw new Error(`${prefix} has a non-finite ${name}.`);
      }
    }
    if (!Number.isInteger(bar.time) || bar.time <= 0) {
      throw new Error(`${prefix} has an invalid Unix time.`);
    }
    if (bar.time <= previousTime) {
      throw new Error(`${prefix} is not strictly later than the previous bar.`);
    }
    if (bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close)) {
      throw new Error(`${prefix} has OHLC values outside its high/low range.`);
    }
    if (bar.low > bar.high) {
      throw new Error(`${prefix} has low greater than high.`);
    }
    if (bar.volume !== undefined && bar.volume < 0) {
      throw new Error(`${prefix} has negative volume.`);
    }
    previousTime = bar.time;
  });
}

function numberField(value: unknown, name: string): number {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isFinite(number)) {
    throw new Error(`Bar ${name} must be a finite number.`);
  }
  return number;
}
