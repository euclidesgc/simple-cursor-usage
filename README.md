# Simple Cursor Usage

Unofficial Cursor extension that shows monthly usage in the status bar.

Cursor does not publish a stable third-party usage API. This extension calls Cursor-hosted HTTPS endpoints that may change. It is not affiliated with Cursor.

## Features

- Status bar item with remaining monthly usage, fraction used, or percent remaining.
- Details command with billing period and raw fields the API returns.
- Reads the current Cursor access token from the local Cursor `state.vscdb` when possible.
- Optional manual token storage in VS Code SecretStorage.

## Commands

- `Cursor Monthly Usage: Refresh`
- `Cursor Monthly Usage: Show Details`
- `Cursor Monthly Usage: Set Token`
- `Cursor Monthly Usage: Clear Stored Token`

## Development

```sh
npm install
npm run compile
```

Press F5 in Cursor or VS Code to launch the Extension Development Host.

## Packaging

```sh
npm install -g @vscode/vsce
npm run compile
npx vsce package
cursor --install-extension cursor-monthly-usage-0.1.0.vsix
```

## Security

The extension sends a bearer token only to the configured HTTPS `apiBaseUrl` origin. Local discovery opens Cursor's SQLite state database in read-only mode using Python's standard `sqlite3` module and does not store the discovered token.
