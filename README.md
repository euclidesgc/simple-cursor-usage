# Cursor Usage for Teams

A VS Code / Cursor extension that shows your **monthly Cursor usage** in the status bar, formatted in **USD**. Values from the Cursor API are reported in cents and displayed as dollars (cents ÷ 100).

**Package:** `cursor-usage-for-teams` · **Version:** `0.1.2`

## Features

- **Status bar** — Shows remaining usage, used/limit fraction, or percent remaining (configurable).
- **Automatic refresh** — Polls usage on a configurable interval (default every 5 minutes).
- **USD formatting** — Converts API cent values to currency via `Intl.NumberFormat` (`en-US`, USD).
- **Local auth discovery** — Reads Cursor's `state.vscdb` with [sql.js](https://sql.js.org/) to find session tokens when you are signed in.
- **Manual token** — Optionally store a session token in VS Code Secret Storage.
- **Warnings** — Status bar background turns warning or error color when remaining usage drops below configured thresholds.
- **Details view** — Click the status bar or run **Show Details** for period, limits, and diagnostic highlights.

## Requirements

- **Editor:** VS Code `^1.90.0` or compatible (including Cursor).
- **Account:** A signed-in Cursor account with access to team/monthly usage data.
- **Network:** HTTPS access to the configured API origin (default `https://cursor.com`).
- **Platform:** macOS, Windows, or Linux (for default `state.vscdb` paths).

## Commands

| Command palette title                    | Command ID                        | Description                                                          |
| ---------------------------------------- | --------------------------------- | -------------------------------------------------------------------- |
| Cursor Monthly Usage: Refresh            | `cursorUsageForTeams.refresh`     | Fetch usage immediately and update the status bar.                   |
| Cursor Monthly Usage: Show Details       | `cursorUsageForTeams.showDetails` | Open a message with usage details; click the status bar to run this. |
| Cursor Monthly Usage: Set Token          | `cursorUsageForTeams.setToken`    | Paste and store a Cursor access/session token in Secret Storage.     |
| Cursor Monthly Usage: Clear Stored Token | `cursorUsageForTeams.clearToken`  | Remove the stored token and refresh using discovery only.            |

## Settings

All settings use the prefix `cursorUsageForTeams.`.

| Setting                     | Type      | Default              | Description                                                                      |
| --------------------------- | --------- | -------------------- | -------------------------------------------------------------------------------- |
| `apiBaseUrl`                | `string`  | `https://cursor.com` | Cursor web API origin for usage requests. Must be HTTPS.                         |
| `pollIntervalSeconds`       | `number`  | `300`                | Background refresh interval in seconds (minimum `60`).                           |
| `displayFormat`             | `string`  | `remaining`          | Status bar format: `remaining`, `fraction`, or `percent`.                        |
| `warningRemainingPercent`   | `number`  | `20`                 | Warning background when remaining usage is at or below this percent (`0`–`100`). |
| `criticalRemainingPercent`  | `number`  | `10`                 | Error background when remaining usage is at or below this percent (`0`–`100`).   |
| `enableLocalTokenDiscovery` | `boolean` | `true`               | Read Cursor `state.vscdb` to discover session token and user id.                 |

### Display formats

- **`remaining`** (default) — e.g. `$42.50 left`, or `$12.00 used` if no limit is known.
- **`fraction`** — e.g. `$57.50 / $100.00` (used / limit).
- **`percent`** — e.g. `43% left` when a limit is available.

## How authentication works

The extension needs a **WorkOS user id** and a **session token** to call the Cursor web API.

### 1. Local discovery (default)

When `enableLocalTokenDiscovery` is `true`, the extension:

1. Locates Cursor's SQLite database `state.vscdb`:
   - **macOS:** `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
   - **Windows:** `%APPDATA%\Cursor\User\globalStorage\state.vscdb`
   - **Linux:** `~/.config/Cursor/User/globalStorage/state.vscdb`
2. Runs `SELECT key, value FROM ItemTable` via sql.js.
3. Merges `cursorAuth/*` keys and searches for access/session tokens (e.g. `cursorAuth/accessToken`).
4. Derives the **WorkOS id** from stored fields, from a `workosId::sessionToken` pair, or from the JWT **`sub`** claim on the session token.

### 2. Stored token (optional)

Run **Cursor Monthly Usage: Set Token** to save a token in VS Code **Secret Storage** (`cursorUsageForTeams.accessToken`). A manually stored token overrides discovery for the session value; WorkOS id can still come from the token format or JWT.

Supported token shapes include:

- Raw JWT session token
- `user_…::jwt` (WorkOS id and session separated by `::`)

### 3. API request

Usage is loaded with:

```http
GET /api/usage-summary
Host: <apiBaseUrl host, default cursor.com>
Cookie: WorkosCursorSessionToken=<encoded session>
```

The response is parsed for plan usage fields (e.g. usedCents, limitCents). Amounts are shown in USD by dividing cent values by 100.

If no session can be resolved, the status bar shows a warning; use Set Token or sign in to Cursor with discovery enabled.

Development
npm install
npm run compile
Open this folder in VS Code or Cursor, press F5 (or choose Run Extension from the Debug panel). The launch configuration compiles TypeScript before starting an Extension Development Host.

Use npm run watch for continuous compilation while developing.

Packaging
Install vsce if needed:

npm install -g @vscode/vsce
From the project root:

npm run compile
vsce package
Install the generated VSIX (version 0.1.3):

code --install-extension cursor-usage-for-teams-0.1.3.vsix
In Cursor, use Extensions: Install from VSIX… from the Command Palette if code is not on your PATH.

Security
Credentials stay local — Session tokens read from state.vscdb are not written to disk by the extension except when you explicitly use Set Token (Secret Storage only).
HTTPS only — apiBaseUrl must use https://; non-HTTPS origins are rejected.
Minimal network surface — The extension calls the configured Cursor origin (default GET https://cursor.com/api/usage-summary) with your session cookie; it does not send usage data elsewhere.
Secrets API — Manually entered tokens use VS Code Secret Storage, not workspace settings or settings.json.
Your responsibility — Tokens grant access to your Cursor account; do not share VSIX bundles or token exports. Disable enableLocalTokenDiscovery if you prefer to supply tokens only via Set Token.
This extension is unofficial and not affiliated with Cursor.
