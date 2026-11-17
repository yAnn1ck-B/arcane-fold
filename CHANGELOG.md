# Changelog

## [0.3.0] - 2026-11-17

- Apply one pack-selection rule to every expansion: reduced weight only for common nonbasic lands, full uncommon/rare/mythic weight, and a usual one-land limit across the whole pack. Higher-rarity lands choose first. Exclude basic lands and prefer different cards within each pack while preserving four-copy protection, complete-rarity wildcard replacements, past openings, and progress.
- Show brief, dismissible success notifications across pages and modals while keeping errors and warnings beside their actions.
- Simplify Collection's Add to deck dialog and reuse the same Wildcards label, rarity dots, counts, and tooltip/accessibility labels in Collection and Booster packs.
- Save deck edits automatically to the app and Forge, with serialized writes and safe retries that avoid duplicate new decks. Remove the Save button and routine save-status label; keep save failures visible with Retry.
- Finish pending deck saves before closing the app, installing updates, or restarting. Keep the app open with recovery actions if a save fails.
- Keep deck selection and renaming together in a compact header, with separate New, Copy, and Delete actions and centered dialogs. Require confirmed names for both New and Copy; suggest an editable copy name and create nothing on Cancel.
- Make Auto responsive to editor width, favoring another column at borderline widths, up to five columns with the card browser open or seven with it collapsed. This includes maximized laptop layouts at 175% Windows scaling. Fixed choices from two through seven keep the exact selected count on resize/maximize, with horizontal scrolling when needed.
- Reduce page-title size and show full expansion names in pack-opening history.
- Guide missing Forge installations into folder settings and resume card-catalog setup after valid folders are saved.
- Find portable Forge installations on the Desktop and other local locations using a bounded search for a verified Forge executable and resource folders.
- Remove the Clear contents button. Replace the revealed pack contents on each opening, keep opening controls available, and clear the reveal automatically when leaving the page; opening history is preserved.
- Resume interrupted pack openings automatically without a separate recovery step, preserving protection against spending a pack twice.
- Mark the current position in the expansion calendar, keep unlocked expansion names in a compact expandable list, and tighten the banner artwork layout.

## [0.2.1]

First public desktop release for Windows and Linux.

- Collect cards through automatic weekly rewards and chronological booster openings, with four-copy protection and wildcards.
- Browse grouped cards with shared search and filters, and use printings from unlocked expansions.
- Build, copy, and save decks directly to an Eternal League folder in Forge.
- Use a fixed shared expansion calendar, Daylight appearance, and larger text.
- Install optional, cryptographically verified updates without losing local collection, decks, settings, or cached artwork.
- Start production with a fresh data profile, separate from development and preview leagues.
- Keep SQL migration checksums identical across Windows and Linux builds.

## [0.2.0]

Unpublished candidate, superseded before release after installer checks found inconsistent SQL migration line endings between platforms.
