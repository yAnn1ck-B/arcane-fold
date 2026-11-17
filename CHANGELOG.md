# Changelog

## [0.3.3] - 2026-11-17

- Grant starting packs and wildcards together on first app use after online verification, without requiring a booster opening. Reuse the existing entitlement ledger so prior grants and spent balances stay intact.
- Verify late-join catch-up for starting, weekly, and unlocked-expansion rewards through the same first-use path.
- Move the read-only expansion calendar into its own Settings tab.
- Keep routine update rechecks quiet while an already-verified session is current. Startup verification, failed checks, and detected updates still require attention.

## [0.3.2] - 2026-11-17

- Open the app maximized by default.
- Reuse the preloaded database and retry temporary startup locks quietly, keeping the loading screen visible until the league opens. Show an actionable message only if the database remains busy.

## [0.3.1] - 2026-11-17

- Require successful online version verification before production league use, with checks at startup, focus/reconnect, and every five minutes. Only a confirmed current version unlocks the league; remove Later/dismiss bypasses.
- Keep offline/check, download/signature, installation, and restart failures blocked with retry actions. Retain separate explicit download/install/restart steps and cryptographic verification.
- Limit recovery while blocked to current-deck and Forge-folder repair needed to finish pending autosaves. Development/preview builds bypass the production gate.
- Published 0.3.0 still uses optional updates and needs one ordinary upgrade to adopt this policy. These client-side checks do not guarantee simultaneous versions across every device.
- Wait and retry when another database writer temporarily blocks catalog finalization, without parsing or downloading the catalog again. Avoid a redundant first-setup eligibility update and defer competing progress refreshes until the import finishes. Show the final catalog-saving stage explicitly.
- Set starting boosters to 20 and weekly boosters to 6. Grant 10 common, 5 uncommon, 2 rare, and 1 mythic wildcard at the start; retain the existing weekly wildcard schedule.
- Bring existing leagues up to the revised reward totals once, preserving spent packs, card ownership, decks, history, and chronological pack rewards.

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
