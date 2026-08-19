import type { Bar } from "./domain.js";

export interface DemoBarsOptions {
  /** Unix time in whole seconds for the first bar. */
  startTime?: number;
  /** Distance between bars in whole seconds. */
  intervalSeconds?: number;
  /** Integer seed used by the local pseudo-random generator. */
  seed?: number;
  startPrice?: number;
}

export const DEFAULT_DEMO_BAR_COUNT = 320;
export const DEFAULT_DEMO_START_TIME = 1_735_776_000; // 2025-01-02T00:00:00Z

/**
 * Generate plausible, deterministic OHLCV data without a network dependency.
 * The same count and options always produce byte-for-byte equivalent bars.
 */
export function generateDemoBars(
  count = DEFAULT_DEMO_BAR_COUNT,
  options: DemoBarsOptions = {},
): Bar[] {
  if (!Number.isInteger(count) || count < 1 || count > 10_000) {
    throw new Error("Demo bar count must be an integer between 1 and 10000.");
  }

  const startTime = options.startTime ?? DEFAULT_DEMO_START_TIME;
  const intervalSeconds = options.intervalSeconds ?? 3_600;
  const seed = options.seed ?? 0x54_56_43_58;
  const startPrice = options.startPrice ?? 100;

  if (!Number.isSafeInteger(startTime) || startTime <= 0) {
    throw new Error("Demo start time must be a positive integer Unix timestamp.");
  }
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds <= 0) {
    throw new Error("Demo interval must be a positive whole number of seconds.");
  }
  if (!Number.isSafeInteger(seed)) {
    throw new Error("Demo seed must be a safe integer.");
  }
  if (!Number.isFinite(startPrice) || startPrice <= 0) {
    throw new Error("Demo start price must be a positive finite number.");
  }
  if (startTime + (count - 1) * intervalSeconds > Number.MAX_SAFE_INTEGER) {
    throw new Error("Demo bar timestamps exceed the safe integer range.");
  }

  const random = seededRandom(seed);
  const bars: Bar[] = [];
  let previousClose = startPrice;

  for (let index = 0; index < count; index += 1) {
    const phase = index % 180;
    const regimeDrift = phase < 60 ? 0.0007 : phase < 120 ? -0.00035 : 0.0005;
    const cyclicalDrift = Math.sin(index / 11) * 0.0012 + Math.cos(index / 31) * 0.0007;
    const gap = (random() - 0.5) * 0.003;
    const intrabarMove = regimeDrift + cyclicalDrift + (random() - 0.5) * 0.012;

    const open = roundPrice(previousClose * (1 + gap));
    const close = roundPrice(Math.max(0.0001, open * (1 + intrabarMove)));
    const highWick = 0.001 + random() * 0.006;
    const lowWick = 0.001 + random() * 0.006;
    const high = roundPrice(Math.max(open, close) * (1 + highWick));
    const low = roundPrice(Math.max(0, Math.min(open, close) * (1 - lowWick)));
    const activity = 1 + Math.abs(intrabarMove) * 35 + Math.abs(Math.sin(index / 9)) * 0.25;
    const volume = Math.round(750_000 * activity * (0.8 + random() * 0.4));

    bars.push({
      time: startTime + index * intervalSeconds,
      open,
      high: Math.max(high, open, close),
      low: Math.min(low, open, close),
      close,
      volume,
    });
    previousClose = close;
  }

  return bars;
}

/** A ready-to-use fixture with enough history for SMA(200). */
export const DEMO_BARS: readonly Bar[] = Object.freeze(
  generateDemoBars().map((bar) => Object.freeze(bar)),
);

/** Alias for callers that prefer factory-style naming. */
export const createDemoBars = generateDemoBars;

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function roundPrice(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
