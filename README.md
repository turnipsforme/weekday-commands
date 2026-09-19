# Weekday Commands

Jump to any upcoming weekday or choose a date without leaving the command palette. Weekday Commands opens the matching daily note and creates it from your Daily Notes template when it does not exist yet.

## Commands

- **Go to daily note by date** opens a focused date picker. It accepts calendar dates, natural-language dates when Natural Language Dates is installed, and shortcuts to your three most recently edited daily notes. Press Enter or use **Open note** to open the date. Failed opens keep the picker available so you can retry.
- **Go to next Sunday** through **Go to next Saturday** opens the next occurrence of that weekday.

Calendar dates are checked strictly, so invalid dates such as `2026-02-29` are rejected. Use `YYYY-MM-DD` to avoid ambiguity in numeric dates. Built-in relative phrases include `in 3 days`, `next week`, and `next December`.

Plain weekday entries such as `Friday` always mean the upcoming occurrence. Today, yesterday, and tomorrow are left out of the recent-note shortcuts.

## Settings

- **Integrate with Journal View** (off by default): sends every Weekday Commands navigation to Journal View, using its normal nearby animation or distant snap. Notes are still created when missing.
- **Daily notes folder**: optionally overrides the Daily Notes plugin folder for Weekday Commands. Edits save when you leave the field. Date formats containing folders, such as `YYYY/MM/YYYY-MM-DD`, are supported.

## Requirements

Configure your preferred date format, folder, and template in Obsidian's built-in Daily Notes plugin or in Periodic Notes (with daily notes enabled). Natural Language Dates and Journal View are optional integrations.

## Privacy

Weekday Commands works locally in your vault. It does not use network services or collect telemetry. There are no recurring timers or vault watchers. Recent notes are looked up only when the picker opens, using the configured folder. Pointer presses use a short CSS transition; reduced-motion preferences are respected.

## Development

Run `npm ci` and `npm run check` for lint, type checking, the release build, and regression tests. Tests use the built plugin with an in-memory Obsidian API substitute and do not access a real vault.
