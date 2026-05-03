import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import initSqlJs, { type SqlJsStatic } from 'sql.js';

const secretKey = 'cursorMonthlyUsage.accessToken';
let sqlJs: Promise<SqlJsStatic> | undefined;

type DisplayFormat = 'remaining' | 'fraction' | 'percent';

type UsageSnapshot = {
  source: string;
  unit: 'currency' | 'requests';
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

let statusBar: vscode.StatusBarItem;
let refreshTimer: NodeJS.Timeout | undefined;
let lastSnapshot: UsageSnapshot | undefined;
let lastError: string | undefined;

export function activate(context: vscode.ExtensionContext) {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
  statusBar.command = 'cursorMonthlyUsage.showDetails';
  statusBar.text = '$(sync~spin) Cursor usage';
  statusBar.tooltip = 'Cursor Monthly Usage';
  statusBar.show();

  context.subscriptions.push(
    statusBar,
    vscode.commands.registerCommand('cursorMonthlyUsage.refresh', () => refreshUsage(context, true)),
    vscode.commands.registerCommand('cursorMonthlyUsage.showDetails', () => showDetails()),
    vscode.commands.registerCommand('cursorMonthlyUsage.setToken', () => setToken(context)),
    vscode.commands.registerCommand('cursorMonthlyUsage.clearToken', () => clearToken(context)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('cursorMonthlyUsage')) {
        scheduleRefresh(context);
        void refreshUsage(context, false);
      }
    })
  );

  scheduleRefresh(context);
  void refreshUsage(context, false);
}

export function deactivate() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
}

function scheduleRefresh(context: vscode.ExtensionContext) {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }

  const intervalSeconds = Math.max(60, getConfig<number>('pollIntervalSeconds', 300));
  refreshTimer = setInterval(() => {
    void refreshUsage(context, false);
  }, intervalSeconds * 1000);
}

async function refreshUsage(context: vscode.ExtensionContext, interactive: boolean) {
  setLoading();

  try {
    const token = await resolveAccessToken(context);
    if (!token) {
      throw new Error('No Cursor token found. Run "Cursor Monthly Usage: Set Token" or sign in to Cursor and keep local token discovery enabled.');
    }

    const apiBase = validateApiBaseUrl(getConfig<string>('apiBaseUrl', 'https://api2.cursor.sh'));
    const snapshot = await fetchUsageSnapshot(apiBase, token);
    lastSnapshot = snapshot;
    lastError = undefined;
    renderSnapshot(snapshot);

    if (interactive) {
      vscode.window.setStatusBarMessage('Cursor monthly usage refreshed', 2500);
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : 'Unknown usage refresh error';
    renderError();

    if (interactive) {
      void vscode.window.showWarningMessage(lastError);
    }
  }
}

async function resolveAccessToken(context: vscode.ExtensionContext): Promise<string | undefined> {
  const stored = await context.secrets.get(secretKey);
  if (stored?.trim()) {
    return stored.trim();
  }

  if (!getConfig<boolean>('enableLocalTokenDiscovery', true)) {
    return undefined;
  }

  return discoverCursorToken();
}

async function setToken(context: vscode.ExtensionContext) {
  const token = await vscode.window.showInputBox({
    title: 'Cursor Monthly Usage Token',
    prompt: 'Paste a Cursor access/session token. It will be stored in VS Code SecretStorage.',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => value.trim().length > 10 ? undefined : 'Token looks too short.'
  });

  if (!token) {
    return;
  }

  await context.secrets.store(secretKey, token.trim());
  await refreshUsage(context, true);
}

async function clearToken(context: vscode.ExtensionContext) {
  await context.secrets.delete(secretKey);
  vscode.window.setStatusBarMessage('Cursor monthly usage token cleared', 2500);
  await refreshUsage(context, false);
}

async function fetchUsageSnapshot(apiBase: URL, token: string): Promise<UsageSnapshot> {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Connect-Protocol-Version': '1'
  };

  const attempts: Array<Promise<unknown | undefined>> = [
    requestJson(new URL('/aiserver.v1.DashboardService/GetCurrentPeriodUsage', apiBase), {
      method: 'POST',
      headers,
      body: '{}'
    }),
    requestJson(new URL('/auth/usage', apiBase), {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    }),
    requestJson(new URL('/api/usage/summary', apiBase), {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    })
  ];

  const results = await Promise.allSettled(attempts);
  const payloads = results.flatMap((result) => result.status === 'fulfilled' && result.value ? [result.value] : []);
  const dashboard = payloads.map(parseDashboardUsage).find(Boolean);
  const bucket = payloads.map(parseRequestBucketUsage).find(Boolean);

  const snapshot = dashboard ?? bucket;
  if (!snapshot) {
    throw new Error('Cursor usage API returned an unrecognized response.');
  }

  snapshot.rawHighlights = collectHighlights(payloads);
  snapshot.refreshedAt = new Date();
  return snapshot;
}

async function requestJson(url: URL, init: RequestInit): Promise<unknown | undefined> {
  const response = await fetch(url, init);
  if (!response.ok) {
    return undefined;
  }

  const text = await response.text();
  if (!text.trim()) {
    return undefined;
  }

  return JSON.parse(text) as unknown;
}

function parseDashboardUsage(payload: unknown): UsageSnapshot | undefined {
  const planUsage = findObjectByKey(payload, 'planUsage');
  if (!planUsage) {
    return undefined;
  }

  const used = firstNumber(planUsage, ['usedCents', 'currentUsageCents', 'usageCents', 'used', 'usage', 'currentUsage']);
  const limit = firstNumber(planUsage, ['limitCents', 'hardLimitCents', 'monthlyLimitCents', 'includedCents', 'limit', 'max']);
  const totalPercentUsed = firstNumber(planUsage, ['totalPercentUsed']);
  const normalizedUsed = used ?? totalPercentUsed;
  const normalizedLimit = limit ?? (totalPercentUsed !== undefined ? 100 : undefined);

  if (normalizedUsed === undefined) {
    return undefined;
  }

  return completeSnapshot({
    source: 'DashboardService.GetCurrentPeriodUsage',
    unit: totalPercentUsed !== undefined && used === undefined ? 'requests' : 'currency',
    used: normalizedUsed,
    limit: normalizedLimit,
    periodStart: normalizePeriodValue(firstString(payload, ['periodStart', 'currentPeriodStart', 'billingPeriodStart', 'billingCycleStart', 'startDate'])),
    periodEnd: normalizePeriodValue(firstString(payload, ['periodEnd', 'currentPeriodEnd', 'billingPeriodEnd', 'billingCycleEnd', 'endDate'])),
    label: totalPercentUsed !== undefined && used === undefined ? 'Plan usage (%)' : 'Plan usage',
    rawHighlights: [],
    refreshedAt: new Date()
  });
}

function parseRequestBucketUsage(payload: unknown): UsageSnapshot | undefined {
  const preferredKey = getConfig<string>('includedModelKey', 'gpt-4').toLowerCase();
  const buckets = findRequestBuckets(payload);
  if (buckets.length === 0) {
    return undefined;
  }

  const preferred = buckets.find((bucket) => bucket.key.toLowerCase().includes(preferredKey)) ?? buckets[0];
  return completeSnapshot({
    source: '/auth/usage',
    unit: 'requests',
    used: preferred.used,
    limit: preferred.limit,
    label: preferred.key,
    periodStart: firstString(payload, ['periodStart', 'currentPeriodStart', 'billingPeriodStart', 'startOfMonth']),
    periodEnd: firstString(payload, ['periodEnd', 'currentPeriodEnd', 'billingPeriodEnd', 'endOfMonth']),
    rawHighlights: [],
    refreshedAt: new Date()
  });
}

function completeSnapshot(snapshot: UsageSnapshot): UsageSnapshot {
  if (snapshot.limit !== undefined) {
    snapshot.remaining = Math.max(0, snapshot.limit - snapshot.used);
    snapshot.percentRemaining = snapshot.limit > 0 ? (snapshot.remaining / snapshot.limit) * 100 : undefined;
  }

  return snapshot;
}

function findRequestBuckets(value: unknown, parentKey = 'usage'): Array<{ key: string; used: number; limit: number }> {
  if (!isRecord(value)) {
    return [];
  }

  const used = firstNumber(value, ['numRequests', 'requestsUsed', 'usedRequests', 'used', 'usage']);
  const limit = firstNumber(value, ['maxRequestUsage', 'requestLimit', 'maxRequests', 'limit', 'total']);
  const found: Array<{ key: string; used: number; limit: number }> = [];

  if (used !== undefined && limit !== undefined) {
    found.push({ key: parentKey, used, limit });
  }

  for (const [key, child] of Object.entries(value)) {
    if (isRecord(child)) {
      found.push(...findRequestBuckets(child, key));
    } else if (Array.isArray(child)) {
      child.forEach((item, index) => found.push(...findRequestBuckets(item, `${key} ${index + 1}`)));
    }
  }

  return found;
}

function renderSnapshot(snapshot: UsageSnapshot) {
  const displayFormat = getConfig<DisplayFormat>('displayFormat', 'remaining');
  const value = formatSnapshotValue(snapshot, displayFormat);
  statusBar.text = `$(pulse) Cursor ${value}`;
  statusBar.tooltip = buildTooltip(snapshot);
  statusBar.backgroundColor = undefined;

  const warning = getConfig<number>('warningRemainingPercent', 20);
  const critical = getConfig<number>('criticalRemainingPercent', 10);

  if (snapshot.percentRemaining !== undefined && snapshot.percentRemaining <= critical) {
    statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else if (snapshot.percentRemaining !== undefined && snapshot.percentRemaining <= warning) {
    statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }
}

function formatSnapshotValue(snapshot: UsageSnapshot, displayFormat: DisplayFormat): string {
  if (displayFormat === 'percent' && snapshot.percentRemaining !== undefined) {
    return `${Math.round(snapshot.percentRemaining)}% left`;
  }

  if (displayFormat === 'fraction' && snapshot.limit !== undefined) {
    return `${formatUsageValue(snapshot.used, snapshot.unit)} / ${formatUsageValue(snapshot.limit, snapshot.unit)}`;
  }

  if (snapshot.remaining !== undefined) {
    return `${formatUsageValue(snapshot.remaining, snapshot.unit)} left`;
  }

  return `${formatUsageValue(snapshot.used, snapshot.unit)} used`;
}

function buildTooltip(snapshot: UsageSnapshot): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.isTrusted = false;
  tooltip.appendMarkdown('**Cursor Monthly Usage**\n\n');
  tooltip.appendMarkdown(`Source: ${snapshot.source}\n\n`);
  if (snapshot.label) {
    tooltip.appendMarkdown(`Bucket: ${snapshot.label}\n\n`);
  }
  tooltip.appendMarkdown(`Used: ${formatUsageValue(snapshot.used, snapshot.unit)}\n\n`);
  if (snapshot.limit !== undefined) {
    tooltip.appendMarkdown(`Limit: ${formatUsageValue(snapshot.limit, snapshot.unit)}\n\n`);
  }
  if (snapshot.remaining !== undefined) {
    tooltip.appendMarkdown(`Remaining: ${formatUsageValue(snapshot.remaining, snapshot.unit)}\n\n`);
  }
  if (snapshot.periodStart) {
    tooltip.appendMarkdown(`Period start: ${snapshot.periodStart}\n\n`);
  }
  if (snapshot.periodEnd) {
    tooltip.appendMarkdown(`Period end: ${snapshot.periodEnd}\n\n`);
  }
  tooltip.appendMarkdown(`Refreshed: ${snapshot.refreshedAt.toLocaleString()}`);
  return tooltip;
}

function renderError() {
  statusBar.text = '$(warning) Cursor usage';
  statusBar.tooltip = lastError ?? 'Cursor monthly usage refresh failed';
  statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
}

function setLoading() {
  statusBar.text = '$(sync~spin) Cursor usage';
  statusBar.tooltip = 'Refreshing Cursor monthly usage';
  statusBar.backgroundColor = undefined;
}

async function showDetails() {
  if (!lastSnapshot) {
    const action = await vscode.window.showInformationMessage(lastError ?? 'No Cursor usage data yet.', 'Refresh');
    if (action === 'Refresh') {
      await vscode.commands.executeCommand('cursorMonthlyUsage.refresh');
    }
    return;
  }

  const lines = [
    `Source: ${lastSnapshot.source}`,
    lastSnapshot.label ? `Bucket: ${lastSnapshot.label}` : undefined,
    `Used: ${formatUsageValue(lastSnapshot.used, lastSnapshot.unit)}`,
    lastSnapshot.limit !== undefined ? `Limit: ${formatUsageValue(lastSnapshot.limit, lastSnapshot.unit)}` : undefined,
    lastSnapshot.remaining !== undefined ? `Remaining: ${formatUsageValue(lastSnapshot.remaining, lastSnapshot.unit)}` : undefined,
    lastSnapshot.percentRemaining !== undefined ? `Percent remaining: ${Math.round(lastSnapshot.percentRemaining)}%` : undefined,
    lastSnapshot.periodStart ? `Period start: ${lastSnapshot.periodStart}` : undefined,
    lastSnapshot.periodEnd ? `Period end: ${lastSnapshot.periodEnd}` : undefined,
    `Refreshed: ${lastSnapshot.refreshedAt.toLocaleString()}`,
    ...lastSnapshot.rawHighlights
  ].filter((line): line is string => Boolean(line));

  await vscode.window.showQuickPick(lines, {
    title: 'Cursor Monthly Usage',
    placeHolder: 'Current usage details'
  });
}

function formatUsageValue(value: number, unit: UsageSnapshot['unit']): string {
  if (unit === 'currency') {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(value / 100);
  }

  return new Intl.NumberFormat().format(Math.round(value));
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
  if (url.protocol !== 'https:') {
    throw new Error('cursorMonthlyUsage.apiBaseUrl must use HTTPS.');
  }

  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url;
}

async function discoverCursorToken(): Promise<string | undefined> {
  const dbPath = cursorStateDbPath();
  if (!dbPath || !existsSync(dbPath)) {
    return undefined;
  }

  try {
    const SQL = await loadSqlJs();
    const buffer = await readFile(dbPath);
    const db = new SQL.Database(new Uint8Array(buffer));
    try {
      const result = db.exec("SELECT key, value FROM ItemTable WHERE key LIKE '%cursorAuth%'");
      const values: Record<string, unknown> = {};
      for (const row of result[0]?.values ?? []) {
        const [key, value] = row;
        if (typeof key === 'string') {
          values[key] = value instanceof Uint8Array ? new TextDecoder().decode(value) : value;
        }
      }
      return extractToken(values);
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

function loadSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJs) {
    const wasmDir = path.dirname(require.resolve('sql.js/dist/sql-wasm.js'));
    sqlJs = initSqlJs({ locateFile: (file) => path.join(wasmDir, file) });
  }
  return sqlJs;
}

function cursorStateDbPath(): string | undefined {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    return appData ? path.join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb') : undefined;
  }
  return path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

function extractToken(values: Record<string, unknown>): string | undefined {
  const exact = values['cursorAuth/accessToken'];
  const exactToken = tokenFromUnknown(exact);
  if (exactToken) {
    return exactToken;
  }

  for (const [key, value] of Object.entries(values)) {
    if (!key.toLowerCase().includes('token')) {
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
  if (typeof value !== 'string') {
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
  for (const key of ['accessToken', 'token', 'sessionToken', 'jwt']) {
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
  const interestingKeys = ['onDemand', 'spend', 'team', 'hardLimit', 'usageLimit'];

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
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  try {
    return JSON.stringify(value).slice(0, 140);
  } catch {
    return '[object]';
  }
}

function findObjectByKey(value: unknown, keyName: string): Record<string, unknown> | undefined {
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
    if (typeof found === 'number' && Number.isFinite(found)) {
      return found;
    }
    if (typeof found === 'string') {
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
    if (typeof found === 'string' && found.trim()) {
      return found.trim();
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getConfig<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('cursorMonthlyUsage').get<T>(key, fallback);
}
