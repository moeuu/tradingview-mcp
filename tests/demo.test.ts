import { describe, expect, it } from "vitest";

import {
  DEFAULT_DEMO_BAR_COUNT,
  DEFAULT_DEMO_START_TIME,
  DEMO_BARS,
  createDemoBars,
  generateDemoBars,
} from "../src/demo.js";

describe("generateDemoBars", () => {
  it("is deterministic and has a stable first-bar fixture", () => {
    const first = generateDemoBars(3);
    const second = generateDemoBars(3);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first[0]).toEqual({
      time: DEFAULT_DEMO_START_TIME,
      open: 99.9264,
      high: 100.1842,
      low: 99.1846,
      close: 99.7568,
      volume: 903_341,
    });
  });

  it("honors time, seed, interval, and price options", () => {
    const options = { startTime: 1_700_000_000, intervalSeconds: 60, seed: 7, startPrice: 250 };
    const bars = createDemoBars(5, options);

    expect(bars).toHaveLength(5);
    expect(bars[0]?.time).toBe(options.startTime);
    expect(bars[4]?.time).toBe(options.startTime + 4 * options.intervalSeconds);
    expect(bars[0]?.open).toBeGreaterThan(240);
    expect(generateDemoBars(5, { ...options, seed: 8 })).not.toEqual(bars);
  });

  it("always emits valid, strictly ordered OHLCV bars", () => {
    const bars = generateDemoBars(500, { seed: -123 });

    for (let index = 0; index < bars.length; index += 1) {
      const bar = bars[index];
      expect(bar).toBeDefined();
      if (bar === undefined) continue;
      expect(bar.high).toBeGreaterThanOrEqual(Math.max(bar.open, bar.close));
      expect(bar.low).toBeLessThanOrEqual(Math.min(bar.open, bar.close));
      expect(bar.low).toBeGreaterThanOrEqual(0);
      expect(bar.volume).toBeGreaterThanOrEqual(0);
      if (index > 0) {
        expect(bar.time).toBeGreaterThan(bars[index - 1]?.time ?? 0);
      }
    }
  });

  it("exports an immutable, SMA(200)-ready default fixture", () => {
    expect(DEMO_BARS).toHaveLength(DEFAULT_DEMO_BAR_COUNT);
    expect(Object.isFrozen(DEMO_BARS)).toBe(true);
    expect(Object.isFrozen(DEMO_BARS[0])).toBe(true);
    expect(DEFAULT_DEMO_BAR_COUNT).toBeGreaterThanOrEqual(200);
  });

  it("rejects unsafe options", () => {
    expect(() => generateDemoBars(0)).toThrow(/count/i);
    expect(() => generateDemoBars(10_001)).toThrow(/count/i);
    expect(() => generateDemoBars(2, { intervalSeconds: 0 })).toThrow(/interval/i);
    expect(() => generateDemoBars(2, { startPrice: Number.NaN })).toThrow(/price/i);
    expect(() => generateDemoBars(2, { startTime: 1.5 })).toThrow(/start time/i);
  });
});
