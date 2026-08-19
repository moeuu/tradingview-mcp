import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { inflateSync } from "node:zlib";
import type { Browser, BrowserContext, Cookie, Locator, Page } from "playwright";
import type { ChartStore } from "./chart-store.js";
import type { AppConfig } from "./config.js";
import { DEFAULT_TRADINGVIEW_AUTH_COOKIE_NAMES } from "./auth-policy.js";
import { loadBarsFromCsv } from "./csv.js";
import type { Bar } from "./domain.js";
import { MAX_BARS } from "./domain.js";
import {
  TradingViewCaptureBatchInputSchema,
  TradingViewCaptureBatchManifestSchema,
  TradingViewCaptureObservedStateSchema,
  type TradingViewCaptureBatchInput,
  type TradingViewCaptureBatchManifest,
  type TradingViewCaptureObservedState,
} from "./schemas.js";

const SYMBOL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/!+-]{0,99}$/;
const INTERVAL_PATTERN = /^(?:[1-9]\d{0,3}[STHDWM]?|[DWM])$/i;
const LAYOUT_PATTERN = /^[A-Za-z0-9_-]{4,40}$/;
const MAX_EXPORT_BYTES = 50 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 50 * 1024 * 1024;
const MAX_AUTH_FILE_BYTES = 1024 * 1024;
const MAX_COOKIE_VALUE_BYTES = 16 * 1024;
const MAX_STORAGE_VALUE_BYTES = 128 * 1024;
const CAPTURE_WIDTH = 1_800;
const CAPTURE_HEIGHT = 850;
const CAPTURE_INTERVALS = ["5", "60", "240", "D", "W", "M"] as const;
const CAPTURE_FILE_LABELS = ["5m", "1h", "4h", "D", "W", "M"] as const;
const CAPTURE_CURRENT_SCHEMA = "tradingview-capture-current/v1";
const FORBIDDEN_COMMERCE_PATTERN =
  /upgrade|free\s+trial|start\s+(?:a\s+)?trial|purchase|payment|billing|subscribe|subscription|choose\s+(?:a\s+)?plan/i;
const FORBIDDEN_COMMERCE_REQUEST_PATTERN =
  /upgrade|free\s+trial|start[_\s-]*(?:a[_\s-]*)?trial|purchase|payment|billing|checkout|choose[_\s-]*(?:a[_\s-]*)?plan/i;
const FORBIDDEN_MUTATION_PATTERN =
  /(?:\/(?:charts?|layouts?)(?:\/[^\s/?#]+)?\/(?:save|update)(?:[\s/?#&]|$)|\/(?:save|autosave)(?:[\s/?#&]|$)|(?:^|[\s"'/:_.-])(?:auto.?save|save[_-]?(?:chart|layout)|update[_-]?(?:chart|layout)|chart[_-]?(?:save|update)|layout[_-]?(?:save|update)|publish[_-]?(?:chart|layout))(?:$|[\s"'/?#&=:_.-]))/i;
const BENIGN_TELEMETRY_PATTERN =
  /(?:analytics|telemetry|metrics?|beacon|track(?:ing)?|events?|collect|log(?:ging)?|sentry|datadog|amplitude|segment)(?:[/?#&=:_.-]|$)/i;

type CaptureInterval = (typeof CAPTURE_INTERVALS)[number];

export interface TradingViewCaptureControlObservation {
  selector: string | null;
  label: string | null;
  active: boolean | null;
}

export interface TradingViewCaptureStudyObservation {
  selector: string;
  text: string;
  identity: string | null;
  name: string | null;
  source: "builtin" | "pine" | "unknown";
}

export interface TradingViewCaptureSurfaceObservation {
  selector: string;
  text: string;
  identity: string | null;
  name: string | null;
}

export interface TradingViewCaptureDomObservation {
  pageUrl: string | null;
  chartCount: number;
  chartAuditComplete: boolean;
  chartAriaLabel: string | null;
  chartSelector: string | null;
  symbolLinkHref: string | null;
  symbolLinkSelector: string | null;
  intervalLabel: string | null;
  intervalSelector: string | null;
  chartTypeLabel: string | null;
  chartTypeSelector: string | null;
  authenticatedControlVisible: boolean;
  authenticatedSelector: string | null;
  delayedLabelVisible: boolean;
  realtimeLabel: string | null;
  realtimeSelector: string | null;
  realtimeActive: boolean | null;
  timezoneLabel: string | null;
  timezoneSelector: string | null;
  sessionLabel: string | null;
  sessionSelector: string | null;
  backAdjustment: TradingViewCaptureControlObservation | null;
  settlementAsClose: TradingViewCaptureControlObservation | null;
  studyAuditSelector: string | null;
  studyAuditComplete: boolean;
  studies: TradingViewCaptureStudyObservation[];
  collapsedStudyCount: number;
  comparisonAuditSelector: string | null;
  comparisonAuditComplete: boolean;
  comparisons: TradingViewCaptureSurfaceObservation[];
  drawingAuditSelector: string | null;
  drawingAuditComplete: boolean;
  drawings: TradingViewCaptureSurfaceObservation[];
  unclassifiedSurfaceCount: number;
  settingsAuditSelector: string | null;
  settingsAuditComplete: boolean;
  objectTreeAuditSelector: string | null;
  objectTreeAuditComplete: boolean;
  renderAuditSelector: string | null;
  renderAuditComplete: boolean;
  visibleCanvasCount: number;
  axisEvidenceCount: number;
  ohlcEvidenceVisible: boolean;
  loadingVisible: boolean;
}

/**
 * Narrow capture seam. Production uses a DOM-only Playwright implementation;
 * tests can inject a credential-free driver without launching a browser.
 */
export interface TradingViewCaptureDriver {
  initializeReadOnly(): Promise<void>;
  assertNoForbiddenDialog(stage: string): Promise<void>;
  setViewportSize(width: number, height: number): Promise<void>;
  navigate(url: string): Promise<void>;
  waitForStableChart(symbol: string, interval: CaptureInterval): Promise<void>;
  auditLocalState(
    interval: CaptureInterval,
    expectedOverlayMode: TradingViewCaptureBatchInput["expectedOverlayMode"],
    expectedIndicator: { identity: string; name: string } | undefined,
  ): Promise<void>;
  clearCrosshairAndTooltips(): Promise<void>;
  pause(milliseconds: number): Promise<void>;
  observe(
    interval: CaptureInterval,
    expectedIndicator: { identity: string; name: string } | undefined,
  ): Promise<TradingViewCaptureDomObservation>;
  screenshotFullViewport(): Promise<Buffer>;
}

export interface TradingViewCaptureDriverLease {
  driver: TradingViewCaptureDriver;
  dispose: () => Promise<void>;
}

export interface TradingViewCapturePublicationHooks {
  afterCurrentRenamed?: () => Promise<void>;
  afterCurrentPublished?: () => Promise<void>;
  beforeRestoreCurrent?: () => Promise<void>;
}

interface CaptureArchiveRoot {
  path: string;
  handle: Awaited<ReturnType<typeof open>>;
  fdPath: string;
}

interface CaptureArchiveDirectory {
  name: string;
  handle: Awaited<ReturnType<typeof open>>;
  fdPath: string;
}

interface CaptureCurrentPointer {
  schemaVersion: typeof CAPTURE_CURRENT_SCHEMA;
  batchId: string;
  manifestIdentity: string;
}

export interface TradingViewChartState {
  url: string;
  title: string;
  symbol: string;
  interval: string;
  authenticated: boolean;
  chartLabel?: string;
  delayed: boolean;
}

export interface TradingViewStorageState {
  cookies: Cookie[];
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}

export interface TradingViewHistoryInput {
  symbol: string;
  interval: string;
  bars?: number | undefined;
  layoutId?: string | undefined;
  loadChart?: boolean | undefined;
  outputName?: string | undefined;
}

export interface TradingViewHistoryResult {
  symbol: string;
  interval: string;
  source: "TradingView Supercharts chart-data export";
  authenticated: boolean;
  delayed: boolean;
  requestedBars: number;
  requestedBarsSatisfied: boolean;
  barCount: number;
  sourceBarCount: number;
  truncated: boolean;
  file: string;
  bytes: number;
  firstBar: Bar;
  lastBar: Bar;
  bars: Bar[];
  chart?: ReturnType<ChartStore["getSummary"]> | undefined;
}

interface ArchivedExport {
  file: string;
  target: string;
  bytes: number;
}

interface ParsedHistoryExport {
  archived: ArchivedExport;
  loaded: Awaited<ReturnType<typeof loadBarsFromCsv>>;
}

export class TradingViewBrowserService {
  #browser: Browser | undefined;
  #context: BrowserContext | undefined;
  #page: Page | undefined;
  #symbol = "";
  #interval = "";
  #operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: AppConfig["tradingViewBrowser"],
    private readonly dataRoot: string,
    private readonly store: ChartStore,
    private readonly captureDriverOverride?: TradingViewCaptureDriver,
    private readonly captureDriverLeaseFactoryOverride?: () => Promise<TradingViewCaptureDriverLease>,
    private readonly capturePublicationHooksOverride?: TradingViewCapturePublicationHooks,
  ) {}

  get enabled(): boolean {
    return this.config.enabled;
  }

  get active(): boolean {
    return this.#browser !== undefined;
  }

  async openChart(input: {
    symbol: string;
    interval: string;
    layoutId?: string | undefined;
  }): Promise<TradingViewChartState> {
    return this.#runExclusive(() => this.#openChart(input));
  }

  async getState(): Promise<TradingViewChartState> {
    return this.#runExclusive(() => this.#getState());
  }

  async addIndicator(name: string): Promise<TradingViewChartState> {
    return this.#runExclusive(() => this.#addIndicator(name));
  }

  async snapshot(options: {
    width?: number | undefined;
    height?: number | undefined;
    chartOnly?: boolean | undefined;
  } = {}): Promise<Buffer> {
    return this.#runExclusive(() => this.#snapshot(options));
  }

  async exportChartData(options: {
    loadChart?: boolean | undefined;
    outputName?: string | undefined;
  } = {}): Promise<{
    file: string;
    bytes: number;
    loaded: boolean;
    barCount?: number;
    sourceBarCount?: number;
    truncated?: boolean;
    chart?: ReturnType<ChartStore["getSummary"]>;
  }> {
    return this.#runExclusive(() => this.#exportChartData(options));
  }

  async getHistory(input: TradingViewHistoryInput): Promise<TradingViewHistoryResult> {
    return this.#runExclusive(() => this.#getHistory(input));
  }

  async captureBatch(input: TradingViewCaptureBatchInput): Promise<TradingViewCaptureBatchManifest> {
    return this.#runExclusive(() => this.#captureBatch(input));
  }

  async close(): Promise<void> {
    return this.#runExclusive(() => this.#close());
  }

  async #captureBatch(input: TradingViewCaptureBatchInput): Promise<TradingViewCaptureBatchManifest> {
    this.#assertEnabled();
    const requested = TradingViewCaptureBatchInputSchema.parse(input);
    let lease: TradingViewCaptureDriverLease | undefined;
    const driver = this.captureDriverOverride ?? (await (async () => {
      lease = this.captureDriverLeaseFactoryOverride
        ? await this.captureDriverLeaseFactoryOverride()
        : await this.#createCaptureDriverLease();
      return lease.driver;
    })());
    const batchStartedAt = new Date().toISOString();
    try {
      await driver.initializeReadOnly();
      await driver.assertNoForbiddenDialog("batch start");
      await this.#checkedCaptureAction(driver, "set viewport", () =>
        driver.setViewportSize(CAPTURE_WIDTH, CAPTURE_HEIGHT),
      );

      const captureRoot = await prepareCaptureRoot(this.dataRoot);
      const releaseLock = await acquireCapturePublicationLock(
        captureRoot,
        this.config.timeoutMs,
      ).catch(async (error: unknown) => {
        await captureRoot.handle.close();
        throw error;
      });
      const batchId = captureBatchId();
      const temporaryName = `.${batchId}.tmp`;
      const finalName = batchId;
      let temporaryDirectory: CaptureArchiveDirectory | undefined;
      let finalDirectoryPublished = false;
      let currentBaseline: Buffer | undefined;
      try {
        currentBaseline = await readCurrentRaw(captureRoot);
        if (currentBaseline) await validateCurrentPointer(captureRoot, currentBaseline);
        temporaryDirectory = await createArchiveDirectory(captureRoot, temporaryName);

        const panels: TradingViewCaptureBatchManifest["panels"][number][] = [];
        for (const [index, interval] of CAPTURE_INTERVALS.entries()) {
          const chartUrl = captureChartUrl(this.config.baseUrl, requested.layoutId, interval);
          await this.#checkedCaptureAction(driver, `navigate ${interval}`, () =>
            driver.navigate(chartUrl),
          );
          await driver.waitForStableChart(requested.symbol, interval);
          await driver.assertNoForbiddenDialog(`after stable wait ${interval}`);
          await this.#checkedCaptureAction(driver, `audit local chart UI ${interval}`, () =>
            driver.auditLocalState(
              interval,
              requested.expectedOverlayMode,
              requested.expectedIndicator,
            ),
          );
          await this.#checkedCaptureAction(driver, `clear transient visuals ${interval}`, () =>
            driver.clearCrosshairAndTooltips(),
          );
          await driver.pause(150);

          const stableCandidate = await this.#captureObservedState(
            driver,
            requested,
            interval,
            chartUrl,
          );
          await driver.pause(250);
          const observedBefore = await this.#captureObservedState(
            driver,
            requested,
            interval,
            chartUrl,
          );
          assertCaptureStateStable(stableCandidate, observedBefore, interval, "before capture");

          const captureStartedAt = new Date().toISOString();
          const png = await this.#checkedCaptureAction(driver, `capture ${interval}`, () =>
            driver.screenshotFullViewport(),
          );
          const captureEndedAt = new Date().toISOString();
          const observedAfter = await this.#captureObservedState(
            driver,
            requested,
            interval,
            chartUrl,
          );
          assertCaptureStateStable(observedBefore, observedAfter, interval, "across capture");

          const fileName = `${String(index + 1).padStart(2, "0")}-${CAPTURE_FILE_LABELS[index]}.png`;
          const archived = await archiveCapturePng(
            temporaryDirectory,
            fileName,
            png,
            CAPTURE_WIDTH,
            CAPTURE_HEIGHT,
          );
          panels.push({
            index,
            requestedInterval: interval,
            captureStartedAt,
            captureEndedAt,
            observedBefore,
            observedAfter,
            png: {
              path: path.posix.join("tradingview-captures", batchId, fileName),
              sha256: archived.sha256,
              bytes: archived.bytes,
              width: CAPTURE_WIDTH,
              height: CAPTURE_HEIGHT,
            },
          });
        }

        const batchEndedAt = new Date().toISOString();
        const firstCaptureMs = Date.parse(panels[0]!.captureStartedAt);
        const lastCaptureMs = Date.parse(panels.at(-1)!.captureStartedAt);
        const captureSkewMs = Math.max(0, lastCaptureMs - firstCaptureMs);
        const manifestWithoutIdentity = {
          schemaVersion: "tradingview-capture-batch/v1" as const,
          source: "TradingView Supercharts official browser UI" as const,
          batchId,
          batchStartedAt,
          batchEndedAt,
          captureSkewMs,
          symbol: requested.symbol,
          layoutId: requested.layoutId,
          intervalOrder: [...CAPTURE_INTERVALS],
          requested,
          panels,
          upgradeAttempted: false as const,
        };
        const manifestIdentity = computeTradingViewCaptureManifestIdentity(manifestWithoutIdentity);
        const manifest = TradingViewCaptureBatchManifestSchema.parse({
          ...manifestWithoutIdentity,
          manifestIdentity,
        });

        await atomicWriteNewFile(
          temporaryDirectory,
          "manifest.json",
          Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
        );
        await temporaryDirectory.handle.sync();
        await assertDirectoryBinding(captureRoot, temporaryDirectory);
        await rename(
          path.join(captureRoot.fdPath, temporaryName),
          path.join(captureRoot.fdPath, finalName),
        );
        finalDirectoryPublished = true;
        await captureRoot.handle.sync();
        await assertCurrentUnchanged(captureRoot, currentBaseline);
        const pointer: CaptureCurrentPointer = {
          schemaVersion: CAPTURE_CURRENT_SCHEMA,
          batchId,
          manifestIdentity,
        };
        await atomicReplaceFile(
          captureRoot,
          "CURRENT",
          Buffer.from(`${canonicalJson(pointer)}\n`, "utf8"),
          this.capturePublicationHooksOverride?.afterCurrentRenamed,
        );
        await this.capturePublicationHooksOverride?.afterCurrentPublished?.();
        const verified = await validateCurrentPointer(captureRoot, await readCurrentRawRequired(captureRoot));
        if (canonicalJson(verified) !== canonicalJson(manifest)) {
          throw new Error("Published TradingView capture differs from the verified CURRENT manifest.");
        }
        return manifest;
      } catch (error) {
        let rollbackFailure: unknown;
        let currentRestorationVerified = !finalDirectoryPublished;
        if (finalDirectoryPublished) {
          try {
            await this.capturePublicationHooksOverride?.beforeRestoreCurrent?.();
            await restoreCurrent(captureRoot, currentBaseline);
            await assertCurrentUnchanged(captureRoot, currentBaseline);
            currentRestorationVerified = true;
          } catch (restoreError) {
            rollbackFailure = restoreError;
          }
        }
        if (temporaryDirectory) {
          await rm(path.join(captureRoot.fdPath, temporaryName), { recursive: true, force: true });
        }
        if (finalDirectoryPublished && currentRestorationVerified) {
          await rm(path.join(captureRoot.fdPath, finalName), { recursive: true, force: true });
        }
        await captureRoot.handle.sync().catch(() => undefined);
        if (rollbackFailure !== undefined) {
          throw new AggregateError(
            [error, rollbackFailure],
            "TradingView capture failed and CURRENT restoration could not be verified; the published batch was retained to avoid a dangling CURRENT pointer.",
          );
        }
        throw error;
      } finally {
        await temporaryDirectory?.handle.close().catch(() => undefined);
        try {
          await releaseLock();
        } finally {
          await captureRoot.handle.close();
        }
      }
    } finally {
      await lease?.dispose();
    }
  }

  async #createCaptureDriverLease(): Promise<TradingViewCaptureDriverLease> {
    const browser = await this.#getBrowser();
    const storageState = await this.#captureStorageState();
    const context = await createIsolatedTradingViewCaptureContext(browser, storageState, {
      width: CAPTURE_WIDTH,
      height: CAPTURE_HEIGHT,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(this.config.timeoutMs);
    return {
      driver: new PlaywrightTradingViewCaptureDriver(page),
      dispose: async () => {
        await context.close();
      },
    };
  }

  async #captureStorageState(): Promise<TradingViewStorageState | undefined> {
    if (this.config.authStatePath) {
      return cloneTradingViewStorageState(
        await loadTradingViewStorageState(
          this.config.authStatePath,
          this.config.authCookieNames,
          this.config.authStorageKeys,
        ),
      );
    }
    if (this.config.cookieFile) {
      return cloneTradingViewStorageState({
        cookies: await loadCookieFile(
          this.config.cookieFile,
          this.config.authCookieNames,
        ),
        origins: [],
      });
    }
    if (this.#context) {
      return cloneTradingViewStorageState(filterTradingViewStorageState(
        await this.#context.storageState(),
        this.config.authCookieNames,
        this.config.authStorageKeys,
      ));
    }
    return undefined;
  }

  async #captureObservedState(
    driver: TradingViewCaptureDriver,
    requested: TradingViewCaptureBatchInput,
    interval: CaptureInterval,
    expectedUrl: string,
  ): Promise<TradingViewCaptureObservedState> {
    await driver.assertNoForbiddenDialog(`before DOM verification ${interval}`);
    const raw = await driver.observe(interval, requested.expectedIndicator);
    await driver.assertNoForbiddenDialog(`after DOM verification ${interval}`);
    return TradingViewCaptureObservedStateSchema.parse(
      classifyCaptureObservation(raw, requested, interval, expectedUrl),
    );
  }

  async #checkedCaptureAction<T>(
    driver: TradingViewCaptureDriver,
    stage: string,
    action: () => Promise<T>,
  ): Promise<T> {
    await driver.assertNoForbiddenDialog(`before ${stage}`);
    const result = await action();
    await driver.assertNoForbiddenDialog(`after ${stage}`);
    return result;
  }

  async #openChart(input: {
    symbol: string;
    interval: string;
    layoutId?: string | undefined;
  }): Promise<TradingViewChartState> {
    this.#assertEnabled();
    const symbol = validateSymbol(input.symbol);
    const interval = validateInterval(input.interval);
    const layoutId = input.layoutId === undefined ? undefined : validateLayoutId(input.layoutId);
    const page = await this.#getPage();
    const chartPath = layoutId ? `/chart/${layoutId}/` : "/chart/";
    const target = new URL(chartPath, `${this.config.baseUrl}/`);
    target.searchParams.set("symbol", symbol);
    target.searchParams.set("interval", interval);
    await page.goto(target.toString(), {
      waitUntil: "domcontentloaded",
      timeout: this.config.timeoutMs,
    });
    await this.#waitForChart(page);
    this.#symbol = symbol.toUpperCase();
    this.#interval = interval.toUpperCase();
    await this.#waitForRequestedSymbol(page, this.#symbol);
    if (/^\d+S$/i.test(this.#interval)) {
      await this.#selectSecondsInterval(page, this.#interval);
    }
    await page.waitForTimeout(300);
    return this.#getState();
  }

  async #selectSecondsInterval(page: Page, interval: string): Promise<void> {
    const seconds = Number.parseInt(interval.slice(0, -1), 10);
    const requestedLabel = new RegExp(`^${seconds}\\s*seconds?$`, "i");
    const actionTimeout = Math.min(this.config.timeoutMs, 8_000);
    await this.#dismissTransientDialogs(page);
    const intervalButton = page
      .getByRole("toolbar")
      .first()
      .getByRole("button", {
        name: /\d+\s*(?:seconds?|minutes?|hours?|days?|weeks?|months?)/i,
      })
      .first();
    await intervalButton.click({ timeout: actionTimeout });

    const secondsGroup = page.getByRole("row", { name: /^seconds?$/i }).first();
    if ((await secondsGroup.count()) > 0) {
      const expanded = await secondsGroup.getAttribute("aria-expanded");
      if (expanded !== "true") await secondsGroup.click({ timeout: actionTimeout });
    }
    await page
      .getByRole("row", { name: requestedLabel })
      .first()
      .click({ timeout: actionTimeout });
    await page.waitForTimeout(300);

    const upgrade = page.getByText(
      /upgrade.*(?:second|plan)/i,
    );
    if ((await upgrade.count()) > 0 && (await upgrade.first().isVisible().catch(() => false))) {
      await page.keyboard.press("Escape").catch(() => undefined);
      throw new Error(
        `TradingView interval ${interval} is not included in the current account plan. No upgrade was attempted.`,
      );
    }

    const selected = page
      .getByRole("toolbar")
      .first()
      .getByRole("button", { name: requestedLabel })
      .first();
    await selected.waitFor({ state: "visible", timeout: actionTimeout }).catch(() => {
      throw new Error(
        `TradingView did not switch to requested interval ${interval}; chart export was cancelled.`,
      );
    });
  }

  async #getState(): Promise<TradingViewChartState> {
    this.#assertEnabled();
    const page = this.#page;
    if (!page) throw new Error("No TradingView chart is open. Call tradingview_open_chart first.");
    const uiAuthenticated =
      (await page.getByRole("button", { name: /logged-in user/i }).count()) > 0;
    const contextCookies = (await this.#context?.cookies()) ?? [];
    const sessionAuthenticated = contextCookies.some(
      (cookie) => cookie.name.toLowerCase() === "sessionid" && cookie.value.length > 0,
    );
    const chartRegion = page.getByRole("region", { name: /chart/i }).first();
    const chartLabel = (await chartRegion.getAttribute("aria-label").catch(() => null)) ?? undefined;
    const bodyText = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
    return {
      url: page.url(),
      title: await page.title(),
      symbol: this.#symbol,
      interval: this.#interval,
      authenticated: uiAuthenticated || sessionAuthenticated,
      ...(chartLabel ? { chartLabel } : {}),
      delayed: /delayed data|data is delayed/i.test(bodyText),
    };
  }

  async #addIndicator(name: string): Promise<TradingViewChartState> {
    this.#assertEnabled();
    const indicator = validateLabel(name, "indicator", 120);
    const page = this.#requirePage();
    await page
      .getByRole("button", { name: /indicators, metrics & strategies/i })
      .click({ timeout: this.config.timeoutMs });
    const search = page.getByRole("searchbox", { name: /search/i });
    await search.fill(indicator);
    const exactItem = page.locator('[data-role="list-item"]').filter({ hasText: indicator }).first();
    await exactItem.waitFor({ state: "visible", timeout: this.config.timeoutMs });
    await exactItem.click({ force: true });
    await page.keyboard.press("Escape").catch(() => undefined);
    return this.#getState();
  }

  async #snapshot(options: {
    width?: number | undefined;
    height?: number | undefined;
    chartOnly?: boolean | undefined;
  } = {}): Promise<Buffer> {
    this.#assertEnabled();
    const page = this.#requirePage();
    const width = boundedInteger(options.width ?? 1_440, "width", 640, 2_560);
    const height = boundedInteger(options.height ?? 900, "height", 480, 1_800);
    await page.setViewportSize({ width, height });
    await this.#waitForChart(page);
    if (options.chartOnly ?? true) {
      return page.getByRole("region", { name: /chart/i }).first().screenshot({ type: "png" });
    }
    return page.screenshot({ type: "png", fullPage: false });
  }

  async #exportChartData(options: {
    loadChart?: boolean | undefined;
    outputName?: string | undefined;
  } = {}): Promise<{
    file: string;
    bytes: number;
    loaded: boolean;
    barCount?: number;
    sourceBarCount?: number;
    truncated?: boolean;
    chart?: ReturnType<ChartStore["getSummary"]>;
  }> {
    const archived = await this.#downloadChartData(options.outputName);
    if (!(options.loadChart ?? true)) {
      return { file: archived.file, bytes: archived.bytes, loaded: false };
    }
    const loaded = await loadBarsFromCsv(archived.file, this.dataRoot, {
      maximumBytes: MAX_EXPORT_BYTES,
      tailBars: MAX_BARS,
    });
    this.store.setBars({
      bars: loaded.bars,
      symbol: this.#symbol,
      interval: this.#interval,
      source: `TradingView Supercharts export:${path.basename(archived.target)}`,
    });
    return {
      file: archived.file,
      bytes: archived.bytes,
      loaded: true,
      barCount: loaded.bars.length,
      sourceBarCount: loaded.sourceBarCount,
      truncated: loaded.truncated,
      chart: this.store.getSummary(),
    };
  }

  async #getHistory(input: TradingViewHistoryInput): Promise<TradingViewHistoryResult> {
    const requestedBars = boundedInteger(input.bars ?? 1_000, "bars", 1, MAX_BARS);
    const state = await this.#openChart(input);
    await this.#assertChartUsable();
    const { archived, loaded } = await this.#exportRequestedHistory(
      requestedBars,
      input.outputName,
    );
    const chart = input.loadChart
      ? this.store.setBars({
          bars: loaded.bars,
          symbol: state.symbol,
          interval: state.interval,
          source: `TradingView Supercharts export:${path.basename(archived.target)}`,
        })
      : undefined;
    return {
      symbol: state.symbol,
      interval: state.interval,
      source: "TradingView Supercharts chart-data export",
      authenticated: state.authenticated,
      delayed: state.delayed,
      requestedBars,
      requestedBarsSatisfied: loaded.sourceBarCount >= requestedBars,
      barCount: loaded.bars.length,
      sourceBarCount: loaded.sourceBarCount,
      truncated: loaded.truncated,
      file: archived.file,
      bytes: archived.bytes,
      firstBar: loaded.bars[0]!,
      lastBar: loaded.bars.at(-1)!,
      bars: loaded.bars,
      ...(chart ? { chart: this.store.getSummary() } : {}),
    };
  }

  async #exportRequestedHistory(
    requestedBars: number,
    outputName: string | undefined,
  ): Promise<ParsedHistoryExport> {
    if (requestedBars > 350) {
      await this.#loadEarlierBars(requestedBars - 300);
    }

    let previousSourceCount = 0;
    let last: ParsedHistoryExport | undefined;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const archived = await this.#downloadChartData(outputName);
      const loaded = await loadBarsFromCsv(archived.file, this.dataRoot, {
        maximumBytes: MAX_EXPORT_BYTES,
        tailBars: requestedBars,
      });
      last = { archived, loaded };
      if (loaded.sourceBarCount >= requestedBars) return last;
      if (attempt > 0 && loaded.sourceBarCount <= previousSourceCount) return last;
      previousSourceCount = loaded.sourceBarCount;
      await this.#loadEarlierBars(requestedBars - loaded.sourceBarCount);
    }
    return last!;
  }

  async #loadEarlierBars(missingBars: number): Promise<void> {
    const page = this.#requirePage();
    await this.#dismissTransientDialogs(page);
    const chart = page.getByRole("region", { name: /chart/i }).first();
    await chart.click({ position: { x: 80, y: 120 }, timeout: this.config.timeoutMs });
    const jumps = Math.min(40, Math.max(2, Math.ceil(missingBars / 100)));
    for (let index = 0; index < jumps; index += 1) {
      await page.keyboard.press("Control+ArrowLeft");
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(750);
  }

  async #downloadChartData(outputName: string | undefined): Promise<ArchivedExport> {
    this.#assertEnabled();
    const page = this.#requirePage();
    const root = path.resolve(this.dataRoot);
    const configuredDownloads = path.resolve(this.config.downloadsDir);
    if (!pathIsInside(root, configuredDownloads)) {
      throw new Error("TradingView downloads directory must be inside MARKET_CHART_DATA_ROOT.");
    }
    await mkdir(configuredDownloads, { recursive: true });
    const [realRoot, realDownloads] = await Promise.all([
      realpath(root),
      realpath(configuredDownloads),
    ]);
    if (!pathIsInside(realRoot, realDownloads)) {
      throw new Error("TradingView downloads directory must resolve inside MARKET_CHART_DATA_ROOT.");
    }

    let download = await this.#startDownload(page);
    if (!download) {
      if (await this.#exportUpgradePromptVisible(page)) {
        throw new Error(
          "TradingView chart-data export is unavailable for this session. Use an authenticated account with chart export entitlement.",
        );
      }
      const decline = page.getByRole("button", { name: /no thanks|not now/i });
      if ((await decline.count()) > 0) await decline.first().click();
      download = await this.#startDownload(page);
    }
    if (!download) {
      throw new Error(
        "TradingView did not start a chart-data download. Verify the account plan and dismiss any subscription prompt.",
      );
    }

    const requestedName = outputName
      ? validateExportName(outputName)
      : `${slug(this.#symbol)}-${slug(this.#interval)}-${Date.now()}.csv`;
    const target = path.join(realDownloads, requestedName);
    const temporary = path.join(realDownloads, `.${randomUUID()}.download`);
    try {
      await download.saveAs(temporary);
      const details = await stat(temporary);
      if (!details.isFile() || details.size <= 0 || details.size > MAX_EXPORT_BYTES) {
        throw new Error("TradingView export is empty or exceeds the 50 MB safety limit.");
      }
      await rename(temporary, target);
      return {
        file: path.relative(realRoot, target),
        target,
        bytes: details.size,
      };
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async #assertChartUsable(): Promise<void> {
    const page = this.#requirePage();
    const invalid = page.getByText(
      /invalid symbol|symbol not found/i,
    );
    if ((await invalid.count()) > 0 && (await invalid.first().isVisible())) {
      throw new Error(`TradingView rejected symbol ${this.#symbol}.`);
    }
  }

  async #exportUpgradePromptVisible(page: Page): Promise<boolean> {
    const prompt = page.getByText(
      /upgrade (?:your )?plan/i,
    );
    return (await prompt.count()) > 0 && (await prompt.first().isVisible().catch(() => false));
  }

  async #close(): Promise<void> {
    const page = this.#page;
    const context = this.#context;
    const browser = this.#browser;
    this.#page = undefined;
    this.#context = undefined;
    this.#browser = undefined;
    await Promise.allSettled([
      page?.close(),
      context?.close(),
      browser?.close(),
    ]);
  }

  async #runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.#operationQueue;
    let release: () => void = () => undefined;
    this.#operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #startDownload(page: Page) {
    await this.#dismissTransientDialogs(page);
    const manageLayout = page.getByRole("button", { name: /manage layout/i });
    try {
      await manageLayout.click({ timeout: Math.min(this.config.timeoutMs, 8_000) });
    } catch {
      await this.#dismissTransientDialogs(page);
      await manageLayout.click({ force: true, timeout: this.config.timeoutMs });
    }
    const exportEntry = page
      .getByRole("gridcell", { name: /download chart data/i })
      .first();
    await exportEntry.click({ timeout: this.config.timeoutMs });
    const downloadButton = page.getByRole("button", { name: /^download$/i }).first();
    const downloadPromise = page
      .waitForEvent("download", { timeout: Math.min(this.config.timeoutMs, 10_000) })
      .catch(() => undefined);
    try {
      await downloadButton.click({ timeout: Math.min(this.config.timeoutMs, 8_000) });
    } catch {
      await downloadButton.click({ force: true, timeout: this.config.timeoutMs });
    }
    return downloadPromise;
  }

  async #dismissTransientDialogs(page: Page): Promise<void> {
    await page.keyboard.press("Escape").catch(() => undefined);
    const overlapRoot = page.locator('[data-name="overlap-manager-root"]');
    const scope = (await overlapRoot.count()) > 0 ? overlapRoot : page.locator("body");
    const candidates = [
      scope.getByRole("button", {
        name: /^(close|no thanks|not now|maybe later|skip)$/i,
      }),
      scope.locator(
        'button[aria-label*="Close" i], [data-name="close"], [data-name="close-button"]',
      ),
    ];
    for (const candidate of candidates) {
      const count = Math.min(await candidate.count(), 5);
      for (let index = 0; index < count; index += 1) {
        const button = candidate.nth(index);
        if (await button.isVisible().catch(() => false)) {
          await button.click({ force: true, timeout: 2_000 }).catch(() => undefined);
          await page.waitForTimeout(100);
          return;
        }
      }
    }
  }

  async #getPage(): Promise<Page> {
    if (this.#page && !this.#page.isClosed()) return this.#page;
    const context = await this.#getContext();
    this.#page = await context.newPage();
    this.#page.setDefaultTimeout(this.config.timeoutMs);
    return this.#page;
  }

  async #getContext(): Promise<BrowserContext> {
    if (this.#context) return this.#context;
    const storageState = this.config.authStatePath
      ? await loadTradingViewStorageState(
          this.config.authStatePath,
          this.config.authCookieNames,
          this.config.authStorageKeys,
        )
      : undefined;
    const browser = await this.#getBrowser();
    this.#context = await browser.newContext({
      viewport: { width: 1_440, height: 900 },
      locale: "en-US",
      acceptDownloads: true,
      ...(storageState ? { storageState } : {}),
    });
    if (!this.config.authStatePath && this.config.cookieFile) {
      const cookies = await loadCookieFile(
        this.config.cookieFile,
        this.config.authCookieNames,
      );
      await this.#context.addCookies(cookies);
    }
    return this.#context;
  }

  async #getBrowser(): Promise<Browser> {
    if (this.#browser?.isConnected()) return this.#browser;
    const { chromium } = await import("playwright");
    this.#browser = await chromium.launch({ headless: this.config.headless });
    return this.#browser;
  }

  async #waitForChart(page: Page): Promise<void> {
    await page
      .getByRole("region", { name: /chart/i })
      .first()
      .waitFor({ state: "visible", timeout: this.config.timeoutMs });
  }

  async #waitForRequestedSymbol(page: Page, symbol: string): Promise<void> {
    const [exchange, tickerWithExchange] = symbol.includes(":")
      ? symbol.split(":", 2)
      : [undefined, symbol];
    const ticker = tickerWithExchange ?? symbol;
    await page
      .waitForFunction(
        ({ expectedExchange, expectedTicker }) =>
          Array.from(document.querySelectorAll<HTMLElement>("[aria-label]")).some((element) => {
            const label = (element.getAttribute("aria-label") ?? "").toUpperCase();
            return (
              /CHART/i.test(label) &&
              label.includes(expectedTicker) &&
              (expectedExchange === undefined || label.includes(expectedExchange))
            );
          }),
        { expectedExchange: exchange, expectedTicker: ticker },
        { timeout: Math.min(this.config.timeoutMs, 15_000) },
      )
      .catch(async () => {
        await this.#assertChartUsable();
        throw new Error(`TradingView did not load the requested symbol ${symbol}.`);
      });
  }

  #requirePage(): Page {
    if (!this.#page || this.#page.isClosed()) {
      throw new Error("No TradingView chart is open. Call tradingview_open_chart first.");
    }
    return this.#page;
  }

  #assertEnabled(): void {
    if (!this.config.enabled) {
      throw new Error("TradingView browser is disabled. Set TRADINGVIEW_BROWSER_ENABLED=true.");
    }
  }
}

export class PlaywrightTradingViewCaptureDriver implements TradingViewCaptureDriver {
  #fatalGuardReason: string | undefined;
  #cleanupAllowedUntil = 0;
  #initialized = false;
  #localAudit: TradingViewCaptureDomObservation | undefined;
  #localAuditInterval: CaptureInterval | undefined;

  constructor(private readonly page: Page) {}

  async initializeReadOnly(): Promise<void> {
    if (this.#initialized) return;
    this.#initialized = true;
    await this.page.routeWebSocket(/.*/, (socket) => {
      const url = socket.url();
      if (isCommerceNetworkTarget(url, "WEBSOCKET")) {
        this.#fatalGuardReason = "a commerce/upgrade WebSocket was blocked before connection";
        void socket.close({ code: 1008, reason: "read-only capture guard" });
        return;
      }
      const server = socket.connectToServer();
      socket.onMessage((message) => {
        const payload = typeof message === "string" ? message : message.toString("utf8");
        if (FORBIDDEN_COMMERCE_REQUEST_PATTERN.test(payload)) {
          this.#fatalGuardReason = "a commerce/upgrade WebSocket message was blocked before send";
          return;
        }
        if (FORBIDDEN_MUTATION_PATTERN.test(`${url} ${payload}`)) {
          if (Date.now() > this.#cleanupAllowedUntil) {
            this.#fatalGuardReason = "a chart/layout save or autosave WebSocket message was blocked before send";
          }
          return;
        }
        server.send(message);
      });
    });
    await this.page.route("**/*", async (route) => {
      const request = route.request();
      const method = request.method().toUpperCase();
      const url = request.url();
      const body = request.postData() ?? "";
      const requestDescription = `${url} ${body}`;
      const commerceUrl = isCommerceNetworkTarget(url, method);
      const commerceBody = FORBIDDEN_COMMERCE_REQUEST_PATTERN.test(body);
      if (commerceUrl || commerceBody) {
        this.#fatalGuardReason = commerceUrl
          ? `a commerce/upgrade HTTP request to ${safeNetworkTarget(url)} was blocked before send`
          : "a commerce/upgrade HTTP request body was blocked before send";
        await route.abort("blockedbyclient");
        return;
      }
      if (FORBIDDEN_MUTATION_PATTERN.test(requestDescription)) {
        if (Date.now() > this.#cleanupAllowedUntil) {
          this.#fatalGuardReason = "a chart/layout save or autosave HTTP request was blocked before send";
        }
        await route.abort("blockedbyclient");
        return;
      }
      if (["GET", "HEAD", "OPTIONS"].includes(method)) {
        await route.continue();
        return;
      }
      // Analytics and other nonessential writes are blocked, but are not evidence that
      // the isolated chart attempted to persist user state.
      if (BENIGN_TELEMETRY_PATTERN.test(requestDescription)) {
        await route.abort("blockedbyclient");
        return;
      }
      await route.abort("blockedbyclient");
    });
  }

  async assertNoForbiddenDialog(stage: string): Promise<void> {
    if (this.#fatalGuardReason) {
      throw new Error(
        `TradingView capture aborted at ${stage}: ${this.#fatalGuardReason}; the read-only guard blocked it.`,
      );
    }
    let forbiddenSurfaceVisible = false;
    for (const frame of this.page.frames()) {
      const found = await frame
        .locator("body")
        .evaluate((body, patternSource) => {
          const pattern = new RegExp(patternSource, "i");
          const bodyElement = body as HTMLElement;
          if (pattern.test(bodyElement.innerText)) return true;
          return Array.from(bodyElement.querySelectorAll<HTMLElement>("*"))
            .filter((element) => {
              const style = window.getComputedStyle(element);
              return (
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                style.opacity !== "0" &&
                (element.offsetWidth > 0 ||
                  element.offsetHeight > 0 ||
                  element.getClientRects().length > 0)
              );
            })
            .some((element) =>
              pattern.test(
                [
                  element.getAttribute("aria-label"),
                  element.getAttribute("title"),
                  element.getAttribute("data-name"),
                  element.innerText,
                ]
                  .filter((value): value is string => typeof value === "string")
                  .join(" "),
              ),
            );
        }, FORBIDDEN_COMMERCE_PATTERN.source)
        .catch(() => false);
      if (found) {
        forbiddenSurfaceVisible = true;
        break;
      }
    }
    if (forbiddenSurfaceVisible) {
      throw new Error(
        `TradingView capture aborted at ${stage}: an upgrade, trial, purchase, subscription, or payment surface is visible in a page frame. No surface action was attempted.`,
      );
    }
  }

  async setViewportSize(width: number, height: number): Promise<void> {
    await this.page.setViewportSize({ width, height });
  }

  async navigate(url: string): Promise<void> {
    this.#localAudit = undefined;
    this.#localAuditInterval = undefined;
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
  }

  async waitForStableChart(symbol: string, interval: CaptureInterval): Promise<void> {
    await this.page
      .getByRole("region", { name: /chart/i })
      .first()
      .waitFor({ state: "visible" });
    await this.page.waitForFunction(
      ({ expectedSymbol, expectedInterval }) => {
        const visible = (element: Element): boolean => {
          const html = element as HTMLElement;
          const style = window.getComputedStyle(html);
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            (html.offsetWidth > 0 || html.offsetHeight > 0 || html.getClientRects().length > 0)
          );
        };
        const describe = (element: Element): string =>
          [
            element.getAttribute("aria-label"),
            element.getAttribute("title"),
            (element as HTMLElement).innerText,
            element.textContent,
          ]
            .filter((value): value is string => typeof value === "string")
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
        const normalizedSymbol = expectedSymbol.toUpperCase().replace(/\s+/g, "");
        const [exchange, ticker] = normalizedSymbol.split(":", 2);
        const chartRegions = Array.from(
          document.querySelectorAll('[role="region"][aria-label*="chart" i]'),
        ).filter(visible);
        const chartScope =
          chartRegions.length === 1
            ? chartRegions[0]!.closest('[class*="layout__area--center"]') ?? chartRegions[0]!
            : null;
        const chartLoaded =
          chartScope !== null &&
          Array.from(chartScope.querySelectorAll("canvas[aria-label]")).some((element) => {
            const label = (element.getAttribute("aria-label") ?? "")
              .toUpperCase()
              .replace(/\s+/g, "");
            return (
              visible(element) &&
              Boolean(ticker && label.includes(ticker)) &&
              Boolean(exchange && (label.includes(`${exchange}:`) || label.includes(`${exchange}_`)))
            );
          });
        let intervalControls = Array.from(
          document.querySelectorAll(
            'button[data-name="header-intervals-button"], [data-name="header-intervals-button"][role="button"]',
          ),
        ).filter(visible);
        if (intervalControls.length === 0) {
          const topToolbar = Array.from(document.querySelectorAll('[role="toolbar"]')).find(visible);
          intervalControls = topToolbar
            ? Array.from(topToolbar.querySelectorAll("button")).filter(visible)
            : [];
        }
        const currentInterval = intervalControls
          .map(describe)
          .some((label) => browserIntervalLabelMatches(label, expectedInterval));
        return chartLoaded && currentInterval;

        function browserIntervalLabelMatches(label: string, requested: string): boolean {
          const normalized = label.trim().replace(/\s+/g, " ");
          const patterns: Record<string, RegExp> = {
            "5": /(?:^|\b)5\s*(?:minutes?|mins?|min|m)(?:\b|$)/i,
            "60": /(?:^|\b)(?:1\s*(?:hours?|hrs?|h)|60\s*(?:minutes?|mins?|min|m))(?:\b|$)/i,
            "240": /(?:^|\b)(?:4\s*(?:hours?|hrs?|h)|240\s*(?:minutes?|mins?|min|m))(?:\b|$)/i,
            D: /(?:^|\b)(?:1\s*day|daily|D)(?:\b|$)/i,
            W: /(?:^|\b)(?:1\s*week|weekly|W)(?:\b|$)/i,
            M: /(?:^|\b)(?:1\s*month|monthly|M)(?:\b|$)/i,
          };
          return patterns[requested]?.test(normalized) ?? false;
        }
      },
      { expectedSymbol: symbol, expectedInterval: interval },
    );
    await this.page.waitForFunction(() => {
      const visible = (element: Element): boolean => {
        const html = element as HTMLElement;
        const style = window.getComputedStyle(html);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0" &&
          (html.offsetWidth > 0 || html.offsetHeight > 0 || html.getClientRects().length > 0)
        );
      };
      const charts = Array.from(
        document.querySelectorAll('[role="region"][aria-label*="chart" i]'),
      ).filter(visible);
      if (charts.length !== 1) return false;
      const scope =
        charts[0]!.closest('[class*="layout__area--center"]') ??
        charts[0]!.closest('[data-name="chart-container"]');
      if (!scope) return false;
      const text = (scope as HTMLElement).innerText;
      const canvases = Array.from(scope.querySelectorAll("canvas")).filter((canvas) => {
        if (!visible(canvas)) return false;
        const bounds = canvas.getBoundingClientRect();
        return bounds.width >= 200 && bounds.height >= 100;
      });
      const renderedAxis = (selector: string): boolean =>
        Array.from(scope.querySelectorAll(selector)).some(
          (axis) =>
            visible(axis) &&
            Array.from(axis.querySelectorAll("canvas")).some((canvas) => {
              if (!visible(canvas)) return false;
              const bounds = canvas.getBoundingClientRect();
              return bounds.width >= 20 && bounds.height >= 20;
            }),
        );
      const priceAxisRendered = renderedAxis(
        '[data-name^="price-axis" i], [class~="price-axis"], [class*="price-axis-container" i], [aria-label*="price axis" i]',
      );
      const timeAxisRendered = renderedAxis(
        '[data-name^="time-axis" i], [class~="time-axis"], [aria-label*="time axis" i]',
      );
      const ohlc =
        /(?:^|\s)O\s*[-+\d,.]+\s+H\s*[-+\d,.]+\s+L\s*[-+\d,.]+\s+C\s*[-+\d,.]+/i.test(
          text,
        );
      const loading = Array.from(
        scope.querySelectorAll(
          '[aria-busy="true"], [role="progressbar"], [data-name*="loading" i], [class*="loading" i]',
        ),
      ).some(visible);
      return canvases.length > 0 && priceAxisRendered && timeAxisRendered && ohlc && !loading;
    });
    await this.page.waitForTimeout(300);
    await this.page.waitForFunction(() => {
      const chart = document.querySelector<HTMLElement>(
        '[role="region"][aria-label*="chart" i]',
      );
      const scope =
        chart?.closest('[class*="layout__area--center"]') ??
        chart?.closest('[data-name="chart-container"]');
      return Boolean(scope && scope.querySelector("canvas"));
    });
  }

  async clearCrosshairAndTooltips(): Promise<void> {
    await this.page.mouse.move(CAPTURE_WIDTH - 2, 2);
    await this.page.waitForTimeout(100);
  }

  async pause(milliseconds: number): Promise<void> {
    await this.page.waitForTimeout(milliseconds);
  }

  async observe(
    interval: CaptureInterval,
    _expectedIndicator: { identity: string; name: string } | undefined,
  ): Promise<TradingViewCaptureDomObservation> {
    const passive = await this.page.evaluate(({ expectedInterval }) => {
      type RawControl = TradingViewCaptureControlObservation;
      type RawStudy = TradingViewCaptureStudyObservation;
      type RawSurface = TradingViewCaptureSurfaceObservation;

      const visible = (element: Element): boolean => {
        const html = element as HTMLElement;
        const style = window.getComputedStyle(html);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0" &&
          (html.offsetWidth > 0 || html.offsetHeight > 0 || html.getClientRects().length > 0)
        );
      };
      const describe = (element: Element): string =>
        [
          element.getAttribute("aria-label"),
          element.getAttribute("title"),
          (element as HTMLElement).innerText,
          element.textContent,
        ]
          .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
      const firstVisible = (
        root: ParentNode,
        selectors: string[],
        pattern?: RegExp,
      ): Element | null => {
        for (const selector of selectors) {
          for (const element of root.querySelectorAll(selector)) {
            if (visible(element) && (pattern === undefined || pattern.test(describe(element)))) {
              return element;
            }
          }
        }
        return null;
      };
      const explicitActive = (element: Element): boolean | null => {
        for (const attribute of ["aria-pressed", "aria-checked", "data-active"]) {
          const value = element.getAttribute(attribute)?.toLowerCase();
          if (value === "true") return true;
          if (value === "false") return false;
        }
        const state = element.getAttribute("data-state")?.toLowerCase();
        if (state === "on" || state === "active" || state === "selected") return true;
        if (state === "off" || state === "inactive" || state === "unselected") return false;
        const feedState = [
          element.getAttribute("data-status"),
          element.getAttribute("data-feed-status"),
          element.getAttribute("data-market-status"),
        ]
          .filter((value): value is string => typeof value === "string")
          .join(" ");
        if (/^(?:real[ -]?time|realtime|streaming)$/i.test(feedState.trim())) return true;
        if (/^(?:delayed|snapshot|end.of.day)$/i.test(feedState.trim())) return false;
        return null;
      };
      const control = (
        root: ParentNode,
        selectors: string[],
        pattern: RegExp,
        selectorName: string,
      ): RawControl | null => {
        const element = firstVisible(root, selectors, pattern);
        if (!element) return null;
        return { selector: selectorName, label: describe(element), active: explicitActive(element) };
      };
      const intervalMatches = (label: string, requested: string): boolean => {
        const normalized = label.trim().replace(/\s+/g, " ");
        const patterns: Record<string, RegExp> = {
          "5": /(?:^|\b)5\s*(?:minutes?|mins?|min|m)(?:\b|$)/i,
          "60": /(?:^|\b)(?:1\s*(?:hours?|hrs?|h)|60\s*(?:minutes?|mins?|min|m))(?:\b|$)/i,
          "240": /(?:^|\b)(?:4\s*(?:hours?|hrs?|h)|240\s*(?:minutes?|mins?|min|m))(?:\b|$)/i,
          D: /(?:^|\b)(?:1\s*day|daily|D)(?:\b|$)/i,
          W: /(?:^|\b)(?:1\s*week|weekly|W)(?:\b|$)/i,
          M: /(?:^|\b)(?:1\s*month|monthly|M)(?:\b|$)/i,
        };
        return patterns[requested]?.test(normalized) ?? false;
      };

      const exactSymbols = (label: string): string[] =>
        label
          .toUpperCase()
          .match(/[A-Z][A-Z0-9._+-]*:[A-Z0-9][A-Z0-9._!+-]*/g) ?? [];
      const chartCandidates = Array.from(
        document.querySelectorAll('[role="region"][aria-label]'),
      ).filter(
        (element) => visible(element) && /chart/i.test(element.getAttribute("aria-label") ?? ""),
      );
      const charts = chartCandidates.filter((element, index) =>
        chartCandidates.findIndex((candidate) => candidate === element) === index,
      );
      const chart = charts.length === 1 ? charts[0]! : null;
      const captureScope =
        chart?.closest('[data-qa-id="chart-page-grid-area"]') ??
        chart?.closest('[class*="layout__area--center"]') ??
        chart?.closest('[data-name="chart-container"]') ??
        null;
      const scope: ParentNode = captureScope ?? document.createDocumentFragment();
      const identityCanvases = Array.from(scope.querySelectorAll("canvas[aria-label]")).filter(
        (element) => {
          const label = (element.getAttribute("aria-label") ?? "")
            .toUpperCase()
            .replace(/\s+/g, "");
          return (
            visible(element) &&
            label.includes("NK2251!") &&
            (label.includes("OSE:") || label.includes("OSE_"))
          );
        },
      );
      const identityCanvas = identityCanvases.length === 1 ? identityCanvases[0]! : null;
      const symbolLinks = Array.from(scope.querySelectorAll('a[href*="/symbols/"]')).filter(
        (element) => {
          if (!visible(element)) return false;
          try {
            return new URL((element as HTMLAnchorElement).href).pathname ===
              "/symbols/OSE-NK2251!/";
          } catch {
            return false;
          }
        },
      );
      const symbolLink = symbolLinks.length === 1 ? symbolLinks[0]! : null;

      let intervalControl = firstVisible(scope, [
        'button[data-name="header-intervals-button"]',
        '[data-name="header-intervals-button"][role="button"]',
      ]);
      if (!intervalControl) {
        const topToolbar = firstVisible(scope, ['[role="toolbar"]']);
        intervalControl = topToolbar
          ? Array.from(topToolbar.querySelectorAll("button")).find(
              (button) => visible(button) && intervalMatches(describe(button), expectedInterval),
            ) ?? null
          : null;
      }
      const chartTypeControl = firstVisible(scope, [
        'button[data-name="header-chart-type"]',
        'button[data-name="series-properties"]',
        '[data-name*="chart-type"][role="button"]',
        'button[aria-label*="candl" i]',
      ]);
      const authenticatedControl = firstVisible(document, [
        'button[aria-label*="logged-in user" i]',
      ]);
      const timezoneControl = firstVisible(scope, [
        'button[data-name*="timezone" i]',
        '[data-name*="timezone" i][role="button"]',
        'button[aria-label*="timezone" i]',
      ]);
      const sessionControl = firstVisible(scope, [
        'button[data-name*="session" i]',
        '[data-name*="session" i][role="button"]',
        'button[aria-label*="session" i]',
      ]);
      const mainLegend = firstVisible(scope, ['[data-qa-id="legend-series-item"]']);
      const realtimeControl = mainLegend
        ? firstVisible(mainLegend, [
            '[data-qa-id="legend-source-item-status"]',
            '[data-role="statuses-pill"]',
          ])
        : null;
      const backAdjustment = control(
        scope,
        [
          'button[data-name*="back-adjust" i]',
          '[data-name*="back-adjust" i][role="button"]',
          'button[aria-label*="back adjustment" i]',
        ],
        /back.?adjust|B-?ADJ/i,
        "explicit back-adjustment control",
      );
      const settlementAsClose = control(
        scope,
        [
          'button[data-name*="settlement" i]',
          '[data-name*="settlement" i][role="button"]',
          'button[aria-label*="settlement" i]',
        ],
        /settlement.{0,20}close|SET/i,
        "explicit settlement-as-close control",
      );

      const chartText = captureScope ? (captureScope as HTMLElement).innerText : "";
      const visibleCanvases = Array.from(scope.querySelectorAll("canvas")).filter((element) => {
        if (!visible(element)) return false;
        const bounds = element.getBoundingClientRect();
        return bounds.width >= 200 && bounds.height >= 100;
      });
      const renderedAxis = (selector: string): boolean =>
        Array.from(scope.querySelectorAll(selector)).some(
          (axis) =>
            visible(axis) &&
            Array.from(axis.querySelectorAll("canvas")).some((canvas) => {
              if (!visible(canvas)) return false;
              const bounds = canvas.getBoundingClientRect();
              return bounds.width >= 20 && bounds.height >= 20;
            }),
        );
      const priceAxisRendered = renderedAxis(
        '[data-name^="price-axis" i], [class~="price-axis"], [class*="price-axis-container" i], [aria-label*="price axis" i]',
      );
      const timeAxisRendered = renderedAxis(
        '[data-name^="time-axis" i], [class~="time-axis"], [aria-label*="time axis" i]',
      );
      const axisEvidenceCount = Number(priceAxisRendered) + Number(timeAxisRendered);
      const ohlcEvidenceVisible =
        /(?:^|\s)O\s*[-+\d,.]+\s+H\s*[-+\d,.]+\s+L\s*[-+\d,.]+\s+C\s*[-+\d,.]+/i.test(
          chartText,
        );
      const loadingVisible = Array.from(
        scope.querySelectorAll(
          '[aria-busy="true"], [role="progressbar"], [data-name*="loading" i], [class*="loading" i]',
        ),
      ).some(visible) || /(?:^|\s)Loading(?:\.{0,3}|\s|$)/i.test(chartText);
      const allLegendContainers = Array.from(
        scope.querySelectorAll(
          '[data-name="legend"], [data-name*="chart-legend" i], [data-name*="pane-legend" i]',
        ),
      );
      const legendContainers = allLegendContainers.filter(visible);
      const hiddenLegendCount = allLegendContainers.length - legendContainers.length;
      const discoveredSourceElements = legendContainers
        .flatMap((legend) =>
          Array.from(
            legend.querySelectorAll(
              '[data-name="legend-source-item"], [data-study-id], [data-pine-id], [data-script-id], [data-symbol]',
            ),
          ),
        )
        .filter((element, index, all) => all.indexOf(element) === index);
      const sourceElements = discoveredSourceElements.filter(visible);
      const collapsedStudyElements = discoveredSourceElements.filter(
        (element) =>
          !visible(element) &&
          ["data-study-id", "data-pine-id", "data-script-id"].some((attribute) =>
            Boolean(element.getAttribute(attribute)?.trim()),
          ),
      );
      const collapsedStudyCount = collapsedStudyElements.length;
      const collapsedStudyIdentities = collapsedStudyElements
        .map(
          (element) =>
            element.getAttribute("data-pine-id") ??
            element.getAttribute("data-script-id") ??
            element.getAttribute("data-study-id"),
        )
        .filter((value): value is string => value !== null && value.trim().length > 0);
      let studies: RawStudy[] = [];
      let comparisons: RawSurface[] = [];
      let mainSeriesCount = 0;
      let unclassifiedSurfaceCount = 0;
      for (const element of sourceElements) {
        const text = describe(element);
        const studyId = element.getAttribute("data-study-id");
        const pineId = element.getAttribute("data-pine-id");
        const scriptId = element.getAttribute("data-script-id");
        const symbolId = element.getAttribute("data-symbol");
        const attributes = [studyId, pineId, scriptId]
          .filter((value): value is string => value !== null && value.trim().length > 0)
          .join(" ");
        const textSymbols = exactSymbols(`${symbolId ?? ""} ${text}`);
        if (textSymbols.includes("OSE:NK2251!") && attributes.length === 0) {
          mainSeriesCount += 1;
          continue;
        }
        const isStudy = attributes.length > 0;
        if (!isStudy && textSymbols.length > 0) {
          comparisons.push({
            selector: "chart-scoped comparison legend source item",
            text,
            identity: symbolId ?? textSymbols[0] ?? null,
            name: element.getAttribute("data-series-name"),
          });
          continue;
        }
        if (!isStudy) {
          unclassifiedSurfaceCount += 1;
          continue;
        }
        const source: RawStudy["source"] =
          pineId || scriptId || /\bpine\b|(?:PUB|USER|PINE);/i.test(`${attributes} ${text}`)
            ? "pine"
            : studyId && /^(?:STD;)|ichimoku|builtin|built-in/i.test(studyId)
              ? "builtin"
              : /built-?in/i.test(text)
                ? "builtin"
                : "unknown";
        const identity = pineId ?? scriptId ?? studyId;
        const name =
          element.getAttribute("data-study-name") ??
          element.getAttribute("data-script-name") ??
          element.getAttribute("data-title");
        studies.push({
          selector: "chart-scoped study legend DOM item",
          text,
          identity,
          name,
          source,
        });
      }

      const drawingInventoryRoot = firstVisible(
        document,
        [
          '[data-name="tree"][data-tradingview-mcp-audit-root="object-tree"]',
          '[data-name="tree"]',
        ],
      );
      const drawingElements = drawingInventoryRoot
        ? Array.from(
            drawingInventoryRoot.querySelectorAll(
              '[data-drawing-id], [data-object-id][data-type*="drawing" i], [data-shape-id], [data-name="drawing"]',
            ),
          )
            .filter(visible)
            .filter((element, index, all) => all.indexOf(element) === index)
        : [];
      let drawings: RawSurface[] = drawingElements.map((element) => ({
        selector: "chart-scoped drawing DOM item",
        text: describe(element),
        identity:
          element.getAttribute("data-drawing-id") ??
          element.getAttribute("data-object-id") ??
          element.getAttribute("data-shape-id"),
        name: element.getAttribute("data-name"),
      }));
      let objectTreeRowsAudited = false;
      let auditedCollapsedStudyCount = collapsedStudyCount;
      if (drawingInventoryRoot?.matches('[data-name="tree"]')) {
        const objectRows = Array.from(
          drawingInventoryRoot.querySelectorAll(
            '[class^="listContainer-"] > div > div, [role="treeitem"], [data-tradingview-mcp-object-tree-row]',
          ),
        )
          .filter(visible)
          .filter(
            (element, index, all) =>
              all.findIndex(
                (candidate) =>
                  candidate === element ||
                  (candidate.contains(element) && describe(candidate) === describe(element)),
              ) === index,
          )
          .map((element) => ({
            element,
            text: ((element as HTMLElement).innerText || element.textContent || "")
              .replace(/\s+/g, " ")
              .trim(),
          }))
          .filter((item) => item.text.length > 0);
        const mainRows = objectRows.filter((item) =>
          /^(?:NK2251!\s*[-/]\s*OSE|OSE:NK2251!)(?:\s*,\s*\S+)?$/i.test(item.text),
        );
        const nonMainRows = objectRows.filter((item) => !mainRows.includes(item));
        const legendStudies = studies;
        const legendComparisons = comparisons;
        studies = [];
        comparisons = [];
        unclassifiedSurfaceCount = mainRows.length === 1 ? 0 : Math.abs(mainRows.length - 1);
        for (const item of nonMainRows) {
          const identityElement =
            [item.element, ...Array.from(item.element.querySelectorAll("*"))].find((element) =>
              ["data-study-id", "data-pine-id", "data-script-id"].some((attribute) =>
                Boolean(element.getAttribute(attribute)?.trim()),
              ),
            ) ?? null;
          if (identityElement) {
            const studyId = identityElement.getAttribute("data-study-id");
            const pineId = identityElement.getAttribute("data-pine-id");
            const scriptId = identityElement.getAttribute("data-script-id");
            const identity = pineId ?? scriptId ?? studyId;
            const name =
              identityElement.getAttribute("data-study-name") ??
              identityElement.getAttribute("data-script-name") ??
              identityElement.getAttribute("data-title") ??
              item.text;
            const source: RawStudy["source"] =
              pineId || scriptId || /\bpine\b|(?:PUB|USER|PINE);/i.test(`${identity ?? ""} ${item.text}`)
                ? "pine"
                : studyId && /^(?:STD;)|ichimoku|builtin|built-in/i.test(studyId)
                  ? "builtin"
                  : "unknown";
            studies.push({
              selector: "opened Object Tree structured indicator row",
              text: item.text,
              identity,
              name,
              source,
            });
            continue;
          }
          const structuredDrawing =
            [item.element, ...Array.from(item.element.querySelectorAll("*"))].find((element) =>
              ["data-drawing-id", "data-shape-id", "data-object-id"].some((attribute) =>
                Boolean(element.getAttribute(attribute)?.trim()),
              ),
            ) ?? null;
          if (structuredDrawing) {
            const identity =
              structuredDrawing.getAttribute("data-drawing-id") ??
              structuredDrawing.getAttribute("data-shape-id") ??
              structuredDrawing.getAttribute("data-object-id");
            if (!drawings.some((drawing) => drawing.identity === identity)) {
              drawings.push({
                selector: "opened Object Tree structured drawing row",
                text: item.text,
                identity,
                name: structuredDrawing.getAttribute("data-name") ?? item.text,
              });
            }
            continue;
          }
          const comparisonMatch = item.text.match(
            /^([A-Z0-9._!+-]+)\s*[-/]\s*([A-Z][A-Z0-9._+-]+)(?:\s*,|$)/i,
          );
          if (comparisonMatch) {
            comparisons.push({
              selector: "opened Object Tree comparison row",
              text: item.text,
              identity: `${comparisonMatch[2]!.toUpperCase()}:${comparisonMatch[1]!.toUpperCase()}`,
              name: comparisonMatch[1]!,
            });
            continue;
          }
          if (
            /^(?:Volume|SMA|EMA|WMA|BB|Bollinger|MACD|RSI|Ichimoku|VWAP|ATR|Stoch)/i.test(
              item.text,
            )
          ) {
            studies.push({
              selector: "opened Object Tree indicator row",
              text: item.text,
              identity: null,
              name: item.text,
              source: "unknown",
            });
            continue;
          }
          if (
            /trend\s*line|horizontal|vertical|ray|rectangle|ellipse|fibonacci|pitchfork|text|arrow|brush/i.test(
              item.text,
            )
          ) {
            if (!drawings.some((drawing) => drawing.text === item.text)) {
              drawings.push({
                selector: "opened Object Tree drawing row",
                text: item.text,
                identity: null,
                name: item.text,
              });
            }
            continue;
          }
          unclassifiedSurfaceCount += 1;
        }
        const normalized = (value: string | null): string =>
          (value ?? "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
        for (const legendStudy of legendStudies) {
          const matchingTreeStudy = studies.find(
            (treeStudy) =>
              (legendStudy.identity !== null && treeStudy.identity === legendStudy.identity) ||
              (normalized(legendStudy.name) !== "" &&
                (normalized(treeStudy.name) === normalized(legendStudy.name) ||
                  normalized(treeStudy.text) === normalized(legendStudy.name))),
          );
          if (matchingTreeStudy) {
            matchingTreeStudy.identity ??= legendStudy.identity;
            if (matchingTreeStudy.source === "unknown") {
              matchingTreeStudy.source = legendStudy.source;
            }
            if (
              legendStudy.name !== null &&
              (matchingTreeStudy.name === null || matchingTreeStudy.name === matchingTreeStudy.text)
            ) {
              matchingTreeStudy.name = legendStudy.name;
            }
          } else {
            studies.push(legendStudy);
          }
        }
        for (const legendComparison of legendComparisons) {
          if (
            !comparisons.some(
              (treeComparison) =>
                treeComparison.identity !== null &&
                treeComparison.identity === legendComparison.identity,
            )
          ) {
            comparisons.push(legendComparison);
          }
        }
        auditedCollapsedStudyCount = collapsedStudyIdentities.filter(
          (identity) => !studies.some((study) => study.identity === identity),
        ).length;
        mainSeriesCount = 1;
        objectTreeRowsAudited = objectRows.length > 0 && mainRows.length === 1;
      }
      if (mainSeriesCount !== 1) unclassifiedSurfaceCount += Math.abs(mainSeriesCount - 1);
      unclassifiedSurfaceCount += hiddenLegendCount;
      const objectTreeInventoryComplete =
        objectTreeRowsAudited && unclassifiedSurfaceCount === 0;

      return {
        pageUrl: window.location.href,
        chartCount: charts.length,
        chartAuditComplete:
          captureScope !== null && identityCanvas !== null,
        chartAriaLabel: identityCanvas?.getAttribute("aria-label") ?? null,
        chartSelector: identityCanvas
          ? "visible chart identity canvas [aria-label]"
          : null,
        symbolLinkHref: symbolLink ? (symbolLink as HTMLAnchorElement).href : null,
        symbolLinkSelector: symbolLink
          ? 'visible exact /symbols/OSE-NK2251!/ chart link'
          : null,
        intervalLabel: intervalControl ? describe(intervalControl) : null,
        intervalSelector: intervalControl ? 'visible [data-name="header-intervals-button"]' : null,
        chartTypeLabel: chartTypeControl ? describe(chartTypeControl) : null,
        chartTypeSelector: chartTypeControl ? "visible chart-type toolbar control" : null,
        authenticatedControlVisible: authenticatedControl !== null,
        authenticatedSelector: authenticatedControl ? "visible authenticated-account control" : null,
        delayedLabelVisible:
          realtimeControl !== null &&
          /delayed\s+data|data\s+is\s+delayed/i.test(
            describe(realtimeControl),
          ),
        realtimeLabel: realtimeControl ? describe(realtimeControl) : null,
        realtimeSelector: realtimeControl ? "main-series market-data status control" : null,
        realtimeActive: realtimeControl
          ? /real[ -]?time|realtime/i.test(describe(realtimeControl))
            ? true
            : /delayed/i.test(describe(realtimeControl))
              ? false
              : explicitActive(realtimeControl)
          : null,
        timezoneLabel: timezoneControl ? describe(timezoneControl) : null,
        timezoneSelector: timezoneControl ? "visible timezone control" : null,
        sessionLabel: sessionControl ? describe(sessionControl) : null,
        sessionSelector: sessionControl ? "visible trading-session control" : null,
        backAdjustment,
        settlementAsClose,
        studyAuditSelector:
          objectTreeInventoryComplete
            ? "opened Object Tree indicator-row inventory"
            : legendContainers.length > 0
              ? "visible chart/pane legend study-item audit"
              : null,
        studyAuditComplete:
          objectTreeInventoryComplete || (legendContainers.length > 0 && hiddenLegendCount === 0),
        studies,
        collapsedStudyCount: objectTreeInventoryComplete
          ? auditedCollapsedStudyCount
          : collapsedStudyCount,
        comparisonAuditSelector:
          objectTreeInventoryComplete
            ? "opened Object Tree comparison-row inventory"
            : legendContainers.length > 0
              ? "chart-scoped complete legend source inventory"
              : null,
        comparisonAuditComplete:
          objectTreeInventoryComplete || (legendContainers.length > 0 && hiddenLegendCount === 0),
        comparisons,
        drawingAuditSelector: objectTreeInventoryComplete
          ? "opened Object Tree row-complete drawing inventory"
          : null,
        drawingAuditComplete: objectTreeInventoryComplete,
        drawings,
        unclassifiedSurfaceCount,
        settingsAuditSelector: null,
        settingsAuditComplete: false,
        objectTreeAuditSelector: objectTreeInventoryComplete
          ? "opened chart Object Tree with one classified main-series row"
          : null,
        objectTreeAuditComplete: objectTreeInventoryComplete,
        renderAuditSelector:
          captureScope && visibleCanvases.length > 0
            ? "chart-scoped visible canvas/OHLC/axis audit"
            : null,
        renderAuditComplete:
          visibleCanvases.length > 0 &&
          axisEvidenceCount >= 2 &&
          ohlcEvidenceVisible &&
          !loadingVisible,
        visibleCanvasCount: visibleCanvases.length,
        axisEvidenceCount,
        ohlcEvidenceVisible,
        loadingVisible,
      } satisfies TradingViewCaptureDomObservation;
    }, { expectedInterval: interval });
    if (!this.#localAudit || this.#localAuditInterval !== interval) return passive;
    return {
      ...passive,
      timezoneLabel: this.#localAudit.timezoneLabel,
      timezoneSelector: this.#localAudit.timezoneSelector,
      sessionLabel: this.#localAudit.sessionLabel,
      sessionSelector: this.#localAudit.sessionSelector,
      backAdjustment: this.#localAudit.backAdjustment,
      settlementAsClose: this.#localAudit.settlementAsClose,
      studyAuditSelector: this.#localAudit.studyAuditSelector,
      studyAuditComplete: this.#localAudit.studyAuditComplete,
      studies: this.#localAudit.studies,
      collapsedStudyCount: this.#localAudit.collapsedStudyCount,
      comparisonAuditSelector: this.#localAudit.comparisonAuditSelector,
      comparisonAuditComplete: this.#localAudit.comparisonAuditComplete,
      comparisons: this.#localAudit.comparisons,
      drawingAuditSelector: this.#localAudit.drawingAuditSelector,
      drawingAuditComplete: this.#localAudit.drawingAuditComplete,
      drawings: this.#localAudit.drawings,
      unclassifiedSurfaceCount: this.#localAudit.unclassifiedSurfaceCount,
      settingsAuditSelector: this.#localAudit.settingsAuditSelector,
      settingsAuditComplete: this.#localAudit.settingsAuditComplete,
      objectTreeAuditSelector: this.#localAudit.objectTreeAuditSelector,
      objectTreeAuditComplete: this.#localAudit.objectTreeAuditComplete,
    };
  }

  async screenshotFullViewport(): Promise<Buffer> {
    return this.page.screenshot({ type: "png", fullPage: false });
  }

  async auditLocalState(
    interval: CaptureInterval,
    expectedOverlayMode: TradingViewCaptureBatchInput["expectedOverlayMode"],
    expectedIndicator: { identity: string; name: string } | undefined,
  ): Promise<void> {
    this.#localAudit = undefined;
    this.#localAuditInterval = undefined;

    const objectTreeButton = await this.#firstVisibleLocator(
      [
        'button[data-name="object-tree"]',
        'button[data-name="object-tree-button"]',
        'button[aria-label*="Object Tree" i]',
        '[role="button"][aria-label*="Object Tree" i]',
      ].join(", "),
    );
    if (!objectTreeButton) {
      throw new Error(
        `TradingView capture rejected ${interval}: the Object Tree control could not be found for a local inventory audit.`,
      );
    }
    await this.#safeClick(objectTreeButton, `open Object Tree ${interval}`);
    const objectTreeRoot = await this.#waitForVisibleLocator(
      '[data-name="tree"]',
    );
    if (!objectTreeRoot) {
      throw new Error(
        `TradingView capture rejected ${interval}: opening Object Tree did not expose a loaded local inventory.`,
      );
    }
    await objectTreeRoot.evaluate((element) => {
      element.setAttribute("data-tradingview-mcp-audit-root", "object-tree");
    });

    let inventory = await this.observe(interval, expectedIndicator);
    if (!inventory.objectTreeAuditComplete || !inventory.drawingAuditComplete) {
      throw new Error(
        `TradingView capture rejected ${interval}: the opened Object Tree inventory could not be classified.`,
      );
    }
    if (expectedIndicator) {
      const exactStudy = inventory.studies.filter(
        (study) =>
          study.identity === expectedIndicator.identity &&
          study.name !== null &&
          normalizedTextEquals(study.name, expectedIndicator.name),
      );
      if (exactStudy.length !== 1) {
        throw new Error(
          `TradingView capture rejected ${interval}: Object Tree does not prove exactly one expected indicator identity and name.`,
        );
      }
    }

    const hasExtraSurfaces =
      inventory.studies.length > 0 ||
      inventory.comparisons.length > 0 ||
      inventory.drawings.length > 0 ||
      inventory.collapsedStudyCount > 0 ||
      inventory.unclassifiedSurfaceCount > 0;
    if (expectedOverlayMode === "candles_only" && hasExtraSurfaces) {
      await this.#removeStructuredObjectTreeExtras(objectTreeRoot, interval);
      inventory = await this.observe(interval, undefined);
      if (
        inventory.studies.length > 0 ||
        inventory.comparisons.length > 0 ||
        inventory.drawings.length > 0 ||
        inventory.collapsedStudyCount > 0 ||
        inventory.unclassifiedSurfaceCount > 0
      ) {
        throw new Error(
          `TradingView capture rejected ${interval}: isolated Object Tree cleanup could not prove a candles-only chart.`,
        );
      }
    }

    await this.#safeClick(objectTreeButton, `close Object Tree ${interval}`);
    const timezoneAudit = await this.#auditTimezoneMenu(interval);
    const sessionAudit = await this.#auditFullSessionMenu(interval);

    const settingsButton = await this.#firstVisibleLocator(
      [
        'button[data-name="chart-properties-button"]',
        'button[data-name="chart-properties"]',
        'button[data-name="header-toolbar-properties"]',
        'button[aria-label*="Chart settings" i]',
        'button[aria-label*="Chart Settings" i]',
      ].join(", "),
    );
    if (!settingsButton) {
      throw new Error(
        `TradingView capture rejected ${interval}: the chart settings control could not be found for a local audit.`,
      );
    }
    await this.#safeClick(settingsButton, `open chart settings ${interval}`);
    const settingsDialog = await this.#waitForVisibleLocator(
      '[role="dialog"]:has-text("Settings")',
    );
    if (!settingsDialog) {
      throw new Error(
        `TradingView capture rejected ${interval}: chart settings did not open for a local audit.`,
      );
    }
    const symbolTab = await this.#firstVisibleLocator(
      '[role="tab"]:text-is("Symbol")',
      settingsDialog,
    );
    if (symbolTab) await this.#safeClick(symbolTab, `open symbol settings ${interval}`);
    const settings = await this.#readSettingsDialog(settingsDialog, interval);
    if (!settings.backAdjustment || !settings.settlementAsClose) {
      const missing = [
        !settings.backAdjustment ? "back-adjustment" : null,
        !settings.settlementAsClose ? "settlement-as-close" : null,
      ]
        .filter((value): value is string => value !== null)
        .join(", ");
      throw new Error(
        `TradingView capture rejected ${interval}: opened settings audit is missing ${missing}.`,
      );
    }
    await this.page.keyboard.press("Escape");
    await this.waitForStableChart("OSE:NK2251!", interval);
    const passiveAfterAudit = await this.observe(interval, expectedIndicator);
    this.#localAudit = {
      ...passiveAfterAudit,
      timezoneLabel: timezoneAudit.label,
      timezoneSelector: timezoneAudit.selector,
      sessionLabel: sessionAudit.label,
      sessionSelector: sessionAudit.selector,
      backAdjustment: settings.backAdjustment,
      settlementAsClose: settings.settlementAsClose,
      studyAuditSelector: "opened Object Tree plus visible chart/pane legend study inventory",
      studyAuditComplete: inventory.studyAuditComplete,
      studies: inventory.studies,
      collapsedStudyCount: inventory.collapsedStudyCount,
      comparisonAuditSelector: "opened Object Tree plus complete chart legend comparison inventory",
      comparisonAuditComplete: inventory.comparisonAuditComplete,
      comparisons: inventory.comparisons,
      drawingAuditSelector: "opened and loaded Object Tree drawing inventory",
      drawingAuditComplete: inventory.drawingAuditComplete,
      drawings: inventory.drawings,
      unclassifiedSurfaceCount: inventory.unclassifiedSurfaceCount,
      settingsAuditSelector:
        "opened chart settings dialog/symbol tab plus timezone and session menus",
      settingsAuditComplete: true,
      objectTreeAuditSelector: "opened and loaded chart Object Tree",
      objectTreeAuditComplete: true,
    };
    this.#localAuditInterval = interval;
  }

  async #readSettingsDialog(settingsDialog: Locator, interval: CaptureInterval): Promise<{
    backAdjustment: TradingViewCaptureControlObservation | null;
    settlementAsClose: TradingViewCaptureControlObservation | null;
  }> {
    return settingsDialog.evaluate((dialog, expectedInterval) => {
      const visible = (element: Element): boolean => {
        const html = element as HTMLElement;
        const style = window.getComputedStyle(html);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0" &&
          (html.offsetWidth > 0 || html.offsetHeight > 0 || html.getClientRects().length > 0)
        );
      };
      const describe = (element: Element): string =>
        [
          element.getAttribute("aria-label"),
          element.getAttribute("title"),
          element.closest("label")?.textContent,
          element.textContent,
        ]
          .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
      const candidates = Array.from(
        dialog.querySelectorAll(
          'input, label, button, [role="button"], [role="checkbox"], [role="switch"], [role="combobox"], [data-name="options-dropdown"], [aria-checked], [aria-pressed]',
        ),
      ).filter(visible);
      const find = (pattern: RegExp): Element | null =>
        candidates.find((element) => pattern.test(describe(element))) ?? null;
      const active = (element: Element): boolean | null => {
        if (element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)) {
          return element.checked;
        }
        if (element instanceof HTMLLabelElement) {
          const input = element.querySelector<HTMLInputElement>('input[type="checkbox"], input[type="radio"]');
          if (input) return input.checked;
        }
        for (const attribute of ["aria-checked", "aria-pressed", "data-active"]) {
          const value = element.getAttribute(attribute)?.toLowerCase();
          if (value === "true") return true;
          if (value === "false") return false;
        }
        const state = element.getAttribute("data-state")?.toLowerCase();
        if (["on", "active", "selected", "checked"].includes(state ?? "")) return true;
        if (["off", "inactive", "unselected", "unchecked"].includes(state ?? "")) return false;
        return null;
      };
      const asControl = (
        element: Element | null,
        selector: string,
      ): TradingViewCaptureControlObservation | null =>
        element ? { selector, label: describe(element), active: active(element) } : null;
      const backAdjustment = find(
        /back.?adjust|adjustment\s+for\s+contract\s+changes|B-?ADJ/i,
      );
      const settlementAsClose = find(
        /settlement.{0,30}close|use\s+settlement.{0,20}close/i,
      );
      return {
        backAdjustment: asControl(backAdjustment, "opened settings back-adjustment control"),
        settlementAsClose: asControl(
          settlementAsClose,
          "opened settings settlement-as-close control",
        ) ??
          (/^(?:5|60|240)$/.test(expectedInterval)
            ? {
                selector: "opened settings settlement-as-close applicability audit",
                label: "Settlement as close is not applicable to this intraday interval",
                active: false,
              }
            : null),
      };
    }, interval);
  }

  async #auditTimezoneMenu(
    interval: CaptureInterval,
  ): Promise<{ label: string; selector: string }> {
    const button = await this.#firstVisibleLocator(
      [
        'button[data-name="time-zone-menu"]',
        'button[data-name*="timezone" i]',
        'button[aria-label*="timezone" i]',
      ].join(", "),
    );
    if (!button) {
      throw new Error(
        `TradingView capture rejected ${interval}: the chart timezone menu control is unavailable.`,
      );
    }
    await this.#safeClick(button, `open timezone menu ${interval}`);
    const menu = await this.#waitForVisibleLocator(
      [
        '[data-tradingview-mcp-timezone-menu]:has-text("Tokyo")',
        '[role="listbox"]:has-text("Tokyo")',
        '[role="menu"]:has-text("Tokyo")',
        'div[class*="menuWrap-"]:has-text("Tokyo")',
      ].join(", "),
    );
    if (!menu) {
      throw new Error(
        `TradingView capture rejected ${interval}: opening the timezone control did not expose its option inventory.`,
      );
    }
    const selectedTokyo = await menu.evaluate((root) => {
      const visible = (element: Element): boolean => {
        const html = element as HTMLElement;
        const style = window.getComputedStyle(html);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0" &&
          (html.offsetWidth > 0 || html.offsetHeight > 0 || html.getClientRects().length > 0)
        );
      };
      const normalized = (element: Element): string =>
        ((element as HTMLElement).innerText || element.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
      const selected = (element: Element): boolean => {
        for (let current: Element | null = element; current && root.contains(current); current = current.parentElement) {
          if (
            current.getAttribute("aria-selected") === "true" ||
            current.getAttribute("aria-checked") === "true" ||
            current.getAttribute("data-selected") === "true" ||
            /(?:^|\s)(?:checked|selected)(?:-|_|\s|$)/i.test(current.getAttribute("class") ?? "")
          ) {
            return true;
          }
        }
        return false;
      };
      const leaves = Array.from(root.querySelectorAll("*")).filter(
        (element) =>
          visible(element) &&
          !Array.from(element.children).some(
            (child) => visible(child) && normalized(child) === normalized(element),
          ),
      );
      const matches = leaves.filter(
        (element) =>
          /^(?:\(UTC\+0?9(?::00)?\)\s*)?Tokyo$|^Asia\/Tokyo$/i.test(
            normalized(element),
          ) && selected(element),
      );
      return matches.length === 1 ? normalized(matches[0]!) : null;
    });
    await this.page.keyboard.press("Escape");
    if (!selectedTokyo) {
      throw new Error(
        `TradingView capture rejected ${interval}: the opened timezone menu does not prove one selected Asia/Tokyo option.`,
      );
    }
    return {
      label: selectedTokyo,
      selector: "opened timezone menu selected Asia/Tokyo option",
    };
  }

  async #auditFullSessionMenu(
    interval: CaptureInterval,
  ): Promise<{ label: string; selector: string }> {
    const button = await this.#firstVisibleLocator(
      [
        'button[data-name="session-menu"]',
        'button[data-name*="session" i]',
        'button[aria-label*="session" i]',
      ].join(", "),
    );
    if (!button) {
      throw new Error(
        `TradingView capture rejected ${interval}: the chart session menu control is unavailable.`,
      );
    }
    await this.#safeClick(button, `open session menu ${interval}`);
    const menu = await this.#waitForVisibleLocator(
      [
        '[data-tradingview-mcp-session-menu]:has-text("Day session")',
        '[role="listbox"]:has-text("Day session")',
        '[role="menu"]:has-text("Day session")',
        'div[class*="menuWrap-"]:has-text("Day session")',
      ].join(", "),
    );
    if (!menu) {
      throw new Error(
        `TradingView capture rejected ${interval}: opening the session control did not expose separate day/night options.`,
      );
    }
    const session = await menu.evaluate((root) => {
      const visible = (element: Element): boolean => {
        const html = element as HTMLElement;
        const style = window.getComputedStyle(html);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0" &&
          (html.offsetWidth > 0 || html.offsetHeight > 0 || html.getClientRects().length > 0)
        );
      };
      const normalized = (element: Element): string =>
        ((element as HTMLElement).innerText || element.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
      const selected = (element: Element): boolean => {
        for (let current: Element | null = element; current && root.contains(current); current = current.parentElement) {
          if (
            current.getAttribute("aria-selected") === "true" ||
            current.getAttribute("aria-checked") === "true" ||
            current.getAttribute("data-selected") === "true" ||
            /(?:^|\s)(?:active|isActive|checked|selected)(?:-|_|\s|$)/.test(
              current.getAttribute("class") ?? "",
            )
          ) {
            return true;
          }
        }
        return false;
      };
      const leaves = Array.from(root.querySelectorAll("*")).filter(
        (element) =>
          visible(element) &&
          !Array.from(element.children).some(
            (child) => visible(child) && normalized(child) === normalized(element),
          ),
      );
      const day = leaves.find((element) =>
        /^Day session trading hours$/i.test(normalized(element)),
      );
      const night = leaves.find((element) =>
        /^Night session trading hours$/i.test(normalized(element)),
      );
      const combined = leaves.filter(
        (element) =>
          /^(?:Electronic trading hours|Full OSE day and night session|OSE full day and night session)$/i.test(
            normalized(element),
          ) && selected(element),
      );
      if (!day || !night || combined.length !== 1) return null;
      return {
        combined: normalized(combined[0]!),
        day: normalized(day),
        night: normalized(night),
      };
    });
    await this.page.keyboard.press("Escape");
    if (!session) {
      throw new Error(
        `TradingView capture rejected ${interval}: the opened session menu does not prove a selected combined OSE session alongside distinct day and night alternatives.`,
      );
    }
    return {
      label: `OSE full day-and-night proven by active ${session.combined}; separate options: ${session.day}; ${session.night}`,
      selector: "opened session menu active combined option plus distinct day/night alternatives",
    };
  }

  async #removeStructuredObjectTreeExtras(
    objectTreeRoot: Locator,
    interval: CaptureInterval,
  ): Promise<void> {
    const candidates = objectTreeRoot.locator(
      '[data-study-id], [data-pine-id], [data-script-id], [data-drawing-id], [data-shape-id], [data-object-id][data-type*="drawing" i], [data-symbol]',
    );
    let removedAny = false;
    for (let attempt = 0; attempt < 32; attempt += 1) {
      let candidate: Locator | undefined;
      for (let index = 0; index < (await candidates.count()); index += 1) {
        const item = candidates.nth(index);
        if (!(await item.isVisible().catch(() => false))) continue;
        const identity = await item.evaluate((element) => ({
          symbol: element.getAttribute("data-symbol"),
          study: Boolean(
            element.getAttribute("data-study-id") ||
              element.getAttribute("data-pine-id") ||
              element.getAttribute("data-script-id"),
          ),
          drawing: Boolean(
            element.getAttribute("data-drawing-id") ||
              element.getAttribute("data-shape-id") ||
              /drawing/i.test(element.getAttribute("data-type") ?? ""),
          ),
        }));
        if (identity.symbol === "OSE:NK2251!" && !identity.study && !identity.drawing) continue;
        candidate = item;
        break;
      }
      if (!candidate) {
        const objectRows = objectTreeRoot.locator(
          '[class^="listContainer-"] > div > div',
        );
        for (let index = 0; index < (await objectRows.count()); index += 1) {
          const item = objectRows.nth(index);
          if (!(await item.isVisible().catch(() => false))) continue;
          const text = (await item.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
          if (!text || /^NK2251!\s*[-/]\s*OSE(?:\s*,\s*\S+)?$/i.test(text)) continue;
          candidate = item;
          break;
        }
      }
      if (!candidate) break;
      removedAny = true;
      this.#cleanupAllowedUntil = Date.now() + 2_000;
      await this.#safeClick(candidate, `select isolated Object Tree item ${interval}`);
      await this.page.keyboard.press("Delete");
      await this.page.waitForTimeout(150);
    }
    if (!removedAny) {
      throw new Error(
        `TradingView capture rejected ${interval}: extra chart surfaces exist but Object Tree exposes no safely removable structured rows.`,
      );
    }
  }

  async #safeClick(locator: Locator, purpose: string): Promise<void> {
    const description = await locator.evaluate((element) =>
      [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.textContent,
      ]
        .filter((value): value is string => typeof value === "string")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    );
    if (FORBIDDEN_COMMERCE_PATTERN.test(description)) {
      this.#fatalGuardReason = `the ${purpose} target was a commerce/upgrade control`;
      throw new Error(
        `TradingView capture aborted: the ${purpose} target is an upgrade, trial, purchase, subscription, or payment surface. It was not clicked.`,
      );
    }
    await locator.click();
  }

  async #firstVisibleLocator(selector: string, root: Locator = this.page.locator("body")): Promise<Locator | undefined> {
    const candidates = root.locator(selector);
    for (let index = 0; index < (await candidates.count()); index += 1) {
      const candidate = candidates.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
    return undefined;
  }

  async #waitForVisibleLocator(selector: string): Promise<Locator | undefined> {
    const deadline = Date.now() + 5_000;
    do {
      const locator = await this.#firstVisibleLocator(selector);
      if (locator) return locator;
      await this.page.waitForTimeout(50);
    } while (Date.now() < deadline);
    return undefined;
  }
}

function normalizedTextEquals(actual: string, expected: string): boolean {
  return (
    actual.replace(/\s+/g, " ").trim().toLocaleLowerCase() ===
    expected.replace(/\s+/g, " ").trim().toLocaleLowerCase()
  );
}

function safeNetworkTarget(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`.slice(0, 240);
  } catch {
    return "an invalid URL";
  }
}

function isCommerceNetworkTarget(value: string, method: string): boolean {
  if (!FORBIDDEN_COMMERCE_REQUEST_PATTERN.test(value)) return false;
  try {
    const parsed = new URL(value);
    if (
      ["GET", "HEAD", "OPTIONS"].includes(method) &&
      /\.(?:avif|css|gif|ico|jpe?g|js|json|map|png|svg|webp|woff2?)(?:$|\/)/i.test(
        parsed.pathname,
      )
    ) {
      return false;
    }
  } catch {
    return true;
  }
  return true;
}

function classifyCaptureObservation(
  raw: TradingViewCaptureDomObservation,
  requested: TradingViewCaptureBatchInput,
  interval: CaptureInterval,
  expectedUrl: string,
): TradingViewCaptureObservedState {
  const pageUrl = requiredObservedText(raw.pageUrl, "final page URL");
  assertExactCaptureUrl(pageUrl, expectedUrl, interval);
  if (!raw.chartAuditComplete || raw.chartCount !== 1) {
    throw new Error(
      `TradingView capture rejected ${interval}: exactly one chart is required; observed ${raw.chartCount}.`,
    );
  }
  if (
    !raw.renderAuditComplete ||
    !raw.renderAuditSelector ||
    raw.loadingVisible ||
    raw.visibleCanvasCount < 1 ||
    raw.axisEvidenceCount < 2 ||
    !raw.ohlcEvidenceVisible
  ) {
    throw new Error(
      `TradingView capture rejected ${interval}: a stable rendered candle canvas with OHLC and price/time axes is not proven, or loading is still visible.`,
    );
  }
  if (!raw.settingsAuditComplete || !raw.settingsAuditSelector) {
    throw new Error(
      `TradingView capture rejected ${interval}: the chart settings dialog was not opened and fully audited locally.`,
    );
  }
  if (!raw.objectTreeAuditComplete || !raw.objectTreeAuditSelector) {
    throw new Error(
      `TradingView capture rejected ${interval}: Object Tree was not opened and fully audited locally.`,
    );
  }
  const chartAriaLabel = requiredObservedText(raw.chartAriaLabel, "chart aria-label");
  const observedSymbols =
    chartAriaLabel.toUpperCase().match(/[A-Z][A-Z0-9._+-]*:[A-Z0-9][A-Z0-9._!+-]*/g) ?? [];
  if (
    observedSymbols.length !== 1 ||
    !["OSE:NK2251!", "OSE_DLY:NK2251!"].includes(observedSymbols[0]!)
  ) {
    throw new Error(
      `TradingView capture rejected ${interval}: chart aria-label does not prove exact OSE:NK2251! identity.`,
    );
  }
  const symbolLinkHref = raw.symbolLinkHref?.replace(/\s+/g, " ").trim();
  if (symbolLinkHref) {
    let symbolLink: URL;
    try {
      symbolLink = new URL(symbolLinkHref);
    } catch {
      throw new Error(
        `TradingView capture rejected ${interval}: the visible symbol link is invalid.`,
      );
    }
    if (
      symbolLink.protocol !== "https:" ||
      (symbolLink.hostname !== "tradingview.com" &&
        !symbolLink.hostname.endsWith(".tradingview.com")) ||
      symbolLink.pathname !== "/symbols/OSE-NK2251!/" ||
      symbolLink.search !== "" ||
      symbolLink.hash !== ""
    ) {
      throw new Error(
        `TradingView capture rejected ${interval}: the visible symbol link does not prove exact OSE:NK2251!.`,
      );
    }
  }

  const intervalLabel = requiredObservedText(raw.intervalLabel, "selected interval label");
  const observedInterval = captureIntervalFromLabel(intervalLabel);
  if (observedInterval !== interval) {
    throw new Error(
      `TradingView capture rejected ${interval}: selected UI interval is ${observedInterval ?? "unknown"}.`,
    );
  }

  const chartTypeLabel = requiredObservedText(raw.chartTypeLabel, "chart type label");
  if (
    /heikin|hollow|line|area|renko|kagi|point.{0,4}figure/i.test(
      chartTypeLabel,
    ) ||
    !/(?:^|[^A-Za-z])(?:candlesticks?|candles?)(?:$|[^A-Za-z])/i.test(chartTypeLabel)
  ) {
    throw new Error(
      `TradingView capture rejected ${interval}: chart type is not proven to be standard candlesticks.`,
    );
  }
  if (!raw.authenticatedControlVisible || !raw.authenticatedSelector) {
    throw new Error(
      `TradingView capture rejected ${interval}: authenticated UI state is not proven by the DOM.`,
    );
  }
  if (raw.delayedLabelVisible) {
    throw new Error(`TradingView capture rejected ${interval}: a delayed-data label is visible.`);
  }
  const realtimeLabel = requiredObservedText(raw.realtimeLabel, "real-time market-data label");
  if (
    !raw.realtimeSelector ||
    raw.realtimeActive !== true ||
    !/(?:^|[^A-Za-z])(?:real[ -]?time|realtime)(?:$|[^A-Za-z])/i.test(
      realtimeLabel,
    )
  ) {
    throw new Error(
      `TradingView capture rejected ${interval}: explicit active real-time market-data evidence is required.`,
    );
  }

  const timezoneLabel = requiredObservedText(raw.timezoneLabel, "timezone label");
  if (!/(?:^|[^A-Za-z])(?:Asia\/Tokyo|Tokyo)(?:$|[^A-Za-z])/i.test(timezoneLabel)) {
    throw new Error(
      `TradingView capture rejected ${interval}: Asia/Tokyo is not proven by the timezone UI.`,
    );
  }
  const sessionLabel = requiredObservedText(raw.sessionLabel, "session label");
  if (
    !(
      /OSE.{0,40}day.{0,20}night|OSE\s+full\s+day\s+and\s+night\s+session/i.test(
        sessionLabel,
      ) ||
      /OSE full day-and-night proven by active (?:Electronic trading hours|Full OSE day and night session|OSE full day and night session);\s*separate options:\s*Day session trading hours;\s*Night session trading hours/i.test(
        sessionLabel,
      )
    )
  ) {
    throw new Error(
      `TradingView capture rejected ${interval}: OSE full day-and-night session is not proven by the UI.`,
    );
  }
  assertExplicitlyOff(raw.backAdjustment, "back adjustment", interval);
  assertExplicitlyOff(raw.settlementAsClose, "settlement-as-close", interval);
  if (!raw.studyAuditComplete || !raw.studyAuditSelector) {
    throw new Error(
      `TradingView capture rejected ${interval}: overlay inventory is unknown because no visible legend audit root was found.`,
    );
  }
  if (!raw.comparisonAuditComplete || !raw.comparisonAuditSelector) {
    throw new Error(
      `TradingView capture rejected ${interval}: comparison-series inventory is incomplete.`,
    );
  }
  if (!raw.drawingAuditComplete || !raw.drawingAuditSelector) {
    throw new Error(
      `TradingView capture rejected ${interval}: drawing inventory is incomplete.`,
    );
  }
  if (
    raw.comparisons.length !== 0 ||
    raw.drawings.length !== 0 ||
    raw.collapsedStudyCount !== 0 ||
    raw.unclassifiedSurfaceCount !== 0
  ) {
    throw new Error(
      `TradingView capture rejected ${interval}: comparison, drawing, collapsed-study, or unclassified chart surfaces are present.`,
    );
  }

  const evidence = [
    captureEvidence("window.location.href", pageUrl, "final chart URL"),
    captureEvidence(raw.chartSelector, "exactly one chart region", "single chart inventory"),
    captureEvidence(raw.chartSelector, chartAriaLabel, "chart identity"),
    captureEvidence(
      raw.renderAuditSelector,
      `${raw.visibleCanvasCount} visible canvas layers; OHLC visible; ${raw.axisEvidenceCount} axis proofs; loading absent`,
      "rendered candle proof",
    ),
    captureEvidence(
      raw.settingsAuditSelector,
      "chart settings opened and audited locally",
      "settings audit",
    ),
    captureEvidence(
      raw.objectTreeAuditSelector,
      "Object Tree opened and inventoried locally",
      "Object Tree audit",
    ),
    captureEvidence(raw.intervalSelector, intervalLabel, "selected interval"),
    captureEvidence(raw.chartTypeSelector, chartTypeLabel, "chart type"),
    captureEvidence(raw.authenticatedSelector, "authenticated account control visible", "authentication"),
    captureEvidence("visible body text audit", "no delayed-data label matched", "delay status"),
    captureEvidence(raw.realtimeSelector, `${realtimeLabel} = active`, "real-time status"),
    captureEvidence(raw.timezoneSelector, timezoneLabel, "timezone"),
    captureEvidence(raw.sessionSelector, sessionLabel, "trading session"),
    captureEvidence(
      raw.backAdjustment?.selector ?? null,
      `${requiredObservedText(raw.backAdjustment?.label ?? null, "back-adjustment label")} = off`,
      "back adjustment",
    ),
    captureEvidence(
      raw.settlementAsClose?.selector ?? null,
      `${requiredObservedText(raw.settlementAsClose?.label ?? null, "settlement label")} = off`,
      "settlement-as-close",
    ),
    captureEvidence(
      raw.comparisonAuditSelector,
      "zero comparison series; complete legend inventory",
      "comparison inventory",
    ),
    captureEvidence(
      raw.drawingAuditSelector,
      "zero drawings; complete pane inventory",
      "drawing inventory",
    ),
  ];

  let indicator: TradingViewCaptureObservedState["indicator"];
  if (requested.expectedOverlayMode === "candles_only") {
    if (raw.studies.length !== 0) {
      throw new Error(
        `TradingView capture rejected ${interval}: candles_only was requested but study overlays are present.`,
      );
    }
    evidence.push(
      captureEvidence(raw.studyAuditSelector, "no study overlay item present", "overlay mode"),
    );
  } else {
    const expectedIndicator = requested.expectedIndicator;
    if (!expectedIndicator) {
      throw new Error(`TradingView capture rejected ${interval}: expected indicator is missing.`);
    }
    if (raw.studies.some((study) => study.source === "unknown")) {
      throw new Error(
        `TradingView capture rejected ${interval}: at least one study source is unknown.`,
      );
    }
    const expectedSource =
      requested.expectedOverlayMode === "builtin_ichimoku_only" ? "builtin" : "pine";
    const matches = raw.studies.filter(
      (study) =>
        study.source === expectedSource &&
        study.identity === expectedIndicator.identity &&
        study.name === expectedIndicator.name,
    );
    if (raw.studies.length !== 1 || matches.length !== 1) {
      throw new Error(
        `TradingView capture rejected ${interval}: the exact ${requested.expectedOverlayMode} indicator identity/name is not the only proven overlay.`,
      );
    }
    indicator = {
      identity: expectedIndicator.identity,
      name: expectedIndicator.name,
      source: expectedSource,
    };
    evidence.push(
      captureEvidence(
        matches[0]!.selector,
        `${expectedSource}:${expectedIndicator.identity}:${expectedIndicator.name}`,
        "overlay mode",
      ),
    );
  }

  return {
    pageUrl: sanitizeEvidence(pageUrl),
    symbol: "OSE:NK2251!",
    exchange: "OSE",
    interval,
    intervalLabel: sanitizeEvidence(intervalLabel),
    chartAriaLabel: sanitizeEvidence(chartAriaLabel),
    chartType: "candles",
    chartTypeLabel: sanitizeEvidence(chartTypeLabel),
    authenticated: true,
    delayed: false,
    realtime: true,
    timezone: "Asia/Tokyo",
    session: "ose_full_day_and_night",
    backAdjustment: false,
    settlementAsClose: false,
    overlayMode: requested.expectedOverlayMode,
    chartCount: 1,
    studyCount: raw.studies.length,
    collapsedStudyCount: 0,
    comparisonCount: 0,
    drawingCount: 0,
    ...(indicator ? { indicator } : {}),
    evidence,
  };
}

function captureIntervalFromLabel(label: string): CaptureInterval | undefined {
  const normalized = label.trim().replace(/\s+/g, " ");
  const candidates: Array<[CaptureInterval, RegExp]> = [
    ["240", /(?:^|\b)(?:4\s*(?:hours?|hrs?|h)|240\s*(?:minutes?|mins?|min|m))(?:\b|$)/i],
    ["60", /(?:^|\b)(?:1\s*(?:hours?|hrs?|h)|60\s*(?:minutes?|mins?|min|m))(?:\b|$)/i],
    ["5", /(?:^|\b)5\s*(?:minutes?|mins?|min|m)(?:\b|$)/i],
    ["D", /(?:^|\b)(?:1\s*day|daily|D)(?:\b|$)/i],
    ["W", /(?:^|\b)(?:1\s*week|weekly|W)(?:\b|$)/i],
    ["M", /(?:^|\b)(?:1\s*month|monthly|M)(?:\b|$)/i],
  ];
  return candidates.find(([, pattern]) => pattern.test(normalized))?.[0];
}

function assertExactCaptureUrl(actualValue: string, expectedValue: string, interval: CaptureInterval): void {
  let actual: URL;
  let expected: URL;
  try {
    actual = new URL(actualValue);
    expected = new URL(expectedValue);
  } catch {
    throw new Error(`TradingView capture rejected ${interval}: final chart URL is invalid.`);
  }
  const safeTradingViewHost = (hostname: string): boolean =>
    hostname === "tradingview.com" || hostname.endsWith(".tradingview.com");
  const exactQuery = (url: URL): boolean => {
    const entries = [...url.searchParams.entries()];
    return (
      entries.length === 2 &&
      entries.filter(([key]) => key === "symbol").length === 1 &&
      entries.filter(([key]) => key === "interval").length === 1 &&
      url.searchParams.get("symbol") === "OSE:NK2251!" &&
      url.searchParams.get("interval") === interval
    );
  };
  if (
    actual.protocol !== "https:" ||
    !safeTradingViewHost(actual.hostname) ||
    actual.username !== "" ||
    actual.password !== "" ||
    actual.port !== "" ||
    actual.origin !== expected.origin ||
    actual.pathname !== expected.pathname ||
    actual.hash !== "" ||
    !exactQuery(actual)
  ) {
    throw new Error(
      `TradingView capture rejected ${interval}: final URL does not exactly match the requested HTTPS TradingView origin/layout/symbol/interval.`,
    );
  }
}

function assertExplicitlyOff(
  control: TradingViewCaptureControlObservation | null,
  name: string,
  interval: CaptureInterval,
): void {
  if (!control?.selector || !control.label || control.active === null) {
    throw new Error(
      `TradingView capture rejected ${interval}: ${name} state is unknown in the DOM.`,
    );
  }
  if (control.active) {
    throw new Error(`TradingView capture rejected ${interval}: ${name} is enabled.`);
  }
}

function requiredObservedText(value: string | null, name: string): string {
  const cleaned = value?.replace(/\s+/g, " ").trim();
  if (!cleaned) throw new Error(`TradingView capture cannot prove ${name} from the DOM.`);
  return cleaned;
}

function captureEvidence(
  selector: string | null,
  value: string,
  name: string,
): { selector: string; value: string } {
  if (!selector) throw new Error(`TradingView capture cannot prove ${name}: selector is absent.`);
  return { selector: sanitizeEvidence(selector), value: sanitizeEvidence(value) };
}

function sanitizeEvidence(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (
    /\bbearer\s+\S+/i.test(cleaned) ||
    /\b(?:cookie|sessionid|authorization|password|token|api[_-]?key)\b\s*[:=]\s*\S+/i.test(
      cleaned,
    )
  ) {
    return "[redacted credential-like value]";
  }
  return cleaned.slice(0, 240) || "[empty]";
}

function assertCaptureStateStable(
  before: TradingViewCaptureObservedState,
  after: TradingViewCaptureObservedState,
  interval: CaptureInterval,
  stage: string,
): void {
  if (canonicalJson(before) !== canonicalJson(after)) {
    throw new Error(`TradingView capture rejected ${interval}: DOM state changed ${stage}.`);
  }
}

function logicalCaptureState(state: TradingViewCaptureObservedState): unknown {
  const { evidence, ...logical } = state;
  return {
    ...logical,
    evidence: evidence
      .map((item) => ({ selector: item.selector, value: item.value }))
      .sort((left, right) =>
        Buffer.compare(
          Buffer.from(canonicalJson(left), "utf8"),
          Buffer.from(canonicalJson(right), "utf8"),
        ),
      ),
  };
}

function captureChartUrl(baseUrl: string, layoutId: string, interval: CaptureInterval): string {
  const base = new URL(baseUrl);
  if (
    base.protocol !== "https:" ||
    (base.hostname !== "tradingview.com" && !base.hostname.endsWith(".tradingview.com")) ||
    base.username !== "" ||
    base.password !== "" ||
    base.port !== "" ||
    (base.pathname !== "" && base.pathname !== "/") ||
    base.search !== "" ||
    base.hash !== ""
  ) {
    throw new Error("TradingView capture base URL must be an exact credential-free HTTPS TradingView origin.");
  }
  const target = new URL(`/chart/${validateLayoutId(layoutId)}/`, `${base.origin}/`);
  target.searchParams.set("symbol", "OSE:NK2251!");
  target.searchParams.set("interval", interval);
  return target.toString();
}

function captureBatchId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  return `${timestamp}-${randomUUID()}`;
}

async function prepareCaptureRoot(dataRoot: string): Promise<CaptureArchiveRoot> {
  const configuredRoot = path.resolve(dataRoot);
  await mkdir(configuredRoot, { recursive: true });
  const realRoot = await realpath(configuredRoot);
  const rootHandle = await open(
    realRoot,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const anchoredRoot = `/proc/self/fd/${rootHandle.fd}`;
    const configuredCaptureRoot = path.join(anchoredRoot, "tradingview-captures");
    await mkdir(configuredCaptureRoot, { recursive: false, mode: 0o700 }).catch(
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      },
    );
    const captureHandle = await open(
      configuredCaptureRoot,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    ).catch((error: unknown) => {
      if (["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        throw new Error("TradingView capture directory resolved outside MARKET_CHART_DATA_ROOT.");
      }
      throw error;
    });
    const fdPath = `/proc/self/fd/${captureHandle.fd}`;
    try {
      const realCaptureRoot = await realpath(fdPath);
      if (!pathIsInside(realRoot, realCaptureRoot)) {
        throw new Error("TradingView capture directory resolved outside MARKET_CHART_DATA_ROOT.");
      }
      const details = await captureHandle.stat();
      if (!details.isDirectory()) {
        throw new Error("TradingView capture root must be a real directory.");
      }
      return { path: realCaptureRoot, handle: captureHandle, fdPath };
    } catch (error) {
      await captureHandle.close();
      throw error;
    }
  } finally {
    await rootHandle.close();
  }
}

async function archiveCapturePng(
  directory: CaptureArchiveDirectory,
  fileName: string,
  png: Buffer,
  expectedWidth: number,
  expectedHeight: number,
): Promise<{ sha256: string; bytes: number }> {
  validatePng(png, expectedWidth, expectedHeight);
  await atomicWriteNewFile(directory, fileName, png);
  const archived = await safeReadRegularFile(directory.fdPath, fileName, MAX_CAPTURE_BYTES);
  validatePng(archived, expectedWidth, expectedHeight);
  if (!archived.equals(png)) {
    throw new Error("Archived TradingView PNG differs from the raw browser capture.");
  }
  return { sha256: sha256(archived), bytes: archived.byteLength };
}

async function atomicWriteNewFile(
  directory: CaptureArchiveDirectory,
  fileName: string,
  contents: Buffer,
): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(fileName)) {
    throw new Error("Capture archive filename is unsafe.");
  }
  const target = path.join(directory.fdPath, fileName);
  const temporaryName = `.${randomUUID()}.tmp`;
  const temporary = path.join(directory.fdPath, temporaryName);
  let output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    output = await open(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    await output.writeFile(contents);
    await output.sync();
    const details = await output.stat();
    if (!details.isFile() || details.nlink !== 1) {
      throw new Error("Capture archive temporary output is not a unique regular file.");
    }
    await output.close();
    output = undefined;
    await rename(temporary, target);
    await directory.handle.sync();
  } finally {
    await output?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function createArchiveDirectory(
  root: CaptureArchiveRoot,
  name: string,
): Promise<CaptureArchiveDirectory> {
  if (!/^\.[A-Za-z0-9._-]{8,110}\.tmp$/.test(name)) {
    throw new Error("Capture archive temporary directory name is unsafe.");
  }
  const target = path.join(root.fdPath, name);
  await mkdir(target, { recursive: false, mode: 0o700 });
  const handle = await open(
    target,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  return { name, handle, fdPath: `/proc/self/fd/${handle.fd}` };
}

async function assertDirectoryBinding(
  root: CaptureArchiveRoot,
  directory: CaptureArchiveDirectory,
): Promise<void> {
  const [bound, entry] = await Promise.all([
    directory.handle.stat(),
    lstat(path.join(root.fdPath, directory.name)),
  ]);
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    bound.dev !== entry.dev ||
    bound.ino !== entry.ino
  ) {
    throw new Error("Capture archive directory binding changed before publication.");
  }
}

async function safeReadRegularFile(
  directoryFdPath: string,
  fileName: string,
  maximumBytes: number,
): Promise<Buffer> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(fileName)) {
    throw new Error("Capture archive filename is unsafe.");
  }
  const handle = await open(
    path.join(directoryFdPath, fileName),
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.nlink !== 1 || details.size <= 0 || details.size > maximumBytes) {
      throw new Error("Capture archive input must be a bounded unique regular file.");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function acquireCapturePublicationLock(
  root: CaptureArchiveRoot,
  timeoutMs: number,
): Promise<() => Promise<void>> {
  const lockPath = path.join(root.fdPath, ".capture.lock");
  const started = Date.now();
  let handle: Awaited<ReturnType<typeof open>>;
  for (;;) {
    try {
      handle = await open(
        lockPath,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() - started >= timeoutMs) {
        throw new Error("Timed out waiting for the cross-process TradingView capture lock.");
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
  await handle.writeFile(`${process.pid}:${randomUUID()}\n`, "utf8");
  await handle.sync();
  await root.handle.sync();
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    const [held, entry] = await Promise.all([handle.stat(), lstat(lockPath)]);
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      entry.nlink !== 1 ||
      entry.dev !== held.dev ||
      entry.ino !== held.ino
    ) {
      await handle.close();
      throw new Error("TradingView capture lock binding changed while held.");
    }
    await handle.close();
    await unlink(lockPath);
    await root.handle.sync();
  };
}

async function readCurrentRaw(root: CaptureArchiveRoot): Promise<Buffer | undefined> {
  try {
    return await safeReadRegularFile(root.fdPath, "CURRENT", 8 * 1024);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readCurrentRawRequired(root: CaptureArchiveRoot): Promise<Buffer> {
  const current = await readCurrentRaw(root);
  if (!current) throw new Error("TradingView capture CURRENT pointer is missing.");
  return current;
}

function parseCurrentPointer(raw: Buffer): CaptureCurrentPointer {
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("TradingView capture CURRENT pointer is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("TradingView capture CURRENT pointer has an invalid shape.");
  }
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).sort().join(",") !== "batchId,manifestIdentity,schemaVersion" ||
    object.schemaVersion !== CAPTURE_CURRENT_SCHEMA ||
    typeof object.batchId !== "string" ||
    !/^[A-Za-z0-9._-]{8,100}$/.test(object.batchId) ||
    typeof object.manifestIdentity !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(object.manifestIdentity)
  ) {
    throw new Error("TradingView capture CURRENT pointer failed strict validation.");
  }
  return object as unknown as CaptureCurrentPointer;
}

async function validateCurrentPointer(
  root: CaptureArchiveRoot,
  raw: Buffer,
): Promise<TradingViewCaptureBatchManifest> {
  const pointer = parseCurrentPointer(raw);
  const directoryHandle = await open(
    path.join(root.fdPath, pointer.batchId),
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  const directoryFdPath = `/proc/self/fd/${directoryHandle.fd}`;
  try {
    const manifestRaw = await safeReadRegularFile(directoryFdPath, "manifest.json", 2 * 1024 * 1024);
    let decoded: unknown;
    try {
      decoded = JSON.parse(manifestRaw.toString("utf8"));
    } catch {
      throw new Error("TradingView capture manifest is not valid JSON.");
    }
    const manifest = TradingViewCaptureBatchManifestSchema.parse(decoded);
    if (
      manifest.batchId !== pointer.batchId ||
      manifest.manifestIdentity !== pointer.manifestIdentity ||
      computeTradingViewCaptureManifestIdentity(manifest) !== pointer.manifestIdentity
    ) {
      throw new Error("TradingView capture CURRENT pointer/manifest identity mismatch.");
    }
    for (const panel of manifest.panels) {
      const fileName = path.posix.basename(panel.png.path);
      const png = await safeReadRegularFile(directoryFdPath, fileName, MAX_CAPTURE_BYTES);
      validatePng(png, panel.png.width, panel.png.height);
      if (png.byteLength !== panel.png.bytes || sha256(png) !== panel.png.sha256) {
        throw new Error("TradingView capture PNG failed manifest hash/size validation.");
      }
    }
    return manifest;
  } finally {
    await directoryHandle.close();
  }
}

async function assertCurrentUnchanged(
  root: CaptureArchiveRoot,
  expected: Buffer | undefined,
): Promise<void> {
  const observed = await readCurrentRaw(root);
  if (
    (expected === undefined) !== (observed === undefined) ||
    (expected !== undefined && observed !== undefined && !expected.equals(observed))
  ) {
    throw new Error("TradingView capture CURRENT changed during publication; CAS rejected.");
  }
}

async function atomicReplaceFile(
  root: CaptureArchiveRoot,
  fileName: string,
  contents: Buffer,
  afterRename?: (() => Promise<void>) | undefined,
): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(fileName)) {
    throw new Error("Capture archive filename is unsafe.");
  }
  const temporary = path.join(root.fdPath, `.${fileName}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(contents);
    await handle.sync();
    const details = await handle.stat();
    if (!details.isFile() || details.nlink !== 1) {
      throw new Error("Capture pointer temporary output is not a unique regular file.");
    }
    await handle.close();
    handle = undefined;
    await rename(temporary, path.join(root.fdPath, fileName));
    await afterRename?.();
    await root.handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function restoreCurrent(root: CaptureArchiveRoot, baseline: Buffer | undefined): Promise<void> {
  if (baseline) {
    await atomicReplaceFile(root, "CURRENT", baseline);
    return;
  }
  await unlink(path.join(root.fdPath, "CURRENT")).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
  await root.handle.sync();
}

export function computeTradingViewCaptureManifestIdentity(value: unknown): string {
  const manifest = value as TradingViewCaptureBatchManifest & {
    manifestIdentity?: string;
  };
  const {
    manifestIdentity: _excludedSelfIdentity,
    panels,
    ...batchAuthority
  } = manifest;
  const logicalManifest = {
    ...batchAuthority,
    panels: panels.map((panel) => {
      const { observedBefore, observedAfter, ...panelAuthority } = panel;
      return {
        ...panelAuthority,
        observedBefore: logicalCaptureState(observedBefore),
        observedAfter: logicalCaptureState(observedAfter),
      };
    }),
  };
  return `sha256:${sha256(Buffer.from(canonicalJson(logicalManifest)))}`;
}

export async function loadCurrentTradingViewCaptureManifest(
  dataRoot: string,
): Promise<TradingViewCaptureBatchManifest> {
  const root = await prepareCaptureRoot(dataRoot);
  try {
    return await validateCurrentPointer(root, await readCurrentRawRequired(root));
  } finally {
    await root.handle.close();
  }
}

function validatePng(png: Buffer, expectedWidth: number, expectedHeight: number): void {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (
    png.byteLength < 57 ||
    png.byteLength > MAX_CAPTURE_BYTES ||
    !png.subarray(0, signature.byteLength).equals(signature)
  ) {
    throw new Error("TradingView capture is not a bounded PNG file.");
  }

  let offset = signature.byteLength;
  let width: number | undefined;
  let height: number | undefined;
  let bitDepth: number | undefined;
  let colorType: number | undefined;
  const idatParts: Buffer[] = [];
  let sawIend = false;
  let idatEnded = false;
  let chunkIndex = 0;
  while (offset < png.byteLength) {
    if (offset + 12 > png.byteLength) throw new Error("TradingView PNG has a truncated chunk.");
    const length = png.readUInt32BE(offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (chunkEnd > png.byteLength) throw new Error("TradingView PNG chunk exceeds file bounds.");
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error("TradingView PNG has an invalid chunk type.");
    const expectedCrc = png.readUInt32BE(dataEnd);
    const actualCrc = crc32(png.subarray(offset + 4, dataEnd));
    if (expectedCrc !== actualCrc) throw new Error(`TradingView PNG ${type} CRC is invalid.`);
    if (chunkIndex === 0) {
      if (type !== "IHDR" || length !== 13) throw new Error("TradingView PNG lacks a valid IHDR.");
      width = png.readUInt32BE(dataStart);
      height = png.readUInt32BE(dataStart + 4);
      bitDepth = png[dataStart + 8];
      colorType = png[dataStart + 9];
      if (
        width === 0 ||
        height === 0 ||
        bitDepth !== 8 ||
        (colorType !== 2 && colorType !== 6) ||
        png[dataStart + 10] !== 0 ||
        png[dataStart + 11] !== 0 ||
        png[dataStart + 12] !== 0
      ) {
        throw new Error("TradingView PNG IHDR uses an unsupported or invalid encoding.");
      }
    } else if (type === "IHDR") {
      throw new Error("TradingView PNG contains multiple IHDR chunks.");
    }
    if (type === "IDAT") {
      if (idatEnded) throw new Error("TradingView PNG has non-consecutive IDAT chunks.");
      idatParts.push(png.subarray(dataStart, dataEnd));
    } else if (idatParts.length > 0 && type !== "IEND") {
      idatEnded = true;
    }
    if (/^[A-Z]/.test(type) && !["IHDR", "PLTE", "IDAT", "IEND"].includes(type)) {
      throw new Error(`TradingView PNG contains unsupported critical chunk ${type}.`);
    }
    if (type === "IEND") {
      if (length !== 0 || chunkEnd !== png.byteLength) {
        throw new Error("TradingView PNG has an invalid IEND chunk.");
      }
      sawIend = true;
    }
    offset = chunkEnd;
    chunkIndex += 1;
  }
  if (idatParts.length === 0 || !sawIend) {
    throw new Error("TradingView PNG is missing IDAT or IEND data.");
  }
  if (width !== expectedWidth || height !== expectedHeight) {
    throw new Error(
      `TradingView PNG dimensions ${width ?? "unknown"}x${height ?? "unknown"} do not match ${expectedWidth}x${expectedHeight}.`,
    );
  }
  const channels = colorType === 6 ? 4 : 3;
  const rowBytes = expectedWidth * channels;
  const expectedInflatedBytes = (rowBytes + 1) * expectedHeight;
  let scanlines: Buffer;
  try {
    scanlines = inflateSync(Buffer.concat(idatParts), {
      maxOutputLength: expectedInflatedBytes + 1,
    });
  } catch {
    throw new Error("TradingView PNG IDAT stream cannot be decoded safely.");
  }
  if (scanlines.byteLength !== expectedInflatedBytes) {
    throw new Error(
      `TradingView PNG decoded scanline size ${scanlines.byteLength} does not match ${expectedInflatedBytes}.`,
    );
  }
  const decoded = Buffer.alloc(rowBytes * expectedHeight);
  for (let row = 0; row < expectedHeight; row += 1) {
    const sourceRow = row * (rowBytes + 1);
    const targetRow = row * rowBytes;
    const filter = scanlines[sourceRow];
    if (filter === undefined || filter > 4) {
      throw new Error(`TradingView PNG row ${row} has an invalid filter byte.`);
    }
    for (let column = 0; column < rowBytes; column += 1) {
      const encoded = scanlines[sourceRow + 1 + column]!;
      const left = column >= channels ? decoded[targetRow + column - channels]! : 0;
      const above = row > 0 ? decoded[targetRow - rowBytes + column]! : 0;
      const upperLeft =
        row > 0 && column >= channels
          ? decoded[targetRow - rowBytes + column - channels]!
          : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      if (filter === 2) predictor = above;
      if (filter === 3) predictor = Math.floor((left + above) / 2);
      if (filter === 4) predictor = paethPredictor(left, above, upperLeft);
      decoded[targetRow + column] = (encoded + predictor) & 0xff;
    }
  }

  const colors = new Set<number>();
  let opaqueSamples = 0;
  let minimumLuma = 255;
  let maximumLuma = 0;
  const xStep = Math.max(1, Math.floor(expectedWidth / 80));
  const yStep = Math.max(1, Math.floor(expectedHeight / 45));
  for (let y = 0; y < expectedHeight; y += yStep) {
    for (let x = 0; x < expectedWidth; x += xStep) {
      const pixel = y * rowBytes + x * channels;
      const alpha = channels === 4 ? decoded[pixel + 3]! : 255;
      if (alpha < 32) continue;
      opaqueSamples += 1;
      const red = decoded[pixel]!;
      const green = decoded[pixel + 1]!;
      const blue = decoded[pixel + 2]!;
      colors.add(((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4));
      const luma = Math.round((299 * red + 587 * green + 114 * blue) / 1_000);
      minimumLuma = Math.min(minimumLuma, luma);
      maximumLuma = Math.max(maximumLuma, luma);
    }
  }
  if (opaqueSamples < 32 || colors.size < 4 || maximumLuma - minimumLuma < 12) {
    throw new Error(
      "TradingView PNG is visually blank or uniform and does not prove a rendered chart.",
    );
  }
}

function paethPredictor(left: number, above: number, upperLeft: number): number {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

export async function loadTradingViewStorageState(
  file: string,
  allowedCookieNames: readonly string[] = DEFAULT_TRADINGVIEW_AUTH_COOKIE_NAMES,
  allowedStorageKeys: readonly string[] = [],
): Promise<TradingViewStorageState> {
  const state = filterTradingViewStorageState(
    parseStorageState(await readPrivateAuthenticationFile(file)),
    allowedCookieNames,
    allowedStorageKeys,
  );
  assertAuthenticationCookiesPresent(state.cookies, allowedCookieNames);
  return state;
}

export function filterTradingViewStorageState(
  state: TradingViewStorageState,
  allowedCookieNames: readonly string[] = DEFAULT_TRADINGVIEW_AUTH_COOKIE_NAMES,
  allowedStorageKeys: readonly string[] = [],
): TradingViewStorageState {
  const cookieNames = new Set(allowedCookieNames.map((name) => name.toLowerCase()));
  const storageKeys = new Set(allowedStorageKeys.map((name) => name.toLowerCase()));
  return {
    cookies: state.cookies.filter(
      (cookie) =>
        allowedCookieDomain(cookie.domain) &&
        cookieNames.has(cookie.name.toLowerCase()) &&
        cookie.value.length > 0 &&
        Buffer.byteLength(cookie.value, "utf8") <= MAX_COOKIE_VALUE_BYTES &&
        !(cookie.expires > 0 && cookie.expires <= Date.now() / 1_000),
    ),
    origins: storageKeys.size === 0
      ? []
      : state.origins
          .filter((origin) => allowedStorageOrigin(origin.origin))
          .map((origin) => ({
            origin: origin.origin,
            localStorage: origin.localStorage.filter(
              (item) =>
                storageKeys.has(item.name.toLowerCase()) &&
                Buffer.byteLength(item.value, "utf8") <= MAX_STORAGE_VALUE_BYTES,
            ),
          }))
          .filter((origin) => origin.localStorage.length > 0),
  };
}

export function cloneTradingViewStorageState(
  state: TradingViewStorageState,
): TradingViewStorageState {
  return {
    cookies: state.cookies.map((cookie) => ({ ...cookie })),
    origins: state.origins.map((origin) => ({
      origin: origin.origin,
      localStorage: origin.localStorage.map((item) => ({ ...item })),
    })),
  };
}

export async function createIsolatedTradingViewCaptureContext(
  browser: Browser,
  storageState: TradingViewStorageState | undefined,
  viewport: { width: number; height: number } = {
    width: CAPTURE_WIDTH,
    height: CAPTURE_HEIGHT,
  },
): Promise<BrowserContext> {
  return browser.newContext({
    viewport,
    locale: "en-US",
    acceptDownloads: false,
    serviceWorkers: "block",
    ...(storageState
      ? { storageState: cloneTradingViewStorageState(storageState) }
      : {}),
  });
}

export async function loadTradingViewCookies(
  file: string,
  allowedCookieNames: readonly string[] = DEFAULT_TRADINGVIEW_AUTH_COOKIE_NAMES,
): Promise<Cookie[]> {
  const source = await readPrivateAuthenticationFile(file);
  const trimmed = source.trim();
  if (trimmed.startsWith("{")) {
    const cookies = filterTradingViewStorageState(
      parseStorageState(source),
      allowedCookieNames,
      [],
    ).cookies;
    assertAuthenticationCookiesPresent(cookies, allowedCookieNames);
    return cookies;
  }

  const cookieNames = new Set(allowedCookieNames.map((name) => name.toLowerCase()));
  const cookies: Cookie[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    const fields = line.split("\t");
    if (fields.length < 5) continue;
    const [name, value, domain, cookiePath, expiresText] = fields;
    if (
      !name ||
      value === undefined ||
      !domain ||
      !allowedCookieDomain(domain) ||
      !cookieNames.has(name.toLowerCase()) ||
      value.length === 0 ||
      Buffer.byteLength(value, "utf8") > MAX_COOKIE_VALUE_BYTES
    ) continue;
    const expiresMs = Date.parse(expiresText ?? "");
    const sameSite = ["Strict", "Lax", "None"].includes(fields[8] ?? "")
      ? (fields[8] as Cookie["sameSite"])
      : "Lax";
    cookies.push({
      name,
      value,
      domain,
      path: cookiePath || "/",
      expires: Number.isFinite(expiresMs) ? Math.trunc(expiresMs / 1_000) : -1,
      httpOnly: fields[6]?.toLowerCase() === "true",
      secure: true,
      sameSite,
    });
  }
  assertAuthenticationCookiesPresent(cookies, allowedCookieNames);
  return cookies;
}

async function loadCookieFile(
  file: string,
  allowedCookieNames: readonly string[],
): Promise<Cookie[]> {
  return loadTradingViewCookies(file, allowedCookieNames);
}

async function readPrivateAuthenticationFile(file: string): Promise<string> {
  try {
    const target = await realpath(file);
    const info = await stat(target);
    if (!info.isFile() || info.size === 0 || info.size > MAX_AUTH_FILE_BYTES) {
      throw new Error("unsafe authentication file shape");
    }
    if (process.platform !== "win32") {
      const currentUserId = process.getuid?.();
      if ((info.mode & 0o077) !== 0 || (currentUserId !== undefined && info.uid !== currentUserId)) {
        throw new Error("unsafe authentication file ownership or permissions");
      }
    }
    return await readFile(target, "utf8");
  } catch {
    throw new Error(
      "TradingView authentication could not be loaded safely. Use a non-empty file smaller than 1 MiB with owner-only permissions.",
    );
  }
}

function assertAuthenticationCookiesPresent(
  cookies: readonly Cookie[],
  allowedCookieNames: readonly string[],
): void {
  if (cookies.length > 0) return;
  throw new Error(
    `Authentication input contains no current TradingView cookies allowed by TRADINGVIEW_BROWSER_AUTH_COOKIE_NAMES (${allowedCookieNames.join(",")}).`,
  );
}

function parseStorageState(source: string): TradingViewStorageState {
  const parsed = JSON.parse(source) as { cookies?: unknown; origins?: unknown };
  if (!Array.isArray(parsed.cookies)) {
    throw new Error("Storage-state JSON must contain a cookies array.");
  }
  return {
    cookies: parsed.cookies.flatMap((cookie) => {
      const sanitized = parseCookie(cookie);
      return sanitized ? [sanitized] : [];
    }),
    origins: Array.isArray(parsed.origins)
      ? parsed.origins.flatMap((origin) => {
          if (
            typeof origin !== "object" ||
            origin === null ||
            !("origin" in origin) ||
            typeof origin.origin !== "string" ||
            !("localStorage" in origin) ||
            !Array.isArray(origin.localStorage)
          ) return [];
          const localStorage = origin.localStorage.filter(
            (item: unknown): item is { name: string; value: string } =>
              typeof item === "object" &&
              item !== null &&
              "name" in item &&
              typeof item.name === "string" &&
              "value" in item &&
              typeof item.value === "string",
          );
          return [{ origin: origin.origin, localStorage }];
        })
      : [],
  };
}

function parseCookie(value: unknown): Cookie | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !("value" in value) ||
    typeof value.value !== "string" ||
    !("domain" in value) ||
    typeof value.domain !== "string"
  ) return undefined;
  const sameSite =
    "sameSite" in value && ["Strict", "Lax", "None"].includes(String(value.sameSite))
      ? String(value.sameSite) as Cookie["sameSite"]
      : "Lax";
  const expires =
    "expires" in value && typeof value.expires === "number" && Number.isFinite(value.expires)
      ? value.expires
      : -1;
  return {
    name: value.name,
    value: value.value,
    domain: value.domain,
    path: "path" in value && typeof value.path === "string" && value.path.startsWith("/")
      ? value.path
      : "/",
    expires,
    httpOnly: "httpOnly" in value && value.httpOnly === true,
    secure: true,
    sameSite,
  };
}

function allowedCookieDomain(domain: string): boolean {
  const normalized = domain.toLowerCase().replace(/^\./, "");
  return normalized === "tradingview.com" || normalized.endsWith(".tradingview.com");
}

function allowedStorageOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return (
      parsed.protocol === "https:" &&
      parsed.origin === origin.replace(/\/$/, "") &&
      allowedCookieDomain(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function validateSymbol(value: string): string {
  const cleaned = value.trim();
  if (!SYMBOL_PATTERN.test(cleaned)) throw new Error(`Invalid TradingView symbol: ${value}`);
  return cleaned;
}

function validateInterval(value: string): string {
  const cleaned = value.trim();
  if (!INTERVAL_PATTERN.test(cleaned)) throw new Error(`Invalid TradingView interval: ${value}`);
  return cleaned;
}

function validateLayoutId(value: string): string {
  const cleaned = value.trim();
  if (!LAYOUT_PATTERN.test(cleaned)) throw new Error("Invalid TradingView layout id.");
  return cleaned;
}

function validateExportName(value: string): string {
  const cleaned = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.csv$/i.test(cleaned)) {
    throw new Error("outputName must be a simple .csv filename without directories.");
  }
  return cleaned;
}

function validateLabel(value: string, name: string, maximum: number): string {
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > maximum || /[\u0000-\u001f\u007f]/.test(cleaned)) {
    throw new Error(`Invalid ${name}.`);
  }
  return cleaned;
}

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "chart";
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function pathIsInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
