import type { Bar } from "./domain.js";

/** A series keeps its input alignment by representing warm-up values as null. */
export type IndicatorSeries = Array<number | null>;

export interface BollingerBandsSeries {
  middle: IndicatorSeries;
  upper: IndicatorSeries;
  lower: IndicatorSeries;
}

export interface MacdSeries {
  macd: IndicatorSeries;
  signal: IndicatorSeries;
  histogram: IndicatorSeries;
}

export type TrendDirection = "bullish" | "bearish" | "sideways";
export type TrendStrength = "weak" | "moderate" | "strong";
export type SignalDirection = "bullish" | "bearish" | "neutral";

export interface AnalysisSignal {
  id: string;
  indicator: string;
  direction: SignalDirection;
  strength: TrendStrength;
  message: string;
}

export interface AnalysisLevel {
  price: number;
  touches: number;
  distancePercent: number;
}

export interface TrendAnalysis {
  direction: TrendDirection;
  strength: TrendStrength;
  /** Normalized vote score from -100 (bearish) to +100 (bullish). */
  score: number;
  evidence: string[];
}

export interface LatestIndicators {
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  ema12: number | null;
  ema26: number | null;
  rsi14: number | null;
  atr14: number | null;
  bollinger: {
    middle: number;
    upper: number;
    lower: number;
    widthPercent: number;
  } | null;
  macd: {
    macd: number;
    signal: number | null;
    histogram: number | null;
  } | null;
}

export interface AnalysisResult {
  barsAnalyzed: number;
  /** Unix time in whole seconds of the latest bar. */
  asOf: number;
  summary: string;
  latest: {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number | null;
    change: number | null;
    changePercent: number | null;
    periodHigh: number;
    periodLow: number;
  };
  indicators: LatestIndicators;
  trend: TrendAnalysis;
  signals: AnalysisSignal[];
  levels: {
    support: AnalysisLevel[];
    resistance: AnalysisLevel[];
  };
}

const MAX_ANALYSIS_BARS = 10_000;

/** Simple moving average. The first `period - 1` entries are null. */
export function calculateSMA(values: readonly number[], period: number): IndicatorSeries {
  validateNumberSeries(values);
  validatePeriod(period, "SMA period");

  const output: IndicatorSeries = new Array(values.length).fill(null);
  if (values.length < period) {
    return output;
  }

  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += requiredAt(values, index);
    if (index >= period) {
      sum -= requiredAt(values, index - period);
    }
    if (index >= period - 1) {
      output[index] = sum / period;
    }
  }
  return output;
}

/**
 * Exponential moving average seeded with the first period's SMA. This avoids an
 * arbitrary first-value seed and matches the convention used by most charting tools.
 */
export function calculateEMA(values: readonly number[], period: number): IndicatorSeries {
  validateNumberSeries(values);
  validatePeriod(period, "EMA period");

  const output: IndicatorSeries = new Array(values.length).fill(null);
  if (values.length < period) {
    return output;
  }

  let seed = 0;
  for (let index = 0; index < period; index += 1) {
    seed += requiredAt(values, index);
  }
  let previous = seed / period;
  output[period - 1] = previous;

  const multiplier = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) {
    const current = requiredAt(values, index) * multiplier + previous * (1 - multiplier);
    output[index] = current;
    previous = current;
  }
  return output;
}

/** Wilder RSI. The first usable value is at index `period`. */
export function calculateRSI(values: readonly number[], period = 14): IndicatorSeries {
  validateNumberSeries(values);
  validatePeriod(period, "RSI period");

  const output: IndicatorSeries = new Array(values.length).fill(null);
  if (values.length <= period) {
    return output;
  }

  let gainSum = 0;
  let lossSum = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = requiredAt(values, index) - requiredAt(values, index - 1);
    gainSum += Math.max(change, 0);
    lossSum += Math.max(-change, 0);
  }

  let averageGain = gainSum / period;
  let averageLoss = lossSum / period;
  output[period] = rsiFromAverages(averageGain, averageLoss);

  for (let index = period + 1; index < values.length; index += 1) {
    const change = requiredAt(values, index) - requiredAt(values, index - 1);
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    output[index] = rsiFromAverages(averageGain, averageLoss);
  }
  return output;
}

/** Bollinger bands using the population standard deviation. */
export function calculateBollingerBands(
  values: readonly number[],
  period = 20,
  standardDeviations = 2,
): BollingerBandsSeries {
  validateNumberSeries(values);
  validatePeriod(period, "Bollinger period");
  if (!Number.isFinite(standardDeviations) || standardDeviations <= 0) {
    throw new Error("Bollinger standard deviations must be a positive finite number.");
  }

  const middle = calculateSMA(values, period);
  const upper: IndicatorSeries = new Array(values.length).fill(null);
  const lower: IndicatorSeries = new Array(values.length).fill(null);

  for (let index = period - 1; index < values.length; index += 1) {
    const mean = middle[index];
    if (mean === null || mean === undefined) {
      continue;
    }
    let squaredDifferenceSum = 0;
    for (let sample = index - period + 1; sample <= index; sample += 1) {
      const difference = requiredAt(values, sample) - mean;
      squaredDifferenceSum += difference * difference;
    }
    const deviation = Math.sqrt(squaredDifferenceSum / period);
    upper[index] = mean + deviation * standardDeviations;
    lower[index] = mean - deviation * standardDeviations;
  }

  return { middle, upper, lower };
}

/** Moving Average Convergence Divergence with an EMA signal line. */
export function calculateMACD(
  values: readonly number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdSeries {
  validateNumberSeries(values);
  validatePeriod(fastPeriod, "MACD fast period");
  validatePeriod(slowPeriod, "MACD slow period");
  validatePeriod(signalPeriod, "MACD signal period");
  if (fastPeriod >= slowPeriod) {
    throw new Error("MACD fast period must be less than the slow period.");
  }

  const fast = calculateEMA(values, fastPeriod);
  const slow = calculateEMA(values, slowPeriod);
  const macd: IndicatorSeries = new Array(values.length).fill(null);
  const validMacd: number[] = [];
  const validIndexes: number[] = [];

  for (let index = 0; index < values.length; index += 1) {
    const fastValue = fast[index];
    const slowValue = slow[index];
    if (fastValue !== null && fastValue !== undefined && slowValue !== null && slowValue !== undefined) {
      const value = fastValue - slowValue;
      macd[index] = value;
      validMacd.push(value);
      validIndexes.push(index);
    }
  }

  const compactSignal = calculateEMA(validMacd, signalPeriod);
  const signal: IndicatorSeries = new Array(values.length).fill(null);
  const histogram: IndicatorSeries = new Array(values.length).fill(null);
  for (let compactIndex = 0; compactIndex < validIndexes.length; compactIndex += 1) {
    const sourceIndex = requiredAt(validIndexes, compactIndex);
    const signalValue = compactSignal[compactIndex];
    if (signalValue !== null && signalValue !== undefined) {
      signal[sourceIndex] = signalValue;
      histogram[sourceIndex] = requiredAt(validMacd, compactIndex) - signalValue;
    }
  }

  return { macd, signal, histogram };
}

/** Average True Range with Wilder smoothing. */
export function calculateATR(bars: readonly Bar[], period = 14): IndicatorSeries {
  validatePeriod(period, "ATR period");
  validateBarSeries(bars, 0);

  const output: IndicatorSeries = new Array(bars.length).fill(null);
  if (bars.length < period) {
    return output;
  }

  const trueRanges: number[] = [];
  for (let index = 0; index < bars.length; index += 1) {
    const bar = requiredAt(bars, index);
    const previous = index > 0 ? requiredAt(bars, index - 1) : null;
    const range = previous === null
      ? bar.high - bar.low
      : Math.max(
          bar.high - bar.low,
          Math.abs(bar.high - previous.close),
          Math.abs(bar.low - previous.close),
        );
    trueRanges.push(range);
  }

  let seed = 0;
  for (let index = 0; index < period; index += 1) {
    seed += requiredAt(trueRanges, index);
  }
  let previousAtr = seed / period;
  output[period - 1] = previousAtr;

  for (let index = period; index < bars.length; index += 1) {
    previousAtr = (previousAtr * (period - 1) + requiredAt(trueRanges, index)) / period;
    output[index] = previousAtr;
  }
  return output;
}

/** Produce a deterministic, read-only technical-analysis snapshot for OHLC bars. */
export function analyzeBars(bars: readonly Bar[]): AnalysisResult {
  validateBarSeries(bars, 1);
  if (bars.length > MAX_ANALYSIS_BARS) {
    throw new Error(`At most ${MAX_ANALYSIS_BARS} bars can be analyzed; received ${bars.length}.`);
  }

  const latestIndex = bars.length - 1;
  const latestBar = requiredAt(bars, latestIndex);
  const previousBar = latestIndex > 0 ? requiredAt(bars, latestIndex - 1) : null;
  const closes = bars.map((bar) => bar.close);

  const sma20Series = calculateSMA(closes, 20);
  const sma50Series = calculateSMA(closes, 50);
  const sma200Series = calculateSMA(closes, 200);
  const ema12Series = calculateEMA(closes, 12);
  const ema26Series = calculateEMA(closes, 26);
  const rsi14Series = calculateRSI(closes, 14);
  const atr14Series = calculateATR(bars, 14);
  const bollingerSeries = calculateBollingerBands(closes, 20, 2);
  const macdSeries = calculateMACD(closes, 12, 26, 9);

  const bollingerMiddle = nullableAt(bollingerSeries.middle, latestIndex);
  const bollingerUpper = nullableAt(bollingerSeries.upper, latestIndex);
  const bollingerLower = nullableAt(bollingerSeries.lower, latestIndex);
  const macdValue = nullableAt(macdSeries.macd, latestIndex);
  const macdSignal = nullableAt(macdSeries.signal, latestIndex);
  const macdHistogram = nullableAt(macdSeries.histogram, latestIndex);

  const indicators: LatestIndicators = {
    sma20: nullableAt(sma20Series, latestIndex),
    sma50: nullableAt(sma50Series, latestIndex),
    sma200: nullableAt(sma200Series, latestIndex),
    ema12: nullableAt(ema12Series, latestIndex),
    ema26: nullableAt(ema26Series, latestIndex),
    rsi14: nullableAt(rsi14Series, latestIndex),
    atr14: nullableAt(atr14Series, latestIndex),
    bollinger:
      bollingerMiddle !== null && bollingerUpper !== null && bollingerLower !== null
        ? {
            middle: bollingerMiddle,
            upper: bollingerUpper,
            lower: bollingerLower,
            widthPercent:
              Math.abs(bollingerMiddle) > Number.EPSILON
                ? ((bollingerUpper - bollingerLower) / Math.abs(bollingerMiddle)) * 100
                : 0,
          }
        : null,
    macd:
      macdValue === null
        ? null
        : { macd: macdValue, signal: macdSignal, histogram: macdHistogram },
  };

  const trend = evaluateTrend(latestBar.close, indicators);
  const levels = findSupportAndResistance(bars, latestBar.close, indicators.atr14);
  const signals = buildSignals({
    closes,
    latestIndex,
    indicators,
    trend,
    ema12Series,
    ema26Series,
    macdSeries,
  });

  const change = previousBar === null ? null : latestBar.close - previousBar.close;
  const changePercent =
    previousBar === null || Math.abs(previousBar.close) <= Number.EPSILON
      ? null
      : (change as number) / Math.abs(previousBar.close) * 100;
  const periodHigh = Math.max(...bars.map((bar) => bar.high));
  const periodLow = Math.min(...bars.map((bar) => bar.low));

  return {
    barsAnalyzed: bars.length,
    asOf: latestBar.time,
    summary: createSummary(latestBar.close, changePercent, indicators, trend, levels),
    latest: {
      open: latestBar.open,
      high: latestBar.high,
      low: latestBar.low,
      close: latestBar.close,
      volume: latestBar.volume ?? null,
      change,
      changePercent,
      periodHigh,
      periodLow,
    },
    indicators,
    trend,
    signals,
    levels,
  };
}

interface SignalInputs {
  closes: readonly number[];
  latestIndex: number;
  indicators: LatestIndicators;
  trend: TrendAnalysis;
  ema12Series: IndicatorSeries;
  ema26Series: IndicatorSeries;
  macdSeries: MacdSeries;
}

function evaluateTrend(close: number, indicators: LatestIndicators): TrendAnalysis {
  let votes = 0;
  let possibleVotes = 0;
  const evidence: string[] = [];

  const vote = (left: number | null, right: number | null, bullish: string, bearish: string): void => {
    if (left === null || right === null) {
      return;
    }
    possibleVotes += 1;
    if (left > right) {
      votes += 1;
      evidence.push(bullish);
    } else if (left < right) {
      votes -= 1;
      evidence.push(bearish);
    }
  };

  vote(close, indicators.sma20, "Price is above SMA(20).", "Price is below SMA(20).");
  vote(indicators.sma20, indicators.sma50, "SMA(20) is above SMA(50).", "SMA(20) is below SMA(50).");
  vote(indicators.sma50, indicators.sma200, "SMA(50) is above SMA(200).", "SMA(50) is below SMA(200).");
  vote(indicators.ema12, indicators.ema26, "EMA(12) is above EMA(26).", "EMA(12) is below EMA(26).");
  vote(indicators.macd?.histogram ?? null, 0, "MACD histogram is positive.", "MACD histogram is negative.");

  if (indicators.rsi14 !== null) {
    if (indicators.rsi14 > 55) {
      votes += 1;
      evidence.push("RSI momentum is above 55.");
    } else if (indicators.rsi14 < 45) {
      votes -= 1;
      evidence.push("RSI momentum is below 45.");
    }
    possibleVotes += 1;
  }

  const score = possibleVotes === 0 ? 0 : Math.round((votes / possibleVotes) * 100);
  const direction: TrendDirection = score >= 25 ? "bullish" : score <= -25 ? "bearish" : "sideways";
  const magnitude = Math.abs(score);
  const strength: TrendStrength = magnitude >= 70 ? "strong" : magnitude >= 40 ? "moderate" : "weak";

  if (evidence.length === 0) {
    evidence.push("More history is required for moving-average trend confirmation.");
  }
  return { direction, strength, score, evidence };
}

function buildSignals(input: SignalInputs): AnalysisSignal[] {
  const signals: AnalysisSignal[] = [];
  const { indicators, latestIndex } = input;

  if (input.trend.direction !== "sideways") {
    signals.push({
      id: "trend-alignment",
      indicator: "trend",
      direction: input.trend.direction,
      strength: input.trend.strength,
      message: `${capitalize(input.trend.strength)} ${input.trend.direction} indicator alignment (${input.trend.score}).`,
    });
  }

  if (indicators.rsi14 !== null && indicators.rsi14 >= 70) {
    signals.push({
      id: "rsi-overbought",
      indicator: "RSI(14)",
      direction: "bearish",
      strength: indicators.rsi14 >= 80 ? "strong" : "moderate",
      message: `RSI is overbought at ${formatNumber(indicators.rsi14, 1)}.`,
    });
  } else if (indicators.rsi14 !== null && indicators.rsi14 <= 30) {
    signals.push({
      id: "rsi-oversold",
      indicator: "RSI(14)",
      direction: "bullish",
      strength: indicators.rsi14 <= 20 ? "strong" : "moderate",
      message: `RSI is oversold at ${formatNumber(indicators.rsi14, 1)}.`,
    });
  }

  const previousIndex = latestIndex - 1;
  if (previousIndex >= 0) {
    addCrossoverSignal(
      signals,
      "ema-crossover",
      "EMA(12/26)",
      nullableAt(input.ema12Series, previousIndex),
      nullableAt(input.ema26Series, previousIndex),
      nullableAt(input.ema12Series, latestIndex),
      nullableAt(input.ema26Series, latestIndex),
    );
    addCrossoverSignal(
      signals,
      "macd-crossover",
      "MACD",
      nullableAt(input.macdSeries.macd, previousIndex),
      nullableAt(input.macdSeries.signal, previousIndex),
      nullableAt(input.macdSeries.macd, latestIndex),
      nullableAt(input.macdSeries.signal, latestIndex),
    );
  }

  const close = requiredAt(input.closes, latestIndex);
  if (indicators.bollinger !== null && close > indicators.bollinger.upper) {
    signals.push({
      id: "bollinger-upper-break",
      indicator: "Bollinger Bands",
      direction: "bearish",
      strength: "moderate",
      message: "Close is above the upper Bollinger Band; price may be extended.",
    });
  } else if (indicators.bollinger !== null && close < indicators.bollinger.lower) {
    signals.push({
      id: "bollinger-lower-break",
      indicator: "Bollinger Bands",
      direction: "bullish",
      strength: "moderate",
      message: "Close is below the lower Bollinger Band; price may be extended.",
    });
  }

  if (signals.length === 0) {
    signals.push({
      id: "no-confirmed-signal",
      indicator: "combined",
      direction: "neutral",
      strength: "weak",
      message: "No confirmed directional signal is available from the current history.",
    });
  }
  return signals;
}

function addCrossoverSignal(
  signals: AnalysisSignal[],
  id: string,
  indicator: string,
  previousFast: number | null,
  previousSlow: number | null,
  currentFast: number | null,
  currentSlow: number | null,
): void {
  if (previousFast === null || previousSlow === null || currentFast === null || currentSlow === null) {
    return;
  }
  if (previousFast <= previousSlow && currentFast > currentSlow) {
    signals.push({
      id: `${id}-bullish`,
      indicator,
      direction: "bullish",
      strength: "moderate",
      message: `${indicator} made a bullish crossover on the latest bar.`,
    });
  } else if (previousFast >= previousSlow && currentFast < currentSlow) {
    signals.push({
      id: `${id}-bearish`,
      indicator,
      direction: "bearish",
      strength: "moderate",
      message: `${indicator} made a bearish crossover on the latest bar.`,
    });
  }
}

function findSupportAndResistance(
  bars: readonly Bar[],
  currentPrice: number,
  atr: number | null,
): AnalysisResult["levels"] {
  const window = bars.slice(-Math.min(200, bars.length));
  const span = window.length >= 11 ? 2 : 1;
  const lowCandidates: number[] = [];
  const highCandidates: number[] = [];

  for (let index = span; index < window.length - span; index += 1) {
    const bar = requiredAt(window, index);
    let pivotLow = true;
    let pivotHigh = true;
    for (let offset = 1; offset <= span; offset += 1) {
      const before = requiredAt(window, index - offset);
      const after = requiredAt(window, index + offset);
      pivotLow = pivotLow && bar.low <= before.low && bar.low <= after.low;
      pivotHigh = pivotHigh && bar.high >= before.high && bar.high >= after.high;
    }
    if (pivotLow) {
      lowCandidates.push(bar.low);
    }
    if (pivotHigh) {
      highCandidates.push(bar.high);
    }
  }

  lowCandidates.push(Math.min(...window.map((bar) => bar.low)));
  highCandidates.push(Math.max(...window.map((bar) => bar.high)));

  const tolerance = Math.max(Math.abs(currentPrice) * 0.0025, (atr ?? 0) * 0.35, Number.EPSILON);
  const support = clusterLevels(lowCandidates, tolerance)
    .filter((level) => level.price <= currentPrice)
    .sort((left, right) => right.price - left.price)
    .slice(0, 3)
    .map((level) => withDistance(level, currentPrice));
  const resistance = clusterLevels(highCandidates, tolerance)
    .filter((level) => level.price >= currentPrice)
    .sort((left, right) => left.price - right.price)
    .slice(0, 3)
    .map((level) => withDistance(level, currentPrice));

  return { support, resistance };
}

function clusterLevels(prices: readonly number[], tolerance: number): Array<{ price: number; touches: number }> {
  const sorted = [...prices].sort((left, right) => left - right);
  const clusters: Array<{ price: number; touches: number }> = [];
  for (const price of sorted) {
    const previous = clusters.at(-1);
    if (previous !== undefined && Math.abs(price - previous.price) <= tolerance) {
      previous.price = (previous.price * previous.touches + price) / (previous.touches + 1);
      previous.touches += 1;
    } else {
      clusters.push({ price, touches: 1 });
    }
  }
  return clusters;
}

function withDistance(level: { price: number; touches: number }, currentPrice: number): AnalysisLevel {
  const denominator = Math.max(Math.abs(currentPrice), Number.EPSILON);
  return {
    price: level.price,
    touches: level.touches,
    distancePercent: (Math.abs(currentPrice - level.price) / denominator) * 100,
  };
}

function createSummary(
  close: number,
  changePercent: number | null,
  indicators: LatestIndicators,
  trend: TrendAnalysis,
  levels: AnalysisResult["levels"],
): string {
  const movement =
    changePercent === null
      ? "with no prior-bar comparison"
      : `${changePercent >= 0 ? "up" : "down"} ${formatNumber(Math.abs(changePercent), 2)}% on the latest bar`;
  const rsi = indicators.rsi14 === null ? "RSI(14) is warming up" : `RSI(14) is ${formatNumber(indicators.rsi14, 1)}`;
  const nearestSupport = levels.support[0];
  const nearestResistance = levels.resistance[0];
  const levelText = [
    nearestSupport === undefined ? null : `support ${formatNumber(nearestSupport.price, 4)}`,
    nearestResistance === undefined ? null : `resistance ${formatNumber(nearestResistance.price, 4)}`,
  ].filter((value): value is string => value !== null).join(" and ");

  return `${capitalize(trend.strength)} ${trend.direction} trend. Close ${formatNumber(close, 4)}, ${movement}; ${rsi}.${levelText === "" ? "" : ` Nearest ${levelText}.`}`;
}

function rsiFromAverages(averageGain: number, averageLoss: number): number {
  if (averageGain === 0 && averageLoss === 0) {
    return 50;
  }
  if (averageLoss === 0) {
    return 100;
  }
  if (averageGain === 0) {
    return 0;
  }
  const relativeStrength = averageGain / averageLoss;
  return 100 - 100 / (1 + relativeStrength);
}

function validatePeriod(period: number, name: string): void {
  if (!Number.isInteger(period) || period <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function validateNumberSeries(values: readonly number[]): void {
  if (!Array.isArray(values)) {
    throw new Error("Indicator values must be an array.");
  }
  values.forEach((value, index) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Indicator value at index ${index} must be a finite number.`);
    }
  });
}

function validateBarSeries(bars: readonly Bar[], minimum: number): void {
  if (!Array.isArray(bars)) {
    throw new Error("Bars must be an array.");
  }
  if (bars.length < minimum) {
    throw new Error(`At least ${minimum} bar(s) are required; received ${bars.length}.`);
  }

  let previousTime = -Infinity;
  bars.forEach((bar, index) => {
    if (bar === null || typeof bar !== "object") {
      throw new Error(`Bar ${index} must be an object.`);
    }
    if (!Number.isInteger(bar.time) || bar.time <= 0) {
      throw new Error(`Bar ${index} has an invalid Unix time.`);
    }
    if (bar.time <= previousTime) {
      throw new Error(`Bar ${index} is not strictly later than the previous bar.`);
    }
    const prices = [bar.open, bar.high, bar.low, bar.close];
    if (prices.some((price) => typeof price !== "number" || !Number.isFinite(price))) {
      throw new Error(`Bar ${index} contains a non-finite OHLC value.`);
    }
    if (bar.low > bar.high || bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close)) {
      throw new Error(`Bar ${index} has invalid OHLC bounds.`);
    }
    if (bar.volume !== undefined && (!Number.isFinite(bar.volume) || bar.volume < 0)) {
      throw new Error(`Bar ${index} has invalid volume.`);
    }
    previousTime = bar.time;
  });
}

function nullableAt(values: IndicatorSeries, index: number): number | null {
  return values[index] ?? null;
}

function requiredAt<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`Internal series index ${index} is out of bounds.`);
  }
  return value;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]?.toUpperCase() + value.slice(1);
}

function formatNumber(value: number, maximumDecimals: number): string {
  return value.toFixed(maximumDecimals).replace(/\.?0+$/u, "");
}

// Concise aliases are convenient for callers using this module as an indicator library.
export const sma = calculateSMA;
export const ema = calculateEMA;
export const rsi = calculateRSI;
export const bollingerBands = calculateBollingerBands;
export const macd = calculateMACD;
export const atr = calculateATR;
