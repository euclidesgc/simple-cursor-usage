import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import {
  computeDailyInsight,
  normalizeUsageDays,
  DEFAULT_USAGE_DAYS,
  type DailyBudgetStrategy,
  type DailyInsight,
} from "./dailyInsight";

const secretKey = "cursorUsageForTeams.accessToken";
let sqlJs: Promise<SqlJsStatic> | undefined;
let extensionPath: string | undefined;

type DisplayFormat = "remaining" | "fraction" | "percent";
type ViewMode = "total" | "daily";
type StatusBarDisplay =
  | "totalRemaining"
  | "totalFraction"
  | "totalPercent"
  | "dailyRemaining"
  | "dailyFraction"
  | "dailyPercent";

const STATUS_BAR_DISPLAYS: readonly StatusBarDisplay[] = [
  "totalRemaining",
  "totalFraction",
  "totalPercent",
  "dailyRemaining",
  "dailyFraction",
  "dailyPercent",
];

type StatusBarModel = {
  icon: string;
  value: string;
  percentForColor?: number;
};

type UsageSnapshot = {
  source: string;
  used: number;
  limit?: number;
  remaining?: number;
  percentRemaining?: number;
  periodStart?: string;
  periodEnd?: string;
  label?: string;
  rawHighlights: string[];
  refreshedAt: Date;
};

type UsageEndpointResult = {
  endpoint: string;
  ok: boolean;
  status?: number;
  statusText?: string;
  payload?: unknown;
  diagnostic?: string;
};

type CursorSessionAuth = {
  workosId: string;
  sessionToken: string;
  rawAccessToken?: string;
};

const displayStateKey = "cursorUsageForTeams.statusBarDisplay";
const legacyViewStateKey = "cursorUsageForTeams.activeView";

let statusBar: vscode.StatusBarItem;
let refreshTimer: NodeJS.Timeout | undefined;
let lastSnapshot: UsageSnapshot | undefined;
let lastError: string | undefined;
let activeDisplay: StatusBarDisplay = "totalRemaining";
let viewMemento: vscode.Memento | undefined;

export function activate(context: vscode.ExtensionContext) {
  extensionPath = context.extensionPath;
  viewMemento = context.globalState;
  activeDisplay = resolveInitialDisplay();
  statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    98,
  );
  statusBar.command = "cursorUsageForTeams.showDetails";
  statusBar.text = "$(sync~spin) Cursor usage";
  statusBar.tooltip = "Cursor Monthly Usage";
  statusBar.show();

  context.subscriptions.push(
    statusBar,
    vscode.commands.registerCommand("cursorUsageForTeams.refresh", () =>
      refreshUsage(context, true),
    ),
    vscode.commands.registerCommand("cursorUsageForTeams.showDetails", () =>
      showDetails(),
    ),
    vscode.commands.registerCommand("cursorUsageForTeams.setToken", () =>
      setToken(context),
    ),
    vscode.commands.registerCommand("cursorUsageForTeams.clearToken", () =>
      clearToken(context),
    ),
    vscode.commands.registerCommand("cursorUsageForTeams.toggleView", () =>
      toggleView(),
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("cursorUsageForTeams.statusBarDisplay")
      ) {
        activeDisplay = readConfiguredDisplay();
        void viewMemento?.update(displayStateKey, activeDisplay);
        if (lastSnapshot) {
          renderSnapshot(lastSnapshot);
        } else if (lastError) {
          renderError();
        }
      }
      if (event.affectsConfiguration("cursorUsageForTeams")) {
        scheduleRefresh(context);
        void refreshUsage(context, false);
      }
    }),
  );

  scheduleRefresh(context);
  void refreshUsage(context, false);
}

export function deactivate() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
}

function isStatusBarDisplay(value: unknown): value is StatusBarDisplay {
  return (
    typeof value === "string" &&
    (STATUS_BAR_DISPLAYS as readonly string[]).includes(value)
  );
}

function parseDisplay(display: StatusBarDisplay): {
  view: ViewMode;
  format: DisplayFormat;
} {
  switch (display) {
    case "totalRemaining":
      return { view: "total", format: "remaining" };
    case "totalFraction":
      return { view: "total", format: "fraction" };
    case "totalPercent":
      return { view: "total", format: "percent" };
    case "dailyRemaining":
      return { view: "daily", format: "remaining" };
    case "dailyFraction":
      return { view: "daily", format: "fraction" };
    case "dailyPercent":
      return { view: "daily", format: "percent" };
  }
}

function composeDisplay(
  view: ViewMode,
  format: DisplayFormat,
): StatusBarDisplay {
  if (view === "total") {
    if (format === "remaining") {
      return "totalRemaining";
    }
    if (format === "fraction") {
      return "totalFraction";
    }
    return "totalPercent";
  }
  if (format === "remaining") {
    return "dailyRemaining";
  }
  if (format === "fraction") {
    return "dailyFraction";
  }
  return "dailyPercent";
}

function flipView(display: StatusBarDisplay): StatusBarDisplay {
  const { view, format } = parseDisplay(display);
  return composeDisplay(view === "daily" ? "total" : "daily", format);
}

function readConfiguredDisplay(): StatusBarDisplay {
  const configured = getConfig<string>("statusBarDisplay", "totalRemaining");
  if (isStatusBarDisplay(configured)) {
    return configured;
  }

  const defaultView = getConfig<ViewMode>("defaultView", "total");
  const displayFormat = getConfig<DisplayFormat>("displayFormat", "remaining");
  const dailyRaw = getConfig<string>("dailyDisplayFormat", "inherit");
  const view: ViewMode = defaultView === "daily" ? "daily" : "total";
  let format: DisplayFormat = displayFormat;
  if (view === "daily") {
    if (
      dailyRaw === "remaining" ||
      dailyRaw === "fraction" ||
      dailyRaw === "percent"
    ) {
      format = dailyRaw;
    }
  }
  return composeDisplay(view, format);
}

function resolveInitialDisplay(): StatusBarDisplay {
  const stored = viewMemento?.get<unknown>(displayStateKey);
  if (isStatusBarDisplay(stored)) {
    return stored;
  }

  const legacyView = viewMemento?.get<ViewMode>(legacyViewStateKey);
  if (legacyView === "total" || legacyView === "daily") {
    const { format } = parseDisplay(readConfiguredDisplay());
    return composeDisplay(legacyView, format);
  }

  return readConfiguredDisplay();
}

function displayModeLabel(display: StatusBarDisplay): string {
  const { view, format } = parseDisplay(display);
  const viewLabel = view === "total" ? "monthly" : "daily";
  const formatLabel =
    format === "remaining"
      ? "remaining"
      : format === "fraction"
        ? "fraction"
        : "percent";
  return `${viewLabel} · ${formatLabel}`;
}

async function toggleView() {
  activeDisplay = flipView(activeDisplay);
  await viewMemento?.update(displayStateKey, activeDisplay);

  if (lastSnapshot) {
    renderSnapshot(lastSnapshot);
  } else if (lastError) {
    renderError();
  } else {
    setLoading();
  }
}
function scheduleRefresh(context: vscode.ExtensionContext) {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }

  const intervalSeconds = Math.max(
    60,
    getConfig<number>("pollIntervalSeconds", 300),
  );
  refreshTimer = setInterval(() => {
    void refreshUsage(context, false);
  }, intervalSeconds * 1000);
}

async function refreshUsage(
  context: vscode.ExtensionContext,
  interactive: boolean,
) {
  setLoading();

  try {
    const auth = await resolveCursorAuth(context);
    if (!auth) {
      throw new Error(
        'No Cursor session found. Sign in to Cursor and keep local token discovery enabled, or run "Cursor Monthly Usage: Set Token".',
      );
    }

    const snapshot = await fetchUsageSnapshot(auth);
    lastSnapshot = snapshot;
    lastError = undefined;
    renderSnapshot(snapshot);

    if (interactive) {
      vscode.window.setStatusBarMessage("Cursor monthly usage refreshed", 2500);
    }
  } catch (error) {
    lastError =
      error instanceof Error ? error.message : "Unknown usage refresh error";
    renderError();

    if (interactive) {
      void vscode.window.showWarningMessage(lastError);
    }
  }
}

async function resolveCursorAuth(
  context: vscode.ExtensionContext,
): Promise<CursorSessionAuth | undefined> {
  const discovered = getConfig<boolean>("enableLocalTokenDiscovery", true)
    ? await discoverCursorAuth()
    : undefined;
  const storedToken = (await context.secrets.get(secretKey))?.trim();

  const sessionParts = storedToken ? parseSessionParts(storedToken) : undefined;
  const sessionToken = sessionParts?.sessionToken ?? discovered?.sessionToken;
  const workosId = sessionParts?.workosId ?? discovered?.workosId;

  if (!sessionToken || !workosId) {
    return undefined;
  }

  const normalizedWorkosId = normalizeWorkosId(workosId);

  return {
    workosId: normalizedWorkosId,
    sessionToken,
    rawAccessToken: storedToken ?? discovered?.rawAccessToken,
  };
}

async function setToken(context: vscode.ExtensionContext) {
  const token = await vscode.window.showInputBox({
    title: "Cursor Monthly Usage Token",
    prompt:
      "Paste a Cursor access/session token. It will be stored in VS Code SecretStorage.",
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim().length > 10 ? undefined : "Token looks too short.",
  });

  if (!token) {
    return;
  }

  await context.secrets.store(secretKey, token.trim());
  await refreshUsage(context, true);
}

async function clearToken(context: vscode.ExtensionContext) {
  await context.secrets.delete(secretKey);
  vscode.window.setStatusBarMessage("Cursor monthly usage token cleared", 2500);
  await refreshUsage(context, false);
}

async function fetchUsageSnapshot(
  auth: CursorSessionAuth,
): Promise<UsageSnapshot> {
  const webBase = validateApiBaseUrl(
    getConfig<string>("apiBaseUrl", "https://cursor.com"),
  );
  warnIfUnexpectedApiHost(webBase);
  const usageSummaryUrl = new URL("/api/usage-summary", webBase);

  const result = await requestJson(usageSummaryUrl, {
    method: "GET",
    headers: {
      Cookie: buildSessionCookieHeader(auth),
    },
  });

  const snapshot =
    result.payload !== undefined
      ? (parseDashboardUsage(result.payload) ??
        parseGenericUsage(result.payload, result.endpoint))
      : undefined;

  if (!snapshot) {
    throw new Error(
      `Cursor usage API returned an unrecognized response. ${summarizeEndpointResults([result])}`,
    );
  }

  snapshot.rawHighlights = collectHighlights(
    result.payload !== undefined ? [result.payload] : [],
  );
  snapshot.refreshedAt = new Date();
  return snapshot;
}

const REQUEST_TIMEOUT_MS = 15000;

async function requestJson(
  url: URL,
  init: RequestInit,
): Promise<UsageEndpointResult> {
  const endpoint = url.pathname;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    const base = {
      endpoint,
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
    };

    if (!text.trim()) {
      return { ...base, diagnostic: "empty response" };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      return { ...base, diagnostic: `non-JSON response: ${previewText(text)}` };
    }

    if (!response.ok) {
      return { ...base, diagnostic: summarizePayload(payload) };
    }

    return { ...base, payload };
  } catch (error) {
    const diagnostic =
      error instanceof Error && error.name === "AbortError"
        ? `request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
        : error instanceof Error
          ? error.message
          : "request failed";
    return { endpoint, ok: false, diagnostic };
  } finally {
    clearTimeout(timeout);
  }
}

function parseDashboardUsage(payload: unknown): UsageSnapshot | undefined {
  const planUsage = findObjectByKey(payload, "planUsage");
  if (!planUsage) {
    return undefined;
  }

  const used = firstNumber(planUsage, [
    "usedCents",
    "currentUsageCents",
    "usageCents",
    "used",
    "usage",
    "currentUsage",
  ]);
  const limit = firstNumber(planUsage, [
    "limitCents",
    "hardLimitCents",
    "monthlyLimitCents",
    "includedCents",
    "limit",
    "max",
  ]);
  if (used === undefined) {
    return undefined;
  }

  return completeSnapshot({
    source: "DashboardService.GetCurrentPeriodUsage",
    used,
    limit,
    periodStart: normalizePeriodValue(
      firstString(payload, [
        "periodStart",
        "currentPeriodStart",
        "billingPeriodStart",
        "billingCycleStart",
        "startDate",
      ]),
    ),
    periodEnd: normalizePeriodValue(
      firstString(payload, [
        "periodEnd",
        "currentPeriodEnd",
        "billingPeriodEnd",
        "billingCycleEnd",
        "endDate",
      ]),
    ),
    label: "Plan usage",
    rawHighlights: [],
    refreshedAt: new Date(),
  });
}

function parseGenericUsage(
  payload: unknown,
  source: string,
): UsageSnapshot | undefined {
  const percentRemaining = firstNumber(payload, [
    "percentRemaining",
    "remainingPercent",
  ]);
  const remaining = firstNumber(payload, [
    "remainingCents",
    "remaining",
    "availableCents",
    "available",
  ]);
  const used = firstNumber(payload, [
    "usedCents",
    "currentUsageCents",
    "usageCents",
    "spendCents",
    "spentCents",
    "currentSpendCents",
    "used",
    "usage",
    "currentUsage",
    "spend",
    "spent",
  ]);
  const limit = firstNumber(payload, [
    "limitCents",
    "hardLimitCents",
    "monthlyLimitCents",
    "includedCents",
    "usageLimitCents",
    "maxSpendCents",
    "limit",
    "usageLimit",
    "hardLimit",
    "monthlyLimit",
    "included",
  ]);

  const normalizedUsed =
    used ??
    (limit !== undefined && remaining !== undefined
      ? limit - remaining
      : undefined);

  if (normalizedUsed === undefined) {
    return undefined;
  }

  const snapshot = completeSnapshot({
    source,
    used: normalizedUsed,
    limit,
    periodStart: normalizePeriodValue(
      firstString(payload, [
        "periodStart",
        "currentPeriodStart",
        "billingPeriodStart",
        "billingCycleStart",
        "startOfMonth",
        "startDate",
      ]),
    ),
    periodEnd: normalizePeriodValue(
      firstString(payload, [
        "periodEnd",
        "currentPeriodEnd",
        "billingPeriodEnd",
        "billingCycleEnd",
        "endOfMonth",
        "endDate",
      ]),
    ),
    label: "Usage",
    rawHighlights: [],
    refreshedAt: new Date(),
  });

  if (remaining !== undefined && snapshot.remaining === undefined) {
    snapshot.remaining = Math.max(0, remaining);
  }
  if (percentRemaining !== undefined) {
    snapshot.percentRemaining = percentRemaining;
  }

  return snapshot;
}

function completeSnapshot(snapshot: UsageSnapshot): UsageSnapshot {
  if (snapshot.limit !== undefined) {
    snapshot.remaining = Math.max(0, snapshot.limit - snapshot.used);
    snapshot.percentRemaining =
      snapshot.limit > 0
        ? (snapshot.remaining / snapshot.limit) * 100
        : undefined;
  }

  return snapshot;
}

function parseUsageDays(): Set<number> {
  return normalizeUsageDays(
    getConfig<unknown>("usageDays", DEFAULT_USAGE_DAYS),
  );
}

function resolveDailyBudgetStrategy(): DailyBudgetStrategy {
  return getConfig<DailyBudgetStrategy>("dailyBudgetStrategy", "dynamic") ===
    "static"
    ? "static"
    : "dynamic";
}

// Thin wrapper that feeds the pure pacing math (see ./dailyInsight) with values
// resolved from configuration and the current clock.
function buildInsight(snapshot: UsageSnapshot): DailyInsight {
  return computeDailyInsight(snapshot, {
    usageDays: parseUsageDays(),
    strategy: resolveDailyBudgetStrategy(),
    now: new Date(),
  });
}

function renderSnapshot(snapshot: UsageSnapshot) {
  const { view, format } = parseDisplay(activeDisplay);
  const insight = buildInsight(snapshot);

  // Daily view needs a computable budget; otherwise fall back to the total view.
  const model =
    view === "daily" && insight && insight.recommendedPerDay !== undefined
      ? buildDailyModel(insight, format)
      : buildTotalModel(snapshot, format);

  statusBar.text = `$(${model.icon}) ${model.value}`;
  statusBar.tooltip = buildTooltip(snapshot, insight);
  statusBar.backgroundColor = colorForPercent(model.percentForColor);
}

function buildTotalModel(
  snapshot: UsageSnapshot,
  displayFormat: DisplayFormat,
): StatusBarModel {
  return {
    icon: "pulse",
    value: formatSnapshotValue(snapshot, displayFormat),
    percentForColor: snapshot.percentRemaining,
  };
}

function buildDailyModel(
  insight: DailyInsight,
  displayFormat: DisplayFormat,
): StatusBarModel {
  return {
    icon: "calendar",
    value: formatDailyValue(insight, displayFormat),
    percentForColor: insight.percentRemainingOfBudget,
  };
}

function colorForPercent(
  percent: number | undefined,
): vscode.ThemeColor | undefined {
  if (percent === undefined) {
    return undefined;
  }

  const warning = getConfig<number>("warningRemainingPercent", 20);
  const critical = getConfig<number>("criticalRemainingPercent", 10);

  if (percent <= critical) {
    return new vscode.ThemeColor("statusBarItem.errorBackground");
  }
  if (percent <= warning) {
    return new vscode.ThemeColor("statusBarItem.warningBackground");
  }

  return undefined;
}

function formatSnapshotValue(
  snapshot: UsageSnapshot,
  displayFormat: DisplayFormat,
): string {
  if (displayFormat === "percent" && snapshot.percentRemaining !== undefined) {
    return `${Math.round(snapshot.percentRemaining)}% left`;
  }

  if (displayFormat === "fraction" && snapshot.limit !== undefined) {
    return `${formatUsageValue(snapshot.used)} / ${formatUsageValue(snapshot.limit)}`;
  }

  if (snapshot.remaining !== undefined) {
    return `${formatUsageValue(snapshot.remaining)} left`;
  }

  return `${formatUsageValue(snapshot.used)} used`;
}

function formatDailyValue(
  insight: DailyInsight,
  displayFormat: DisplayFormat,
): string {
  const recommended = insight.recommendedPerDay ?? 0;

  if (displayFormat === "fraction") {
    return `${formatUsageValue(insight.consumptionPerDay)} / ${formatUsageValue(recommended)} per day`;
  }

  if (displayFormat === "percent") {
    if (insight.percentRemainingOfBudget === undefined) {
      return `${formatUsageValue(insight.consumptionPerDay)} per day`;
    }
    if (insight.percentRemainingOfBudget < 0) {
      return "over daily budget";
    }
    return `${Math.round(insight.percentRemainingOfBudget)}% left`;
  }

  // "remaining" → daily headroom (recommended minus your average pace).
  const headroom = insight.headroomPerDay ?? 0;
  if (headroom < 0) {
    return `${formatUsageValue(Math.abs(headroom))}/day over`;
  }
  return `${formatUsageValue(headroom)}/day left`;
}

function buildTooltip(
  snapshot: UsageSnapshot,
  insight: DailyInsight | undefined,
): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.isTrusted = false;
  tooltip.appendMarkdown("**Cursor Monthly Usage**\n\n");
  tooltip.appendMarkdown(`Source: ${snapshot.source}\n\n`);
  if (snapshot.label) {
    tooltip.appendMarkdown(`Bucket: ${snapshot.label}\n\n`);
  }
  tooltip.appendMarkdown(`Used: ${formatUsageValue(snapshot.used)}\n\n`);
  if (snapshot.limit !== undefined) {
    tooltip.appendMarkdown(`Limit: ${formatUsageValue(snapshot.limit)}\n\n`);
  }
  if (snapshot.remaining !== undefined) {
    tooltip.appendMarkdown(
      `Remaining: ${formatUsageValue(snapshot.remaining)}\n\n`,
    );
  }
  if (snapshot.periodStart) {
    tooltip.appendMarkdown(`Period start: ${snapshot.periodStart}\n\n`);
  }
  if (snapshot.periodEnd) {
    tooltip.appendMarkdown(`Period end: ${snapshot.periodEnd}\n\n`);
  }
  appendDailyTooltip(tooltip, insight);
  tooltip.appendMarkdown(`Refreshed: ${snapshot.refreshedAt.toLocaleString()}`);
  return tooltip;
}

function appendDailyTooltip(
  tooltip: vscode.MarkdownString,
  insight: DailyInsight | undefined,
) {
  if (!insight) {
    return;
  }

  tooltip.appendMarkdown(`---\n\n`);
  tooltip.appendMarkdown(`**Per usage day** (${insight.strategy})\n\n`);
  tooltip.appendMarkdown(
    insight.recommendedPerDay !== undefined
      ? `Recommended: ${formatUsageValue(insight.recommendedPerDay)} / usage day\n\n`
      : `Recommended: — (no limit/period available)\n\n`,
  );
  tooltip.appendMarkdown(
    `Average so far: ${formatUsageValue(insight.consumptionPerDay)} / usage day\n\n`,
  );
  if (insight.headroomPerDay !== undefined) {
    tooltip.appendMarkdown(
      `Headroom: ${formatHeadroom(insight.headroomPerDay)} / usage day\n\n`,
    );
  }
  tooltip.appendMarkdown(
    `Usage days: ${insight.usageDaysElapsed} elapsed · ${insight.usageDaysRemaining} remaining · ${insight.usageDaysTotal} total\n\n`,
  );
  if (insight.usedFallbackPeriod) {
    tooltip.appendMarkdown(
      `_Period unknown — using the current calendar month._\n\n`,
    );
  }
}

function formatHeadroom(headroom: number): string {
  return headroom >= 0
    ? `${formatUsageValue(headroom)} under budget`
    : `${formatUsageValue(Math.abs(headroom))} over budget`;
}

function renderError() {
  statusBar.text = "$(warning) Cursor usage";
  statusBar.tooltip = lastError ?? "Cursor monthly usage refresh failed";
  statusBar.backgroundColor = new vscode.ThemeColor(
    "statusBarItem.warningBackground",
  );
}

function setLoading() {
  statusBar.text = "$(sync~spin) Cursor usage";
  statusBar.tooltip = "Refreshing Cursor monthly usage";
  statusBar.backgroundColor = undefined;
}

async function showDetails() {
  if (!lastSnapshot) {
    const action = await vscode.window.showInformationMessage(
      lastError ?? "No Cursor usage data yet.",
      "Refresh",
    );
    if (action === "Refresh") {
      await vscode.commands.executeCommand("cursorUsageForTeams.refresh");
    }
    return;
  }

  const insight = buildInsight(lastSnapshot);
  const toggleLabel = `$(arrow-swap) Toggle daily / total view (now: ${displayModeLabel(activeDisplay)})`;

  const lines = [
    toggleLabel,
    `Source: ${lastSnapshot.source}`,
    lastSnapshot.label ? `Bucket: ${lastSnapshot.label}` : undefined,
    `Used: ${formatUsageValue(lastSnapshot.used)}`,
    lastSnapshot.limit !== undefined
      ? `Limit: ${formatUsageValue(lastSnapshot.limit)}`
      : undefined,
    lastSnapshot.remaining !== undefined
      ? `Remaining: ${formatUsageValue(lastSnapshot.remaining)}`
      : undefined,
    lastSnapshot.percentRemaining !== undefined
      ? `Percent remaining: ${Math.round(lastSnapshot.percentRemaining)}%`
      : undefined,
    lastSnapshot.periodStart
      ? `Period start: ${lastSnapshot.periodStart}`
      : undefined,
    lastSnapshot.periodEnd
      ? `Period end: ${lastSnapshot.periodEnd}`
      : undefined,
    ...dailyDetailLines(insight),
    `Refreshed: ${lastSnapshot.refreshedAt.toLocaleString()}`,
    ...lastSnapshot.rawHighlights,
  ].filter((line): line is string => Boolean(line));

  const picked = await vscode.window.showQuickPick(lines, {
    title: "Cursor Monthly Usage",
    placeHolder: "Current usage details",
  });

  if (picked === toggleLabel) {
    await vscode.commands.executeCommand("cursorUsageForTeams.toggleView");
  }
}

function dailyDetailLines(insight: DailyInsight | undefined): string[] {
  if (!insight) {
    return [];
  }

  const lines: string[] = [
    insight.recommendedPerDay !== undefined
      ? `Recommended per usage day (${insight.strategy}): ${formatUsageValue(insight.recommendedPerDay)}`
      : `Recommended per usage day: — (no limit/period available)`,
    `Average per usage day: ${formatUsageValue(insight.consumptionPerDay)}`,
  ];

  if (insight.headroomPerDay !== undefined) {
    lines.push(
      `Headroom per usage day: ${formatHeadroom(insight.headroomPerDay)}`,
    );
  }

  lines.push(
    `Usage days: ${insight.usageDaysElapsed} elapsed / ${insight.usageDaysRemaining} remaining / ${insight.usageDaysTotal} total`,
  );

  if (insight.usedFallbackPeriod) {
    lines.push(`Period unknown — using current calendar month.`);
  }

  return lines;
}

function formatUsageValue(value: number): string {
  return formatCurrencyFromCents(value);
}

function formatCurrencyFromCents(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function normalizePeriodValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && String(Math.trunc(asNumber)).length >= 12) {
    return new Date(asNumber).toISOString();
  }

  return value;
}

function validateApiBaseUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:") {
    throw new Error("cursorUsageForTeams.apiBaseUrl must use HTTPS.");
  }

  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

const warnedApiHosts = new Set<string>();

function isAllowedApiHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "cursor.com" || host.endsWith(".cursor.com");
}

// Defense in depth on top of the machine-scoped apiBaseUrl setting: the session
// cookie is only ever sent to this origin, so warn (once per host per session)
// if it is not a Cursor host.
function warnIfUnexpectedApiHost(url: URL): void {
  if (isAllowedApiHost(url.hostname) || warnedApiHosts.has(url.host)) {
    return;
  }

  warnedApiHosts.add(url.host);
  void vscode.window.showWarningMessage(
    `Cursor Monthly Usage is sending your session cookie to a non-Cursor host: ${url.host}. ` +
      "Only change cursorUsageForTeams.apiBaseUrl if you trust this origin.",
  );
}

async function discoverCursorAuth(): Promise<CursorSessionAuth | undefined> {
  const values = await loadCursorStateValues();
  if (!values) {
    return undefined;
  }

  const mergedValues = mergeCursorAuthValues(values);
  const rawToken = extractToken(mergedValues);
  if (!rawToken) {
    return undefined;
  }

  const sessionParts = parseSessionParts(rawToken);
  const sessionToken = sessionParts.sessionToken;
  let workosId =
    sessionParts.workosId ?? extractWorkosId(mergedValues, sessionToken);
  if (!workosId) {
    workosId = workosIdFromSessionToken(sessionToken);
  }

  if (!workosId) {
    return undefined;
  }

  return {
    workosId: normalizeWorkosId(workosId),
    sessionToken,
    rawAccessToken: rawToken,
  };
}

async function loadCursorStateValues(): Promise<
  Record<string, unknown> | undefined
> {
  const dbPath = cursorStateDbPath();
  if (!dbPath || !existsSync(dbPath)) {
    return undefined;
  }

  try {
    const SQL = await loadSqlJs();
    const buffer = await readFile(dbPath);
    const db = new SQL.Database(new Uint8Array(buffer));
    try {
      const result = db.exec("SELECT key, value FROM ItemTable");
      const values: Record<string, unknown> = {};
      for (const row of result[0]?.values ?? []) {
        const [key, value] = row;
        if (typeof key === "string") {
          values[key] =
            value instanceof Uint8Array
              ? new TextDecoder().decode(value)
              : value;
        }
      }
      return values;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

function loadSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJs) {
    const wasmDir = extensionPath
      ? path.join(extensionPath, "node_modules", "sql.js", "dist")
      : path.dirname(require.resolve("sql.js/dist/sql-wasm.js"));
    sqlJs = initSqlJs({
      locateFile: (file) => path.join(wasmDir, file),
    });
  }
  return sqlJs;
}

function mergeCursorAuthValues(
  values: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...values };
  const authBlob: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(values)) {
    if (!key.startsWith("cursorAuth/")) {
      continue;
    }

    authBlob[key.slice("cursorAuth/".length)] = value;
  }

  if (Object.keys(authBlob).length > 0) {
    merged.cursorAuth = authBlob;
  }

  return merged;
}

function buildSessionCookieHeader(auth: CursorSessionAuth): string {
  const raw = auth.rawAccessToken?.trim();
  if (raw) {
    const decoded = decodeURIComponent(raw);
    if (decoded.includes("::") || raw.includes("%3A%3A")) {
      const sessionValue = decoded.includes("::")
        ? decoded
        : decodeURIComponent(raw);
      return `WorkosCursorSessionToken=${encodeURIComponent(sessionValue)}`;
    }
  }

  const workosId = normalizeWorkosId(auth.workosId);
  const sessionValue = `${workosId}::${auth.sessionToken}`;
  return `WorkosCursorSessionToken=${encodeURIComponent(sessionValue)}`;
}

function parseSessionParts(token: string): {
  workosId?: string;
  sessionToken: string;
} {
  const decoded = decodeURIComponent(token.trim());
  const separator = decoded.indexOf("::");
  if (separator >= 0) {
    return {
      workosId: decoded.slice(0, separator),
      sessionToken: decoded.slice(separator + 2),
    };
  }

  return { sessionToken: decoded };
}

function normalizeWorkosId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("user_")) {
    return trimmed;
  }

  const pipeSegment = trimmed
    .split("|")
    .find((segment) => segment.startsWith("user_"));
  if (pipeSegment) {
    return pipeSegment;
  }

  return `user_${trimmed}`;
}

function extractWorkosId(
  values: Record<string, unknown>,
  token: string,
): string | undefined {
  const direct = firstString(values, [
    "cursorAuth/workosId",
    "workos_id",
    "workosId",
    "userId",
    "user_id",
  ]);
  if (direct) {
    return direct;
  }

  for (const [key, value] of Object.entries(values)) {
    if (
      !key.toLowerCase().includes("user") &&
      !key.toLowerCase().includes("workos")
    ) {
      continue;
    }

    const found = firstString(value, [
      "workosId",
      "workos_id",
      "userId",
      "user_id",
      "sub",
    ]);
    if (found) {
      return found;
    }
  }

  const payload = decodeJwtPayload(token);
  if (payload) {
    const fromJwt = firstString(payload, [
      "sub",
      "userId",
      "user_id",
      "workosId",
      "workos_id",
    ]);
    if (fromJwt) {
      return fromJwt;
    }
  }

  return undefined;
}

function workosIdFromSessionToken(sessionToken: string): string | undefined {
  const payload = decodeJwtPayload(sessionToken);
  if (!payload) {
    return undefined;
  }

  return firstString(payload, [
    "sub",
    "userId",
    "user_id",
    "workosId",
    "workos_id",
  ]);
}

// Decodes the JWT payload WITHOUT verifying its signature. This is intentional
// and safe here: the token belongs to the signed-in user and is only read to
// extract the WorkOS id (`sub`); it is never trusted for authorization.
function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length < 3) {
    return undefined;
  }

  try {
    const segment = parts[1];
    const padded = segment + "=".repeat((4 - (segment.length % 4)) % 4);
    const base64 = padded.split("-").join("+").split("_").join("/");
    const json = Buffer.from(base64, "base64").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function cursorStateDbPath(): string | undefined {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(
      home,
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb",
    );
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    return appData
      ? path.join(appData, "Cursor", "User", "globalStorage", "state.vscdb")
      : undefined;
  }
  return path.join(
    home,
    ".config",
    "Cursor",
    "User",
    "globalStorage",
    "state.vscdb",
  );
}

function extractToken(values: Record<string, unknown>): string | undefined {
  const exact = values["cursorAuth/accessToken"];
  const exactToken = tokenFromUnknown(exact);
  if (exactToken) {
    return exactToken;
  }

  for (const [key, value] of Object.entries(values)) {
    if (!key.toLowerCase().includes("token")) {
      continue;
    }

    const token = tokenFromUnknown(value);
    if (token) {
      return token;
    }
  }

  for (const value of Object.values(values)) {
    const token = tokenFromUnknown(value);
    if (token) {
      return token;
    }
  }

  return undefined;
}

function tokenFromUnknown(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed)) {
      return tokenFromRecord(parsed);
    }
  } catch {
    // Plain token strings are common.
  }

  const jwt = trimmed.match(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  if (jwt) {
    return jwt[0];
  }

  return trimmed.length > 20 ? trimmed : undefined;
}

function tokenFromRecord(record: Record<string, unknown>): string | undefined {
  for (const key of ["accessToken", "token", "sessionToken", "jwt"]) {
    const token = tokenFromUnknown(record[key]);
    if (token) {
      return token;
    }
  }

  for (const value of Object.values(record)) {
    if (isRecord(value)) {
      const token = tokenFromRecord(value);
      if (token) {
        return token;
      }
    }
  }

  return undefined;
}

function collectHighlights(payloads: unknown[]): string[] {
  const highlights: string[] = [];
  const interestingKeys = [
    "onDemand",
    "spend",
    "team",
    "hardLimit",
    "usageLimit",
  ];

  for (const payload of payloads) {
    for (const key of interestingKeys) {
      const value = firstValueByKey(payload, key);
      if (value !== undefined && highlights.length < 5) {
        highlights.push(`${key}: ${formatBriefValue(value)}`);
      }
    }
  }

  return [...new Set(highlights)];
}

function formatBriefValue(value: unknown): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }

  try {
    return JSON.stringify(value).slice(0, 140);
  } catch {
    return "[object]";
  }
}

function summarizeEndpointResults(results: UsageEndpointResult[]): string {
  return results
    .map((result) => {
      const status =
        result.status !== undefined
          ? `${result.status} ${result.statusText ?? ""}`.trim()
          : "request failed";
      if (result.payload !== undefined) {
        return `${result.endpoint}: ${status}, ${summarizePayload(result.payload)}`;
      }

      return `${result.endpoint}: ${status}${result.diagnostic ? `, ${result.diagnostic}` : ""}`;
    })
    .join("; ");
}

function summarizePayload(payload: unknown): string {
  const message = firstString(payload, ["error", "message", "detail"]);
  const keys = topLevelKeys(payload);
  return (
    [message, keys ? `keys: ${keys}` : undefined].filter(Boolean).join(", ") ||
    typeof payload
  );
}

function topLevelKeys(value: unknown): string | undefined {
  if (isRecord(value)) {
    const keys = Object.keys(value).slice(0, 8);
    if (keys.length === 0) {
      return "empty object";
    }

    const nestedKeys = Object.entries(value)
      .filter((entry): entry is [string, Record<string, unknown>] =>
        isRecord(entry[1]),
      )
      .slice(0, 3)
      .map(
        ([key, child]) =>
          `${key}{${Object.keys(child).slice(0, 6).join(", ") || "empty"}}`,
      );

    return [keys.join(", "), ...nestedKeys].join("; ");
  }

  if (Array.isArray(value)) {
    const firstRecord = value.find(isRecord);
    const keys = firstRecord ? Object.keys(firstRecord).slice(0, 8) : [];
    return `array(${value.length})${keys.length > 0 ? ` item keys: ${keys.join(", ")}` : ""}`;
  }

  return undefined;
}

function previewText(text: string): string {
  let preview = "";
  let inWhitespace = false;

  for (const character of text.trim()) {
    if (character <= " ") {
      if (!inWhitespace) {
        preview += " ";
      }
      inWhitespace = true;
    } else {
      preview += character;
      inWhitespace = false;
    }

    if (preview.length >= 140) {
      return preview;
    }
  }

  return preview;
}

function findObjectByKey(
  value: unknown,
  keyName: string,
): Record<string, unknown> | undefined {
  const found = firstValueByKey(value, keyName);
  return isRecord(found) ? found : undefined;
}

function firstValueByKey(value: unknown, keyName: string): unknown {
  if (!isRecord(value)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = firstValueByKey(item, keyName);
        if (found !== undefined) {
          return found;
        }
      }
    }
    return undefined;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase() === keyName.toLowerCase()) {
      return child;
    }
  }

  for (const child of Object.values(value)) {
    const found = firstValueByKey(child, keyName);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

function firstNumber(value: unknown, keys: string[]): number | undefined {
  for (const key of keys) {
    const found = firstValueByKey(value, key);
    if (typeof found === "number" && Number.isFinite(found)) {
      return found;
    }
    if (typeof found === "string") {
      const parsed = Number(found);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return undefined;
}

function firstString(value: unknown, keys: string[]): string | undefined {
  for (const key of keys) {
    const found = firstValueByKey(value, key);
    if (typeof found === "string" && found.trim()) {
      return found.trim();
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getConfig<T>(key: string, fallback: T): T {
  return vscode.workspace
    .getConfiguration("cursorUsageForTeams")
    .get<T>(key, fallback);
}
