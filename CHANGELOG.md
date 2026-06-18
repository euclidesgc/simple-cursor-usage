# Changelog

All notable changes to this extension are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0]

### Added

- **Daily usage pacing view.** Toggle the status bar between the period total
  and a per-usage-day insight: recommended spend per usage day (dynamic or
  static), your average pace so far, and the daily headroom. Includes the
  command **Cursor Monthly Usage: Toggle Daily / Total View** and the settings
  `usageDays`, `dailyBudgetStrategy`, `defaultView`, and `dailyDisplayFormat`.
- Request timeout (15s) so a hung usage request no longer leaves the status bar
  spinning until the next poll.
- Vitest unit tests for the pacing math (`src/dailyInsight.ts`).

### Changed

- `apiBaseUrl` and `enableLocalTokenDiscovery` are now `machine`-scoped so a
  workspace cannot override them (the session cookie is only ever sent to
  `apiBaseUrl`).
- The total-view status bar format setting is `displayFormat`; the daily view
  has its own `dailyDisplayFormat` (defaults to `inherit`).
- Internal: extracted the pure pacing math into `src/dailyInsight.ts`,
  simplified the usage request, and tightened the TypeScript compiler options.

### Security

- Warn once per session when the resolved API host is not a `cursor.com` origin.

## [0.1.2]

- Initial token fetching and dashboard usage request; status bar with
  `remaining` / `fraction` / `percent` formats, local token discovery, manual
  token storage, automatic refresh, and threshold-based warning colors.
