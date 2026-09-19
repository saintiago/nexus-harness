# HARN-11 Unicode width correction — 2026-09-19

The pane now uses `string-width` to count terminal cells and `Intl.Segmenter` to
truncate only between complete graphemes. It still leaves the final column empty.
ASCII formatting, the ten-entry buffer, redirected text, control sanitization,
and the display's lifecycle are unchanged. The runtime's existing 400-code-unit
summary bound also stops before a complete grapheme would exceed it; full runtime
output still goes to the agent log.

Regression tests reproduce the reviewed 70-cell CJK line at 40 columns and show
why one-row cleanup leaves its first physical row behind. The corrected cases
cover CJK, surrogate-pair emoji, skin tones with ZWJ, families, flags, keycaps and
combining accents at 20, 40 and 80 columns, including exact fits. A wrap-aware
screen checks every redraw across overflow, progress changes, external output
and close. Exact fixture strings and known cell counts supplement the width
library assertions. Existing CLI/adapter tests cover outcomes, cancellation and
logging; no live agent is involved.

## Bounded Windows synthetic check

From this working copy, after `npm run build`, run:

```powershell
node tests/manual/activity-display.mjs
```

Run on Windows (`win32`), Node 24.14.1, PowerShell in an 80 by 24 PTY, with a
40-column pane: exit 0 in approximately five seconds. Each of three synthetic
turns sent 24 wide-text entries, changed the phase to repair, then closed the
pane before printing a synthetic passed/failed/cancelled label and example paths.
Every activity write was asserted to occupy fewer than 40 cells. The captured
Windows terminal trace showed redraws returning to the pane's first row, ten
latest entries, and erasure before the final outcome/path text.

This was a manually invoked synthetic display check, not a live coding run, a
real OS Ctrl+C exercise, or a visual inspection of every Windows font. The PTY
itself was 80 columns; physical wrapping at 40 columns is covered by the focused
regression screen. The width library uses the usual narrow convention for
ambiguous East Asian characters and joined emoji widths; terminals configured
with different Unicode width rules may differ. Resize handling remains outside
this correction.

## Local verification

- `npx vitest run tests/activity.test.ts`: 39 tests passed.
- `npx vitest run tests/activity.test.ts tests/cli.test.ts tests/agent.test.ts tests/source.test.ts`:
  199 tests passed.
- `npm run build`: passed before the Windows display check.
- `node tests/manual/activity-display.mjs`: passed in the Windows PTY described above.
- `npm run validate`: passed formatting, lint, typecheck, build and the full suite
  (20 files; 572 tests passed, 2 existing platform skips).
- `npx prettier --check notes/activity-display-width.md` and `git diff --check`:
  passed for the verification note added after validation started.
