# Weekday Commands audit, 0.1.5

Reviewed 19 September 2026 against 0.1.4. The plugin's small, command-driven design remains appropriate. It does not need a background index, polling, or another runtime library.

## Findings and fixes

| Priority | Finding in 0.1.4 | Change in 0.1.5 |
| --- | --- | --- |
| P1 | Formats such as `YYYY/MM/DD` did not create date-specific parent folders. | Create each missing parent, handling a folder created concurrently by another operation. |
| P1 | Repeated commands could race to create the same note, and the duplicated creation path could retry failed reads or writes unnecessarily. | One creation operation per path; use a note created concurrently by sync or another plugin without overwriting it. Remove the duplicate creation path. |
| P1 | File-open errors could escape command callbacks and leave the modal permanently submitting. | Catch failures, release busy state in `finally`, allow retries, and report errors. |
| P2 | Recent notes allocated a vault-wide markdown list, filtered multiple times, and sorted all matches. | Visit the daily-note folder directly and maintain only the requested newest matches. Descend into subfolders only for date formats containing folders. |
| P2 | Recent-note lookup failed at vault root and could not recognize dates encoded in nested paths. Journal View also parsed only the basename. | Parse the full relative path, handle vault root explicitly, and show readable dates in recent shortcuts. |
| P2 | `next December` always added a year, even when December was still ahead. Loose parsing could roll an invalid date into a different day. Prototype-property input could throw, and huge relative offsets could create invalid dates. | Correct future-month selection, require supported strict calendar formats, check alias ownership, and reject unsafe amounts or invalid timestamps. |
| P2 | The folder setting wrote to disk on every keystroke, with no ordering or failure handling. | Save on committed field changes and serialize independent settings snapshots. Show a notice when a save fails. |
| P2 | The picker lacked a visible submit button, busy feedback, and inline error feedback. Touch-target height was unspecified. | Add Open note, Opening state, disabled controls during submission, live status text, focus outlines, and 44 px minimum control heights. |
| P3 | A deferred focus callback could run after the modal closed; an open modal was not closed on plugin unload. An internal view-setting API was used unnecessarily. | Focus directly, clear modal control references on close, close the active picker on unload, and use the public file-opening API. |

## UI and motion review

The UI stays within Obsidian's native modal, controls, and theme colors. Emil Kowalski's guidance is applied to a frequently used command interface: no added entrance, exit, list stagger, or keyboard animation.

| Before | After | Why |
| --- | --- | --- |
| Enter was the only obvious submission route | Full-width Open note button and Enter submission | Makes the action discoverable and usable on touch devices. |
| A failed operation could leave the picker stuck | Retryable error state with announced status and restored focus | Supports recovery without reopening the command. |
| Nested names could show only a day number | Readable full date on recent-note buttons | Distinguishes dates across months and years. |
| Plugin buttons had no explicit press response | Pointer press scales to 0.98 over 120 ms with `cubic-bezier(0.23, 1, 0.32, 1)` | Brief confirmation with an interruptible CSS transform and no animation library. |
| Touch sizing depended entirely on the theme | 44 px minimum height | Makes the input and buttons easier to use on small screens. |

Transform feedback is enabled only when reduced motion is not requested, and excludes keyboard-visible focus. Native button states still provide feedback with reduced motion. No `will-change`, repeating animations, animation timers, or global listeners are added.

## Resource use and codebase

- Idle: no scheduled callbacks, vault listeners, network activity, or plugin-owned indexing.
- Recent lookup: bounded result storage and no full result sort. Work is proportional to entries in the configured folder or subtree, not unrelated vault folders. A folder-heavy format at vault root can still traverse the vault when opened.
- File reads: template contents use Obsidian's cached read and are only requested when creating a note.
- Settings: disk writes occur on committed edits rather than every keypress. The save queue recovers after a failed write.
- Lifecycle: pending-creation entries are removed on success or failure. Modal DOM and controls are cleared on close.
- Dependencies: no new runtime or animation dependencies. Moment comes from Obsidian; the plugin bundle keeps Obsidian external.
- Release workflow: reruns can upload assets to an existing release. The release is also published and checked directly rather than relying on the workflow to run.

## Validation and limits

`npm run check` passes lint with no warnings, TypeScript checks, the production build, and 42 regression tests. Tests exercise the built plugin with an in-memory Obsidian API substitute: date parsing, nested/root paths, concurrent creation, simulated disk/template failures, integrations and fallbacks, settings write order, modal failure/retry/close behavior, and avoiding unrelated-folder traversal. A clean installation of the locked dependencies reported zero known vulnerabilities.

These are code and automated behavioral checks. The actual Obsidian UI, third-party themes, screen-reader output, phone keyboard, and motion feel were not tested with app controls. Obsidian 1.5.0 compatibility was reviewed against the public APIs used; the tests run against the installed Obsidian type definitions and mocks, not that historical app build. Optional integrations still rely on third-party plugin APIs that may change.

No numerical accessibility or visual-quality score is assigned without rendered host-app evidence. Existing system colors and controls remain the theme authority.
