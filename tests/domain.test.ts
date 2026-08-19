import { describe, expect, it } from "vitest";

import {
  MAX_BARS,
  normalizeBar,
  parseBarTime,
  validateBars,
  type Bar,
} from "../src/domain.js";
import { BarInputSchema } from "../src/schemas.js";

describe("parseBarTime", () => {
  it("normalizes Unix seconds, Unix milliseconds, numeric strings, and ISO dates", () => {
    expect(parseBarTime(1_700_000_000)).toBe(1_700_000_000);
    expect(parseBarTime(1_700_000_000_999)).toBe(1_700_000_000);
    expect(parseBarTime("1700000000123")).toBe(1_700_000_000);
    expect(parseBarTime("2024-01-01T00:00:00.999Z")).toBe(1_704_067_200);
  });

  it("rejects empty and invalid time values", () => {
    expect(() => parseBarTime(undefined)).toThrow(/Unix timestamp or an ISO-8601/i);
    expect(() => parseBarTime("   ")).toThrow(/Unix timestamp or an ISO-8601/i);
    expect(() => parseBarTime("not-a-date")).toThrow(/invalid bar time/i);
    expect(() => parseBarTime(Number.POSITIVE_INFINITY)).toThrow(/Unix timestamp or an ISO-8601/i);
  });
});

describe("normalizeBar", () => {
  it("accepts timestamp/date aliases and coerces finite numeric fields", () => {
    expect(
      normalizeBar({
        timestamp: "2024-01-01T00:00:00Z",
        open: "10",
        high: "12.5",
        low: 9,
        close: "11",
        volume: "1000",
      }),
    ).toEqual({
      time: 1_704_067_200,
      open: 10,
      high: 12.5,
      low: 9,
      close: 11,
      volume: 1_000,
    });

    expect(
      normalizeBar({ date: "2024-01-02", open: 10, high: 11, low: 9, close: 10, volume: "" }),
    ).toEqual({ time: 1_704_153_600, open: 10, high: 11, low: 9, close: 10 });
  });

  it("rejects missing or non-finite prices", () => {
    expect(() =>
      normalizeBar({ time: 1, open: 1, high: 2, low: 0, close: "nope" }),
    ).toThrow(/close must be a finite number/i);

    for (const value of [null, "", "   ", false, true]) {
      expect(() =>
        normalizeBar({ time: 1, open: value, high: 2, low: 0, close: 1 }),
      ).toThrow(/open must be a finite number/i);
      expect(() =>
        BarInputSchema.parse({ time: 1, open: value, high: 2, low: 0, close: 1 }),
      ).toThrow();
    }
  });
});

describe("validateBars", () => {
  const valid: Bar[] = [
    { time: 1_700_000_000, open: 10, high: 12, low: 9, close: 11, volume: 100 },
    { time: 1_700_000_060, open: 11, high: 13, low: 10, close: 12, volume: 200 },
  ];

  it("accepts strictly ordered finite OHLCV bars and custom count bounds", () => {
    expect(() => validateBars(valid)).not.toThrow();
    expect(() => validateBars(valid, { minimum: 3 })).toThrow(/at least 3/i);
    expect(() => validateBars(valid, { maximum: 1 })).toThrow(/at most 1/i);
    expect(MAX_BARS).toBe(10_000);
  });

  it.each([
    {
      name: "duplicate time",
      bars: [valid[0]!, { ...valid[1]!, time: valid[0]!.time }],
      message: /strictly later/i,
    },
    {
      name: "fractional time",
      bars: [{ ...valid[0]!, time: 1.5 }],
      message: /invalid Unix time/i,
    },
    {
      name: "non-finite field",
      bars: [{ ...valid[0]!, close: Number.NaN }],
      message: /non-finite close/i,
    },
    {
      name: "high below the body",
      bars: [{ ...valid[0]!, high: 9.5 }],
      message: /OHLC values outside/i,
    },
    {
      name: "low above the body",
      bars: [{ ...valid[0]!, low: 10.5 }],
      message: /OHLC values outside/i,
    },
    {
      name: "negative volume",
      bars: [{ ...valid[0]!, volume: -1 }],
      message: /negative volume/i,
    },
  ])("rejects $name", ({ bars, message }) => {
    expect(() => validateBars(bars)).toThrow(message);
  });
});
