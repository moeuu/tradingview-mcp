import {
  BaselineSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type LineData,
  type UTCTimestamp,
} from "lightweight-charts";
import {
  bollingerBands,
  ema,
  macd,
  rsi,
  sma,
  type AnalysisResult,
  type IndicatorSeries,
} from "../src/analysis.js";
import type {
  Bar,
  ChartLineStyle,
  ChartState,
  IndicatorSpec,
  Theme,
} from "../src/domain.js";

const POLL_INTERVAL_MS = 1_500;
const FALLBACK_COLORS = ["#58a6ff", "#f5a524", "#a78bfa", "#22c55e", "#f472b6", "#06b6d4"] as const;
const apiToken = consumeTokenFragment();

const elements = {
  chart: requireElement<HTMLDivElement>("chart"),
  chartOverlay: requireElement<HTMLDivElement>("chart-overlay"),
  chartOverlayLabel: requireElement<HTMLSpanElement>("chart-overlay-label"),
  connection: requireElement<HTMLDivElement>("connection"),
  connectionLabel: requireElement<HTMLSpanElement>("connection-label"),
  symbol: requireElement<HTMLHeadingElement>("instrument-symbol"),
  interval: requireElement<HTMLSpanElement>("instrument-interval"),
  source: requireElement<HTMLSpanElement>("instrument-source"),
  bars: requireElement<HTMLSpanElement>("instrument-bars"),
  quote: requireElement<HTMLDivElement>("quote"),
  latestPrice: requireElement<HTMLElement>("latest-price"),
  latestChange: requireElement<HTMLSpanElement>("latest-change"),
  revision: requireElement<HTMLElement>("revision-value"),
  updated: requireElement<HTMLElement>("updated-value"),
  legend: requireElement<HTMLDivElement>("indicator-legend"),
  analysisAsOf: requireElement<HTMLSpanElement>("analysis-asof"),
  trendBlock: requireElement<HTMLDivElement>("trend-block"),
  trendLabel: requireElement<HTMLElement>("trend-label"),
  trendScore: requireElement<HTMLSpanElement>("trend-score"),
  scoreFill: requireElement<HTMLSpanElement>("score-fill"),
  analysisSummary: requireElement<HTMLParagraphElement>("analysis-summary"),
  signalList: requireElement<HTMLDivElement>("signal-list"),
  evidenceList: requireElement<HTMLUListElement>("evidence-list"),
  analysisLevels: requireElement<HTMLDivElement>("analysis-levels"),
  dataState: requireElement<HTMLSpanElement>("data-state"),
  statusSource: requireElement<HTMLElement>("status-source"),
  statusRange: requireElement<HTMLElement>("status-range"),
  statusBars: requireElement<HTMLElement>("status-bars"),
  statusVolume: requireElement<HTMLElement>("status-volume"),
  statusUpdated: requireElement<HTMLElement>("status-updated"),
};

let chart: IChartApi | null = null;
let currentRevision: number | null = null;
let pollInFlight = false;
let readyFrame = 0;

void refresh();
window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void refresh();
  }
});

async function refresh(): Promise<void> {
  if (pollInFlight) return;
  pollInFlight = true;

  if (currentRevision === null) {
    setConnectionState("loading", "データを接続中");
    setDataState("loading", "同期中");
  }

  try {
    const [stateResult, analysisResult] = await Promise.allSettled([
      fetchJson("/api/chart/state"),
      fetchJson("/api/chart/analysis"),
    ]);

    if (stateResult.status === "rejected") {
      throw stateResult.reason;
    }

    const state = parseChartState(stateResult.value);
    if (currentRevision !== state.revision || chart === null) {
      renderState(state);
      currentRevision = state.revision;
    } else {
      updateStateMetadata(state);
    }

    setConnectionState("online", "接続済み");
    setDataState("online", "正常");

    if (analysisResult.status === "fulfilled") {
      const analysis = parseAnalysis(analysisResult.value);
      if (analysis !== null) renderAnalysis(analysis);
      else renderAnalysisError("分析レスポンスの形式を確認できませんでした。");
    } else {
      renderAnalysisError(errorMessage(analysisResult.reason));
    }
  } catch (error) {
    setConnectionState("error", "再接続を待機中");
    setDataState("error", "取得エラー");
    if (chart === null) {
      showChartOverlay(`データを取得できません · ${errorMessage(error)}`, true);
    }
  } finally {
    pollInFlight = false;
  }
}

async function fetchJson(path: string): Promise<unknown> {
  const headers = new Headers({ Accept: "application/json" });
  if (apiToken) headers.set("Authorization", `Bearer ${apiToken}`);

  const response = await fetch(path, {
    method: "GET",
    headers,
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`.trim());
  }
  return response.json() as Promise<unknown>;
}

function consumeTokenFragment(): string | undefined {
  const parameters = new URLSearchParams(window.location.hash.slice(1));
  const token = parameters.get("token")?.trim() || undefined;
  if (!parameters.has("token")) return token;

  parameters.delete("token");
  const remainingFragment = parameters.toString();
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}${remainingFragment ? `#${remainingFragment}` : ""}`,
  );
  return token;
}

function renderState(state: ChartState): void {
  setReady(false);
  document.documentElement.dataset.theme = state.theme;
  updateStateMetadata(state);
  renderIndicatorLegend(state);
  renderChart(state);

  window.cancelAnimationFrame(readyFrame);
  readyFrame = window.requestAnimationFrame(() => {
    readyFrame = window.requestAnimationFrame(() => setReady(true));
  });
}

function updateStateMetadata(state: ChartState): void {
  const latest = state.bars.at(-1);
  const previous = state.bars.at(-2);
  const direction = latest && previous ? directionFrom(latest.close - previous.close) : "neutral";

  elements.symbol.textContent = state.symbol;
  elements.interval.textContent = state.interval;
  elements.source.textContent = state.source;
  elements.bars.textContent = `${integerFormatter.format(state.bars.length)} bars`;
  elements.revision.textContent = `#${integerFormatter.format(state.revision)}`;
  elements.updated.textContent = formatClock(state.updatedAt);
  elements.statusSource.textContent = state.source;
  elements.statusBars.textContent = integerFormatter.format(state.bars.length);
  elements.statusUpdated.textContent = formatDateTime(state.updatedAt);
  elements.statusVolume.textContent = state.bars.some((bar) => bar.volume !== undefined)
    ? "利用可能"
    : "データなし";
  elements.statusRange.textContent = formatBarRange(state.bars);

  if (latest) {
    const change = previous ? latest.close - previous.close : null;
    const changePercent = previous && previous.close !== 0 ? (change! / previous.close) * 100 : null;
    elements.latestPrice.textContent = formatPrice(latest.close);
    elements.latestChange.textContent =
      change === null || changePercent === null
        ? "—"
        : `${formatSigned(change)}  ${formatSigned(changePercent, 2)}%`;
    elements.quote.dataset.direction = direction;
    elements.latestPrice.classList.remove("is-updated");
    void elements.latestPrice.offsetWidth;
    elements.latestPrice.classList.add("is-updated");
  }
}

function renderChart(state: ChartState): void {
  chart?.remove();
  elements.chart.replaceChildren();

  const colors = chartColors(state.theme);
  chart = createChart(elements.chart, {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: colors.background },
      textColor: colors.text,
      fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      fontSize: 11,
      attributionLogo: true,
      panes: {
        enableResize: true,
        separatorColor: colors.border,
        separatorHoverColor: colors.accentSoft,
      },
    },
    grid: {
      vertLines: { color: colors.grid },
      horzLines: { color: colors.grid },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: {
        color: colors.crosshair,
        labelBackgroundColor: colors.label,
        style: LineStyle.Dashed,
        width: 1,
      },
      horzLine: {
        color: colors.crosshair,
        labelBackgroundColor: colors.label,
        style: LineStyle.Dashed,
        width: 1,
      },
    },
    rightPriceScale: {
      borderColor: colors.border,
      scaleMargins: { top: 0.08, bottom: 0.07 },
    },
    timeScale: {
      borderColor: colors.border,
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 4,
      barSpacing: 7,
      minBarSpacing: 2,
      fixLeftEdge: false,
    },
    handleScale: {
      axisPressedMouseMove: true,
      mouseWheel: true,
      pinch: true,
    },
    handleScroll: {
      pressedMouseMove: true,
      mouseWheel: true,
      horzTouchDrag: true,
      vertTouchDrag: false,
    },
  });

  const precision = pricePrecision(state.bars.at(-1)?.close ?? 1);
  const candleSeries = chart.addSeries(CandlestickSeries, {
    upColor: colors.up,
    downColor: colors.down,
    wickUpColor: colors.up,
    wickDownColor: colors.down,
    borderVisible: false,
    priceLineColor: colors.accent,
    priceLineStyle: LineStyle.Dotted,
    lastValueVisible: true,
    priceFormat: { type: "price", precision, minMove: 10 ** -precision },
  });
  const candleData: CandlestickData<UTCTimestamp>[] = state.bars.map((bar) => ({
    time: toChartTime(bar.time),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
  }));
  candleSeries.setData(candleData);

  if (state.markers.length > 0) {
    createSeriesMarkers(
      candleSeries,
      [...state.markers]
        .sort((left, right) => left.time - right.time)
        .map((marker) => ({
          time: toChartTime(marker.time),
          position: marker.position,
          shape: marker.shape,
          color: safeColor(marker.color, colors.accent),
          text: marker.text,
        })),
    );
  }

  for (const level of state.levels) {
    if (!Number.isFinite(level.price)) continue;
    candleSeries.createPriceLine({
      id: level.id,
      price: level.price,
      color: safeColor(level.color, colors.accent),
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      lineVisible: true,
      axisLabelVisible: true,
      title: level.label,
    });
  }

  for (const zone of state.zones) {
    const color = safeColor(zone.color, colors.accent);
    const zoneSeries = chart.addSeries(BaselineSeries, {
      baseValue: { type: "price", price: zone.lower },
      topLineColor: withAlpha(color, 0.82),
      topFillColor1: withAlpha(color, 0.18),
      topFillColor2: withAlpha(color, 0.1),
      bottomLineColor: "rgba(0,0,0,0)",
      bottomFillColor1: "rgba(0,0,0,0)",
      bottomFillColor2: "rgba(0,0,0,0)",
      title: zone.label,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    zoneSeries.setData([
      { time: toChartTime(zone.startTime), value: zone.upper },
      { time: toChartTime(zone.endTime), value: zone.upper },
    ]);
  }

  let nextPane = 1;
  const hasVolume = state.bars.some((bar) => bar.volume !== undefined);
  const volumePane = hasVolume ? nextPane++ : null;
  const rsiPane = state.indicators.some((item) => item.kind === "rsi") ? nextPane++ : null;
  const macdPane = state.indicators.some((item) => item.kind === "macd") ? nextPane++ : null;
  const customPanes = new Map<string, number>();
  for (const pane of ["cvd", "oscillator"] as const) {
    if (state.customSeries.some((series) => series.pane === pane)) {
      customPanes.set(pane, nextPane++);
    }
  }

  if (volumePane !== null) {
    const volumeSeries = chart.addSeries(
      HistogramSeries,
      {
        priceFormat: { type: "volume" },
        priceLineVisible: false,
        lastValueVisible: false,
      },
      volumePane,
    );
    const volumeData: HistogramData<UTCTimestamp>[] = state.bars.map((bar) => ({
      time: toChartTime(bar.time),
      value: bar.volume ?? 0,
      color: bar.close >= bar.open ? colors.upVolume : colors.downVolume,
    }));
    volumeSeries.setData(volumeData);
  }

  const closes = state.bars.map((bar) => bar.close);
  let rsiGuidesCreated = false;
  let macdGuideCreated = false;

  state.indicators.forEach((indicator, index) => {
    const color = indicatorColor(indicator, index);
    switch (indicator.kind) {
      case "sma": {
        const period = indicator.period ?? 20;
        addLine(chart!, state.bars, sma(closes, period), color, `SMA ${period}`, 0);
        break;
      }
      case "ema": {
        const period = indicator.period ?? 20;
        addLine(chart!, state.bars, ema(closes, period), color, `EMA ${period}`, 0);
        break;
      }
      case "bollinger": {
        const period = indicator.period ?? 20;
        const deviations = indicator.standardDeviations ?? 2;
        const bands = bollingerBands(closes, period, deviations);
        addLine(chart!, state.bars, bands.middle, color, `BB ${period}`, 0, LineStyle.Solid);
        addLine(chart!, state.bars, bands.upper, withAlpha(color, 0.72), "BB upper", 0, LineStyle.Dashed);
        addLine(chart!, state.bars, bands.lower, withAlpha(color, 0.72), "BB lower", 0, LineStyle.Dashed);
        break;
      }
      case "rsi": {
        if (rsiPane === null) break;
        const period = indicator.period ?? 14;
        const series = chart!.addSeries(
          LineSeries,
          {
            color,
            lineWidth: 2,
            title: `RSI ${period}`,
            priceLineVisible: false,
            lastValueVisible: true,
            crosshairMarkerVisible: false,
            priceFormat: { type: "custom", formatter: (value: number) => value.toFixed(1) },
            autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
          },
          rsiPane,
        );
        series.setData(toLineData(state.bars, rsi(closes, period)));
        if (!rsiGuidesCreated) {
          rsiGuidesCreated = true;
          for (const price of [70, 50, 30]) {
            series.createPriceLine({
              price,
              color: price === 50 ? colors.gridStrong : colors.guide,
              lineWidth: 1,
              lineStyle: price === 50 ? LineStyle.Dotted : LineStyle.Dashed,
              lineVisible: true,
              axisLabelVisible: false,
              title: "",
            });
          }
        }
        break;
      }
      case "macd": {
        if (macdPane === null) break;
        const fast = indicator.fastPeriod ?? 12;
        const slow = indicator.slowPeriod ?? 26;
        const signalPeriod = indicator.signalPeriod ?? 9;
        const values = macd(closes, fast, slow, signalPeriod);
        const histogram = chart!.addSeries(
          HistogramSeries,
          { priceLineVisible: false, lastValueVisible: false, base: 0 },
          macdPane,
        );
        const histogramData: HistogramData<UTCTimestamp>[] = [];
        values.histogram.forEach((value, valueIndex) => {
          const bar = state.bars[valueIndex];
          if (value === null || bar === undefined) return;
          histogramData.push({
            time: toChartTime(bar.time),
            value,
            color: value >= 0 ? colors.upVolume : colors.downVolume,
          });
        });
        histogram.setData(histogramData);
        const macdSeries = addLine(chart!, state.bars, values.macd, color, `MACD ${fast}/${slow}`, macdPane);
        addLine(
          chart!,
          state.bars,
          values.signal,
          withAlpha(colors.signal, 0.94),
          `Signal ${signalPeriod}`,
          macdPane,
        );
        if (!macdGuideCreated) {
          macdGuideCreated = true;
          macdSeries.createPriceLine({
            price: 0,
            color: colors.guide,
            lineWidth: 1,
            lineStyle: LineStyle.Dotted,
            lineVisible: true,
            axisLabelVisible: false,
            title: "",
          });
        }
        break;
      }
    }
  });

  for (const seriesSpec of state.customSeries) {
    const paneIndex = seriesSpec.pane === "price" ? 0 : (customPanes.get(seriesSpec.pane) ?? 0);
    const color = safeColor(seriesSpec.color, colors.accent);
    if (seriesSpec.kind === "histogram") {
      const series = chart.addSeries(
        HistogramSeries,
        {
          color,
          base: 0,
          title: seriesSpec.label,
          priceLineVisible: false,
          lastValueVisible: true,
        },
        paneIndex,
      );
      series.setData(
        seriesSpec.data.map((point) => ({
          time: toChartTime(point.time),
          value: point.value,
          color: safeColor(point.color, point.value >= 0 ? colors.upVolume : colors.downVolume),
        })),
      );
    } else {
      const series = chart.addSeries(
        LineSeries,
        {
          color,
          lineWidth: seriesSpec.lineWidth as 1 | 2 | 3 | 4,
          lineStyle: chartLineStyle(seriesSpec.lineStyle),
          title: seriesSpec.label,
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: false,
        },
        paneIndex,
      );
      series.setData(
        seriesSpec.data.map((point) => ({ time: toChartTime(point.time), value: point.value })),
      );
    }
  }

  chart.panes().forEach((pane, index) => {
    if (index === 0) pane.setStretchFactor(4.8);
    else if (index === volumePane) pane.setStretchFactor(1.1);
    else if (index === rsiPane) pane.setStretchFactor(1.25);
    else if ([...customPanes.values()].includes(index)) pane.setStretchFactor(1.5);
    else pane.setStretchFactor(1.55);
  });

  const lastBarTime = state.bars.at(-1)?.time ?? 0;
  const futureTimes = new Set(
    state.customSeries.flatMap((series) =>
      series.data.filter((point) => point.time > lastBarTime).map((point) => point.time),
    ),
  );
  if (state.bars.length > 170) {
    chart.timeScale().setVisibleLogicalRange({
      from: state.bars.length - 165,
      to: state.bars.length + Math.min(futureTimes.size, 50) + 4,
    });
  } else {
    chart.timeScale().fitContent();
  }
  hideChartOverlay();
}

function addLine(
  targetChart: IChartApi,
  bars: readonly Bar[],
  values: IndicatorSeries,
  color: string,
  title: string,
  paneIndex: number,
  lineStyle = LineStyle.Solid,
) {
  const series = targetChart.addSeries(
    LineSeries,
    {
      color,
      lineWidth: 2,
      lineStyle,
      title,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    },
    paneIndex,
  );
  series.setData(toLineData(bars, values));
  return series;
}

function toLineData(bars: readonly Bar[], values: IndicatorSeries): LineData<UTCTimestamp>[] {
  const output: LineData<UTCTimestamp>[] = [];
  values.forEach((value, index) => {
    const bar = bars[index];
    if (value !== null && bar !== undefined && Number.isFinite(value)) {
      output.push({ time: toChartTime(bar.time), value });
    }
  });
  return output;
}

function renderIndicatorLegend(state: ChartState): void {
  elements.legend.replaceChildren();
  const entries: Array<{ label: string; color: string }> = [
    { label: "Price", color: "var(--legend-price)" },
    { label: "Volume", color: "var(--text-faint)" },
  ];
  state.indicators.forEach((indicator, index) => {
    entries.push({ label: indicatorLabel(indicator), color: indicatorColor(indicator, index) });
  });
  state.customSeries.forEach((series) => {
    entries.push({ label: series.label, color: safeColor(series.color, FALLBACK_COLORS[0]) });
  });
  state.zones.forEach((zone) => {
    entries.push({ label: zone.label, color: safeColor(zone.color, FALLBACK_COLORS[1]) });
  });

  for (const entry of entries) {
    const item = document.createElement("span");
    item.className = "legend-item";
    const marker = document.createElement("i");
    marker.style.backgroundColor = entry.color;
    item.append(marker, document.createTextNode(entry.label));
    elements.legend.append(item);
  }
}

function renderAnalysis(analysis: AnalysisResult): void {
  const direction = analysis.trend.direction;
  const score = Math.max(-100, Math.min(100, analysis.trend.score));
  elements.analysisAsOf.textContent = formatUnixTime(analysis.asOf);
  elements.trendBlock.dataset.direction = direction;
  elements.trendLabel.textContent = `${trendLabel(direction)} · ${strengthLabel(analysis.trend.strength)}`;
  elements.trendScore.textContent = formatSigned(score, 0);
  elements.scoreFill.style.left = score < 0 ? `${50 + score / 2}%` : "50%";
  elements.scoreFill.style.width = `${Math.abs(score) / 2}%`;
  elements.analysisSummary.textContent = analysis.summary;

  elements.signalList.replaceChildren();
  if (analysis.signals.length === 0) {
    elements.signalList.append(emptyCopy("現在、明確なシグナルはありません。"));
  } else {
    analysis.signals.slice(0, 5).forEach((signal) => {
      const item = document.createElement("article");
      item.className = "signal-item";
      item.dataset.direction = signal.direction;
      const heading = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = signal.indicator;
      const badge = document.createElement("span");
      badge.textContent = `${signalLabel(signal.direction)} / ${strengthLabel(signal.strength)}`;
      heading.append(name, badge);
      const message = document.createElement("p");
      message.textContent = signal.message;
      item.append(heading, message);
      elements.signalList.append(item);
    });
  }

  elements.evidenceList.replaceChildren();
  const evidence = analysis.trend.evidence.slice(0, 5);
  if (evidence.length === 0) {
    const item = document.createElement("li");
    item.textContent = "追加の根拠はありません。";
    elements.evidenceList.append(item);
  } else {
    evidence.forEach((copy) => {
      const item = document.createElement("li");
      item.textContent = copy;
      elements.evidenceList.append(item);
    });
  }

  elements.analysisLevels.replaceChildren(
    levelChip("Support", analysis.levels.support[0]?.price),
    levelChip("Resistance", analysis.levels.resistance[0]?.price),
  );
}

function renderAnalysisError(message: string): void {
  elements.analysisSummary.textContent = `分析情報を取得できませんでした。${message ? ` ${message}` : ""}`;
  elements.analysisAsOf.textContent = "—";
}

function levelChip(label: string, price: number | undefined): HTMLSpanElement {
  const element = document.createElement("span");
  element.textContent = `${label} ${price === undefined ? "—" : formatPrice(price)}`;
  return element;
}

function emptyCopy(copy: string): HTMLParagraphElement {
  const element = document.createElement("p");
  element.className = "empty-copy";
  element.textContent = copy;
  return element;
}

function parseChartState(value: unknown): ChartState {
  if (!isRecord(value) || !Array.isArray(value.bars) || !Array.isArray(value.indicators) || !Array.isArray(value.levels)) {
    throw new Error("Invalid chart state");
  }
  if (
    typeof value.symbol !== "string" ||
    typeof value.interval !== "string" ||
    typeof value.source !== "string" ||
    typeof value.revision !== "number" ||
    typeof value.updatedAt !== "string" ||
    (value.theme !== "dark" && value.theme !== "light")
  ) {
    throw new Error("Invalid chart metadata");
  }
  return {
    ...(value as unknown as ChartState),
    customSeries: Array.isArray(value.customSeries)
      ? (value.customSeries as ChartState["customSeries"])
      : [],
    zones: Array.isArray(value.zones) ? (value.zones as ChartState["zones"]) : [],
    markers: Array.isArray(value.markers) ? (value.markers as ChartState["markers"]) : [],
  };
}

function chartLineStyle(value: ChartLineStyle): LineStyle {
  if (value === "dashed") return LineStyle.Dashed;
  if (value === "dotted") return LineStyle.Dotted;
  return LineStyle.Solid;
}

function parseAnalysis(value: unknown): AnalysisResult | null {
  if (!isRecord(value)) return null;
  const candidate = isRecord(value.analysis) ? value.analysis : value;
  if (
    typeof candidate.summary !== "string" ||
    typeof candidate.asOf !== "number" ||
    !isRecord(candidate.trend) ||
    !Array.isArray(candidate.signals) ||
    !isRecord(candidate.levels)
  ) {
    return null;
  }
  return candidate as unknown as AnalysisResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function setConnectionState(state: "loading" | "online" | "error", label: string): void {
  elements.connection.dataset.state = state;
  elements.connectionLabel.textContent = label;
}

function setDataState(state: "loading" | "online" | "error", label: string): void {
  elements.dataState.dataset.state = state;
  elements.dataState.textContent = label;
}

function showChartOverlay(label: string, isError: boolean): void {
  elements.chartOverlay.hidden = false;
  elements.chartOverlay.dataset.state = isError ? "error" : "loading";
  elements.chartOverlayLabel.textContent = label;
}

function hideChartOverlay(): void {
  elements.chartOverlay.hidden = true;
}

function setReady(ready: boolean): void {
  const value = String(ready);
  document.documentElement.dataset.ready = value;
  document.body.dataset.ready = value;
}

function indicatorLabel(indicator: IndicatorSpec): string {
  switch (indicator.kind) {
    case "sma":
      return `SMA ${indicator.period ?? 20}`;
    case "ema":
      return `EMA ${indicator.period ?? 20}`;
    case "bollinger":
      return `BB ${indicator.period ?? 20}`;
    case "rsi":
      return `RSI ${indicator.period ?? 14}`;
    case "macd":
      return `MACD ${indicator.fastPeriod ?? 12}/${indicator.slowPeriod ?? 26}`;
  }
}

function indicatorColor(indicator: IndicatorSpec, index: number): string {
  return safeColor(indicator.color, FALLBACK_COLORS[index % FALLBACK_COLORS.length] ?? "#58a6ff");
}

function safeColor(value: string | undefined, fallback: string): string {
  return value && /^#[0-9a-f]{6}$/iu.test(value) ? value : fallback;
}

function withAlpha(color: string, alpha: number): string {
  const safe = safeColor(color, "#58a6ff").slice(1);
  const red = Number.parseInt(safe.slice(0, 2), 16);
  const green = Number.parseInt(safe.slice(2, 4), 16);
  const blue = Number.parseInt(safe.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function chartColors(theme: Theme) {
  if (theme === "light") {
    return {
      background: "#f7f8fa",
      text: "#647083",
      grid: "rgba(25, 38, 57, 0.06)",
      gridStrong: "rgba(25, 38, 57, 0.18)",
      border: "#dce1e8",
      crosshair: "rgba(73, 91, 119, 0.54)",
      label: "#354052",
      accent: "#146ef5",
      accentSoft: "rgba(20, 110, 245, 0.32)",
      up: "#07866f",
      down: "#d64f64",
      upVolume: "rgba(7, 134, 111, 0.30)",
      downVolume: "rgba(214, 79, 100, 0.28)",
      guide: "rgba(80, 93, 114, 0.25)",
      signal: "#f59e0b",
    };
  }
  return {
    background: "#0b1018",
    text: "#738096",
    grid: "rgba(148, 163, 184, 0.055)",
    gridStrong: "rgba(148, 163, 184, 0.20)",
    border: "#1c2634",
    crosshair: "rgba(148, 163, 184, 0.46)",
    label: "#344154",
    accent: "#4b8dff",
    accentSoft: "rgba(75, 141, 255, 0.35)",
    up: "#16b99a",
    down: "#ef6176",
    upVolume: "rgba(22, 185, 154, 0.28)",
    downVolume: "rgba(239, 97, 118, 0.26)",
    guide: "rgba(148, 163, 184, 0.23)",
    signal: "#f3aa4e",
  };
}

function toChartTime(time: number): UTCTimestamp {
  return time as UTCTimestamp;
}

function directionFrom(value: number): "bullish" | "bearish" | "neutral" {
  return value > 0 ? "bullish" : value < 0 ? "bearish" : "neutral";
}

function trendLabel(direction: AnalysisResult["trend"]["direction"]): string {
  if (direction === "bullish") return "上昇";
  if (direction === "bearish") return "下降";
  return "横ばい";
}

function strengthLabel(strength: AnalysisResult["trend"]["strength"]): string {
  if (strength === "strong") return "強い";
  if (strength === "moderate") return "中程度";
  return "弱い";
}

function signalLabel(direction: AnalysisResult["signals"][number]["direction"]): string {
  if (direction === "bullish") return "強気";
  if (direction === "bearish") return "弱気";
  return "中立";
}

function pricePrecision(value: number): number {
  const absolute = Math.abs(value);
  if (absolute >= 1) return 2;
  if (absolute >= 0.01) return 4;
  return 6;
}

function formatPrice(value: number): string {
  const precision = pricePrecision(value);
  return new Intl.NumberFormat("ja-JP", {
    minimumFractionDigits: Math.min(2, precision),
    maximumFractionDigits: precision,
  }).format(value);
}

function formatSigned(value: number, decimals?: number): string {
  const precision = decimals ?? pricePrecision(value);
  const formatted = new Intl.NumberFormat("ja-JP", {
    minimumFractionDigits: precision === 0 ? 0 : Math.min(2, precision),
    maximumFractionDigits: precision,
  }).format(Math.abs(value));
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${formatted}`;
}

function formatClock(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatUnixTime(value: number): string {
  return formatDateTime(new Date(value * 1_000).toISOString());
}

function formatBarRange(bars: readonly Bar[]): string {
  const first = bars[0];
  const last = bars.at(-1);
  if (!first || !last) return "—";
  const formatter = new Intl.DateTimeFormat("ja-JP", { year: "2-digit", month: "2-digit", day: "2-digit" });
  return `${formatter.format(first.time * 1_000)} – ${formatter.format(last.time * 1_000)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing required element #${id}`);
  return element as T;
}

const integerFormatter = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 });
