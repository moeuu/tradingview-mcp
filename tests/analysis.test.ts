import { describe, expect, it } from "vitest";

import {
  analyzeBars,
  calculateATR,
  calculateBollingerBands,
  calculateEMA,
  calculateMACD,
  calculateRSI,
  calculateSMA,
} from "../src/analysis.js";
import { generateDemoBars } from "../src/demo.js";
import type { Bar } from "../src/domain.js";

describe("moving averages", () => {
  it("keeps the source alignment and uses an SMA seed for EMA", () => {
    const values = [1, 2, 3, 4, 5];

    expect(calculateSMA(values, 3)).toEqual([null, null, 2, 3, 4]);
    expect(calculateEMA(values, 3)).toEqual([null, null, 2, 3, 4]);
  });

  it("validates periods and finite values", () => {
    expect(() => calculateSMA([1, 2], 0)).toThrow(/positive integer/i);
    expect(() => calculateEMA([1, Number.NaN], 2)).toThrow(/finite number/i);
  });
});

describe("momentum and volatility indicators", () => {
  it("calculates Wilder RSI, including flat and one-way markets", () => {
    expect(calculateRSI([1, 2, 3, 4], 3)).toEqual([null, null, null, 100]);
    expect(calculateRSI([4, 3, 2, 1], 3)).toEqual([null, null, null, 0]);
    expect(calculateRSI([2, 2, 2, 2], 3)).toEqual([null, null, null, 50]);
  });

  it("calculates population-standard-deviation Bollinger bands", () => {
    const bands = calculateBollingerBands([1, 2, 3, 4, 5], 5, 2);

    expect(bands.middle).toEqual([null, null, null, null, 3]);
    expect(bands.upper[4]).toBeCloseTo(3 + 2 * Math.sqrt(2), 12);
    expect(bands.lower[4]).toBeCloseTo(3 - 2 * Math.sqrt(2), 12);
  });

  it("aligns MACD and its independently warmed-up signal line", () => {
    const values = Array.from({ length: 60 }, (_, index) => index + 1);
    const result = calculateMACD(values);

    expect(result.macd.slice(0, 25)).toEqual(new Array(25).fill(null));
    expect(result.macd[25]).toBeCloseTo(7, 12);
    expect(result.signal[32]).toBeNull();
    expect(result.signal[33]).toBeCloseTo(7, 12);
    expect(result.histogram[59]).toBeCloseTo(0, 12);
    expect(() => calculateMACD(values, 26, 12, 9)).toThrow(/fast period/i);
  });

  it("calculates true range across gaps and applies Wilder smoothing", () => {
    const bars: Bar[] = [
      { time: 1, open: 9, high: 10, low: 8, close: 9 },
      { time: 2, open: 9, high: 11, low: 9, close: 10 },
      { time: 3, open: 10, high: 13, low: 10, close: 12 },
      { time: 4, open: 12, high: 14, low: 11, close: 13 },
    ];

    const atr = calculateATR(bars, 3);
    expect(atr.slice(0, 2)).toEqual([null, null]);
    expect(atr[2]).toBeCloseTo(7 / 3, 12);
    expect(atr[3]).toBeCloseTo(23 / 9, 12);
  });
});

describe("analyzeBars", () => {
  it("returns a stable analysis snapshot without mutating source bars", () => {
    const bars = generateDemoBars(320, { seed: 42 });
    const sourceSnapshot = structuredClone(bars);

    const first = analyzeBars(bars);
    const second = analyzeBars(bars);

    expect(first).toEqual(second);
    expect(bars).toEqual(sourceSnapshot);
    expect(first.barsAnalyzed).toBe(320);
    expect(first.asOf).toBe(bars.at(-1)?.time);
    expect(first.indicators.sma20).not.toBeNull();
    expect(first.indicators.sma50).not.toBeNull();
    expect(first.indicators.sma200).not.toBeNull();
    expect(first.indicators.rsi14).toBeGreaterThanOrEqual(0);
    expect(first.indicators.rsi14).toBeLessThanOrEqual(100);
    expect(first.indicators.atr14).toBeGreaterThan(0);
    expect(first.indicators.bollinger).not.toBeNull();
    expect(first.indicators.macd?.signal).not.toBeNull();
    expect(first.trend.score).toBeGreaterThanOrEqual(-100);
    expect(first.trend.score).toBeLessThanOrEqual(100);
    expect(first.signals.length).toBeGreaterThan(0);
    expect(first.levels.support.length).toBeGreaterThan(0);
    expect(first.levels.resistance.length).toBeGreaterThan(0);
    expect(first.summary).toContain("Close");
  });

  it("reports warm-up values as null when history is short", () => {
    const analysis = analyzeBars(generateDemoBars(1));

    expect(analysis.latest.change).toBeNull();
    expect(analysis.indicators.sma20).toBeNull();
    expect(analysis.indicators.rsi14).toBeNull();
    expect(analysis.indicators.macd).toBeNull();
    expect(analysis.trend.direction).toBe("sideways");
  });

  it("rejects invalid or unordered bars", () => {
    expect(() => analyzeBars([])).toThrow(/at least 1/i);
    expect(() =>
      analyzeBars([
        { time: 2, open: 10, high: 11, low: 9, close: 10 },
        { time: 1, open: 10, high: 11, low: 9, close: 10 },
      ]),
    ).toThrow(/strictly later/i);
    expect(() =>
      analyzeBars([{ time: 1, open: 10, high: 9, low: 8, close: 10 }]),
    ).toThrow(/OHLC bounds/i);
  });
});
