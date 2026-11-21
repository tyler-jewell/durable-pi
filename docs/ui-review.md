# Hub UI review

`apps/dpi-playground/scripts/ui-review.mjs` reviews the hub in one run: four widths (desktop 1440, tablet 834, large phone 430, small phone 320), six states each (home, network drawer, inspector, new session, composer focus, extend). Every state gets a screenshot, layout and target measurements, text checks, a color-scheme check, and an axe run. A static check counts fixed-pixel font sizes.

```sh
node apps/dpi-playground/scripts/ui-review.mjs                    # 100% text
node apps/dpi-playground/scripts/ui-review.mjs --text-scale 1.5   # the OS text setting, as the root font size
```

Output goes to the device state directory (`~/.dpi/ui-review/<run>/`): `report.md`, `findings.json`, and a screenshot per width and state. The report groups findings by the Modern Web Guidance guide that owns them, and names the fix for each.

## Result

| Run | Findings | What was left |
|---|---|---|
| Before the batch, 100% text | 704 | 645 targets under the touch size, 41 axe violations, 18 text runs under 12px |
| After the batch, 100% text | 0 | |
| After the batch, 150% text | 0 | |
| After the batch, 200% text | 0 | |

The batch was structural: one shared `system.css` (targets, the touch size as a token, screen-reader utilities), root font size as a percentage, every px font size as its rem equivalent, and wrapping tree rows and tool summaries instead of truncating them. The rem conversion keeps the default rendering: the text wraps at the same points in the same states.

## Known trade-off

At 100% on desktop, a device row's status (`3 sessions`, `no token`) wraps to a second line. The text is readable and nothing is cut, but the row is taller than before. The alternative is a shorter status, or a smaller badge.

## Mobile-small round (320 px)

The 320 px phone had the most cost per pixel: the header took two rows, the breadcrumb three words that the screen could not hold, and the composer a quarter of the height. The review does not measure how pleasant a screen is, so this round read the screenshots as well.

- The top bar is one row of icon buttons with their labels kept for screen readers. The brand name is visually hidden on that row. Compact mode is a container query on the app shell (under 384 px), not a viewport query.
- The breadcrumb keeps the agent's full name and gives the workspace the room. It wraps only at large text.
- The composer's toolbar sits on one line, and its footnote is hidden in compact mode.
- Inactive inspector tabs show their icon only, and the active tab keeps its label.
- A keyboard state tabs to the eighth stop and checks that nothing covers the focused control (WCAG 2.4.11).

Result for mobile-small: 0 findings at 100%, 150% and 200% text, and 0 across the full review at 100%.
