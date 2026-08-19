import type {
  Bar,
  ChartMarker,
  ChartMarkerInput,
  ChartState,
  ChartZone,
  ChartZoneInput,
  CustomSeries,
  CustomSeriesInput,
  IndicatorInput,
  IndicatorSpec,
  PriceLevel,
  PriceLevelInput,
  Theme,
} from "./domain.js";
import {
  createChartMarker,
  createChartZone,
  createCustomSeries,
  createIndicator,
  createPriceLevel,
  validateBars,
} from "./domain.js";

export interface OverlayBundleInput {
  replace: boolean;
  indicators?: IndicatorInput[] | undefined;
  levels?: PriceLevelInput[] | undefined;
  customSeries?: CustomSeriesInput[] | undefined;
  zones?: ChartZoneInput[] | undefined;
  markers?: ChartMarkerInput[] | undefined;
}

export class ChartStore {
  readonly #state: ChartState;

  constructor(initial: {
    bars: Bar[];
    symbol?: string;
    interval?: string;
    source?: string;
    theme?: Theme;
  }) {
    validateBars(initial.bars);
    this.#state = {
      version: 1,
      symbol: initial.symbol ?? "DEMO:MARKET",
      interval: initial.interval ?? "1D",
      theme: initial.theme ?? "dark",
      source: initial.source ?? "synthetic-demo",
      bars: structuredClone(initial.bars),
      indicators: [
        createIndicator({ id: "sma-20", kind: "sma", period: 20, color: "#4cc9f0" }),
        createIndicator({ id: "sma-50", kind: "sma", period: 50, color: "#f59e0b" }),
        createIndicator({ id: "rsi-14", kind: "rsi", period: 14 }),
      ],
      levels: [],
      customSeries: [],
      zones: [],
      markers: [],
      revision: 1,
      updatedAt: new Date().toISOString(),
    };
  }

  getState(): ChartState {
    return structuredClone(this.#state);
  }

  getSummary(): Omit<ChartState, "bars"> & {
    barCount: number;
    firstBar?: Bar;
    lastBar?: Bar;
  } {
    const { bars, ...rest } = this.#state;
    const firstBar = bars[0];
    const lastBar = bars.at(-1);
    return {
      ...structuredClone(rest),
      barCount: bars.length,
      ...(firstBar ? { firstBar: structuredClone(firstBar) } : {}),
      ...(lastBar ? { lastBar: structuredClone(lastBar) } : {}),
    };
  }

  setBars(input: {
    bars: Bar[];
    symbol: string;
    interval: string;
    source: string;
  }): ChartState {
    validateBars(input.bars);
    const bars = structuredClone(input.bars);
    const symbol = sanitizeSymbol(input.symbol);
    const interval = sanitizeInterval(input.interval);
    const source = sanitizeLabel(input.source, "source", 120);
    this.#state.bars = bars;
    this.#state.symbol = symbol;
    this.#state.interval = interval;
    this.#state.source = source;
    return this.#touch();
  }

  setView(input: {
    symbol?: string | undefined;
    interval?: string | undefined;
    theme?: Theme | undefined;
  }): ChartState {
    const symbol = input.symbol === undefined ? this.#state.symbol : sanitizeSymbol(input.symbol);
    const interval =
      input.interval === undefined ? this.#state.interval : sanitizeInterval(input.interval);
    const theme = input.theme === undefined ? this.#state.theme : validateTheme(input.theme);
    this.#state.symbol = symbol;
    this.#state.interval = interval;
    this.#state.theme = theme;
    return this.#touch();
  }

  addIndicator(input: IndicatorInput): IndicatorSpec {
    const indicator = createIndicator(validateIndicator(input));
    const existing = this.#state.indicators.findIndex((entry) => entry.id === indicator.id);
    if (existing >= 0) {
      this.#state.indicators[existing] = indicator;
    } else {
      this.#state.indicators.push(indicator);
    }
    this.#touch();
    return structuredClone(indicator);
  }

  removeIndicator(id: string): boolean {
    const normalized = sanitizeLabel(id, "indicator id", 100);
    const before = this.#state.indicators.length;
    this.#state.indicators = this.#state.indicators.filter((entry) => entry.id !== normalized);
    const removed = before !== this.#state.indicators.length;
    if (removed) {
      this.#touch();
    }
    return removed;
  }

  clearIndicators(): ChartState {
    this.#state.indicators = [];
    return this.#touch();
  }

  addLevel(input: PriceLevelInput): PriceLevel {
    if (!Number.isFinite(input.price)) {
      throw new Error("Price level must be finite.");
    }
    const level = createPriceLevel({
      ...input,
      label: sanitizeLabel(input.label, "price level label", 80),
      color: validateColor(input.color),
    });
    const existing = this.#state.levels.findIndex((entry) => entry.id === level.id);
    if (existing >= 0) {
      this.#state.levels[existing] = level;
    } else {
      this.#state.levels.push(level);
    }
    this.#touch();
    return structuredClone(level);
  }

  removeLevel(id: string): boolean {
    const normalized = sanitizeLabel(id, "price level id", 100);
    const before = this.#state.levels.length;
    this.#state.levels = this.#state.levels.filter((entry) => entry.id !== normalized);
    const removed = before !== this.#state.levels.length;
    if (removed) {
      this.#touch();
    }
    return removed;
  }

  clearLevels(): ChartState {
    this.#state.levels = [];
    return this.#touch();
  }

  addCustomSeries(input: CustomSeriesInput): CustomSeries {
    const series = createCustomSeries(validateCustomSeries(input));
    upsertById(this.#state.customSeries, series);
    this.#touch();
    return structuredClone(series);
  }

  removeCustomSeries(id: string): boolean {
    const normalized = sanitizeLabel(id, "custom series id", 100);
    const removed = removeById(this.#state.customSeries, normalized);
    if (removed) this.#touch();
    return removed;
  }

  addZone(input: ChartZoneInput): ChartZone {
    const zone = createChartZone(validateZone(input));
    upsertById(this.#state.zones, zone);
    this.#touch();
    return structuredClone(zone);
  }

  removeZone(id: string): boolean {
    const normalized = sanitizeLabel(id, "zone id", 100);
    const removed = removeById(this.#state.zones, normalized);
    if (removed) this.#touch();
    return removed;
  }

  addMarker(input: ChartMarkerInput): ChartMarker {
    const marker = createChartMarker(validateMarker(input));
    upsertById(this.#state.markers, marker);
    this.#touch();
    return structuredClone(marker);
  }

  removeMarker(id: string): boolean {
    const normalized = sanitizeLabel(id, "marker id", 100);
    const removed = removeById(this.#state.markers, normalized);
    if (removed) this.#touch();
    return removed;
  }

  applyOverlayBundle(input: OverlayBundleInput): ChartState {
    // Build and validate every object before mutating state so a malformed bundle
    // cannot leave a half-applied trading workspace.
    const indicators = (input.indicators ?? []).map((entry) =>
      createIndicator(validateIndicator(entry)),
    );
    const levels = (input.levels ?? []).map((entry) =>
      createPriceLevel(validatePriceLevel(entry)),
    );
    const customSeries = (input.customSeries ?? []).map((entry) =>
      createCustomSeries(validateCustomSeries(entry)),
    );
    const zones = (input.zones ?? []).map((entry) => createChartZone(validateZone(entry)));
    const markers = (input.markers ?? []).map((entry) =>
      createChartMarker(validateMarker(entry)),
    );

    if (input.replace) {
      this.#state.indicators = indicators;
      this.#state.levels = levels;
      this.#state.customSeries = customSeries;
      this.#state.zones = zones;
      this.#state.markers = markers;
    } else {
      indicators.forEach((entry) => upsertById(this.#state.indicators, entry));
      levels.forEach((entry) => upsertById(this.#state.levels, entry));
      customSeries.forEach((entry) => upsertById(this.#state.customSeries, entry));
      zones.forEach((entry) => upsertById(this.#state.zones, entry));
      markers.forEach((entry) => upsertById(this.#state.markers, entry));
    }
    return this.#touch();
  }

  clearOverlays(): ChartState {
    this.#state.indicators = [];
    this.#state.levels = [];
    this.#state.customSeries = [];
    this.#state.zones = [];
    this.#state.markers = [];
    return this.#touch();
  }

  #touch(): ChartState {
    this.#state.revision += 1;
    this.#state.updatedAt = new Date().toISOString();
    return this.getState();
  }
}

function validateIndicator(input: IndicatorInput): IndicatorInput {
  const period = input.period;
  if (period !== undefined) {
    boundedInteger(period, "period", 2, 500);
  }
  const fastPeriod = input.fastPeriod;
  const slowPeriod = input.slowPeriod;
  const signalPeriod = input.signalPeriod;
  if (fastPeriod !== undefined) boundedInteger(fastPeriod, "fastPeriod", 2, 200);
  if (slowPeriod !== undefined) boundedInteger(slowPeriod, "slowPeriod", 3, 500);
  if (signalPeriod !== undefined) boundedInteger(signalPeriod, "signalPeriod", 2, 200);
  if (fastPeriod !== undefined && slowPeriod !== undefined && fastPeriod >= slowPeriod) {
    throw new Error("fastPeriod must be smaller than slowPeriod.");
  }
  if (
    input.standardDeviations !== undefined &&
    (!Number.isFinite(input.standardDeviations) ||
      input.standardDeviations <= 0 ||
      input.standardDeviations > 10)
  ) {
    throw new Error("standardDeviations must be greater than 0 and at most 10.");
  }
  if (input.color !== undefined) {
    validateColor(input.color);
  }
  return input;
}

function validatePriceLevel(input: PriceLevelInput): PriceLevelInput {
  if (!Number.isFinite(input.price)) throw new Error("Price level must be finite.");
  return {
    ...input,
    ...(input.id === undefined ? {} : { id: sanitizeLabel(input.id, "price level id", 100) }),
    label: sanitizeLabel(input.label, "price level label", 80),
    color: validateColor(input.color),
  };
}

function validateCustomSeries(input: CustomSeriesInput): CustomSeriesInput {
  if (!input.data.length || input.data.length > 20_000) {
    throw new Error("Custom series must contain 1 through 20,000 points.");
  }
  sanitizeLabel(input.label, "custom series label", 80);
  validateColor(input.color);
  boundedInteger(input.lineWidth, "lineWidth", 1, 4);
  let previousTime = -Infinity;
  for (const point of input.data) {
    if (!Number.isInteger(point.time) || point.time <= 0 || point.time <= previousTime) {
      throw new Error("Custom series times must be positive, strictly increasing Unix seconds.");
    }
    if (!Number.isFinite(point.value)) throw new Error("Custom series values must be finite.");
    if (point.color !== undefined) validateColor(point.color);
    previousTime = point.time;
  }
  return {
    ...input,
    ...(input.id === undefined ? {} : { id: sanitizeLabel(input.id, "custom series id", 100) }),
    label: sanitizeLabel(input.label, "custom series label", 80),
    color: validateColor(input.color),
    data: input.data.map((point) => ({
      ...point,
      ...(point.color === undefined ? {} : { color: validateColor(point.color) }),
    })),
  };
}

function validateZone(input: ChartZoneInput): ChartZoneInput {
  const startTime = parseTimeLike(input.startTime, "zone startTime");
  const endTime = parseTimeLike(input.endTime, "zone endTime");
  if (endTime <= startTime) throw new Error("Zone endTime must be later than startTime.");
  if (!Number.isFinite(input.upper) || !Number.isFinite(input.lower) || input.upper <= input.lower) {
    throw new Error("Zone upper must be finite and greater than lower.");
  }
  return {
    ...input,
    ...(input.id === undefined ? {} : { id: sanitizeLabel(input.id, "zone id", 100) }),
    startTime,
    endTime,
    label: sanitizeLabel(input.label, "zone label", 80),
    color: validateColor(input.color),
  };
}

function validateMarker(input: ChartMarkerInput): ChartMarkerInput {
  return {
    ...input,
    ...(input.id === undefined ? {} : { id: sanitizeLabel(input.id, "marker id", 100) }),
    time: parseTimeLike(input.time, "marker time"),
    text: sanitizeLabel(input.text, "marker text", 120),
    color: validateColor(input.color),
  };
}

function parseTimeLike(value: number | string, name: string): number {
  if (typeof value === "number") {
    const seconds = value > 10_000_000_000 ? Math.trunc(value / 1_000) : Math.trunc(value);
    if (seconds > 0) return seconds;
  } else {
    const trimmed = value.trim();
    const numeric = Number(trimmed);
    if (trimmed !== "" && Number.isFinite(numeric)) return parseTimeLike(numeric, name);
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed) && parsed > 0) return Math.trunc(parsed / 1_000);
  }
  throw new Error(`${name} must be a Unix timestamp or ISO-8601 date/time.`);
}

function upsertById<T extends { id: string }>(target: T[], value: T): void {
  const index = target.findIndex((entry) => entry.id === value.id);
  if (index >= 0) target[index] = value;
  else target.push(value);
}

function removeById<T extends { id: string }>(target: T[], id: string): boolean {
  const index = target.findIndex((entry) => entry.id === id);
  if (index < 0) return false;
  target.splice(index, 1);
  return true;
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
}

function sanitizeSymbol(value: string): string {
  const symbol = value.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._:/!+-]{0,99}$/.test(symbol)) {
    throw new Error(`Invalid symbol: ${value}`);
  }
  return symbol;
}

function sanitizeInterval(value: string): string {
  const interval = value.trim();
  if (!/^[A-Za-z0-9]{1,10}$/.test(interval)) {
    throw new Error(`Invalid interval: ${value}`);
  }
  return interval;
}

function sanitizeLabel(value: string, name: string, maximum: number): string {
  const label = value.trim();
  if (label.length === 0 || label.length > maximum || /[\u0000-\u001f\u007f]/.test(label)) {
    throw new Error(`Invalid ${name}.`);
  }
  return label;
}

function validateColor(value: string): string {
  const color = value.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
    throw new Error("Colors must use six-digit hex notation such as #22c55e.");
  }
  return color;
}

function validateTheme(value: string): Theme {
  if (value !== "dark" && value !== "light") {
    throw new Error(`Invalid theme: ${value}`);
  }
  return value;
}
