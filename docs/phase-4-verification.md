# Phase 4 verification

This document records verification history from Windows on 16 November 2026 with the actual Tauri WebView2 application and installed Forge 2.0.13. The completed grouped-browser, shared-policy, automatic-sync, expansion-calendar, cold-start, and production-preservation checks are described first. Older checks below apply to the builds described, including features later removed from the interface.

## Current revision

The canonical rules are [src-tauri/league-rules.json](../src-tauri/league-rules.json). The latest implementation uses 12 starting packs, four weekly packs, four common and two uncommon wildcards weekly, one rare every two weeks, one mythic every four weeks, and 15 pack slots of 10 common / 4 uncommon / 1 rare-or-mythic / 0 basic lands. The shared start is Unix time `1794801597`. Joining later grants all elapsed scheduled rewards; existing players receive due periods automatically, once each. Cadence grants count shared calendar boundaries, so a week-1 claim followed by a week-2 claim awards the first rare correctly.

The same configuration supplies the week-0 Foundations pool and 13 later expansions at weeks 4 through 52. Each later unlock grants eight additional packs reserved for its expansion. Migration 007 stores assigned sets in a persistent earned-order pack queue. Starting, weekly, and reserved expansion packs open chronologically, including multiple expansions in one Open all request. Settings renders the exact full-name/theme schedule read-only. The dashboard displays full unlocked names, the next unlock date and bonus, or an alert when no future expansion is scheduled.

Current behavior:

- The upright Vintage Masters Black Lotus banner retains all five Mox cards and has no caption. Dashboard wildcard rarity colors appear on consistent dots, with dark readable text and rarity/count tooltips. Booster actions always say **Open boosters**.
- Daylight with Larger text is fixed by frontend and native normalization. Theme CSS remains in the source, while Appearance controls are removed. Settings keeps the three Forge paths and read-only built-in league rules; no maintenance or manual catalog controls return.
- Collection puts full unfiltered Owned/All totals in the view buttons and compact wildcard balances on the right of the same toolbar. There is no separate wildcard strip, instructional caption, or redundant result counter. Two base-scope page-size-one count requests run per data revision and are not repeated for search keystrokes.
- Owned identity quantities are pooled across expansions. An owned card can use any eligible printing from a globally unlocked expansion without collecting it separately in that expansion. Basic lands remain free and unlimited from globally unlocked sets. Novelty and fractional-cost printings remain excluded without deleting historical rows.
- Card details shows `N owned`, rules, and printing metadata beneath the artwork. Only a small **Printing** button is offered when multiple choices exist. There is no dropdown, expansion-unlock list, or card-specific acquisition explanation. Ownership and choices refresh after crafting, while the pooled four-copy crafting cap and actual global set gate remain enforced.
- DeckBuilder has no separate printing links or cached printing-menu state. Its full card-details callback changes every copy of the selected Oracle identity across main deck and sideboard; the same callback changes the explicit printing in Collection's Add flow. Collection's own details only changes its preview. Details, the picker, and target dialogs are centered body portals and remain visible above a hidden DeckBuilder.
- Save and Copy still synchronize stable managed Forge files, including owned incomplete drafts. Density, shared filters, background browser updates, draft preservation, and one selected printing per Oracle identity remain in place.
- Booster packs shows the total openable count, wildcard balances, **Open one pack**, and **Open all**, followed by real results and history. Starting and due weekly/expansion rewards are automatic. Expansion choice, manual join/claim controls, separate general/set balances, and disabled next-reward panels are removed. Actual interrupted receipts retain their recovery action.
- Catalog setup remains automatic and append-only for missing printings on detected Forge-version changes. Existing metadata, progression, decks, and artwork caches are retained; an unchanged Forge version does not refetch the full catalog.

### Current automated and live preview checks (94-test build)

- The production TypeScript/Vite build and **all 94 native tests** passed. Seven added queue tests cover earned chronology, automatic accrual, multi-set Open all above 100 packs, atomic failure rollback, receipt replay/mode checks, and legacy opener compatibility. Two clock tests cover bounded explicit development preview and release builds ignoring preview values.
- Migration [007_pack_queue.sql](../src-tauri/migrations/007_pack_queue.sql) records each queue entry's assigned set, source, earned period, priority, and remaining quantity. Count `1` opens the next pack; count `0` atomically opens all remaining entries in order. Legacy set-specific pending receipts still replay through their original API against compatible shared balances.
- `ETERNAL_LEAGUE_PREVIEW_WEEKS=4` affects only the debug build's league clock. It leaves the shared anchor and operating-system clock unchanged, and release builds ignore it. The preview workflow uses an isolated `com.eternalleague.preview` clone of the normal profile with separate workspace Forge exports; original rewards and deck files are not preview targets.
- Live QA used an isolated clone of the **current** normal profile: **184 owned cards**, **37 wildcards**, and **one Test deck with nine rows and 11 main-deck cards**. This reflects later user deck edits; earlier smaller-deck audits below remain historical records.
- At four preview weeks, Foundations and Bloomburrow were globally unlocked. Status automatically granted **24 packs** (16 weekly plus eight expansion bonus packs) and showed **25 common / 18 uncommon / 12 rare / nine mythic wildcards**, totaling **64**.
- Collection showed unfiltered counts of **119 Owned / 32,668 All**, unchanged while searching, with wildcard balances on the right of the same toolbar. The whole toolbar remained on one row at both 1920 and 980 pixels without overflow. Only rarity dots were colored; text used the same dark foreground. Daylight/Larger text remained fixed with no Appearance controls. The common-rarity dot uses dark charcoal in Daylight and is shared with the Collection display.
- Details showed printing metadata and the small **Printing** button beneath the artwork, a simple **1 owned**, and no expansion-unlock label. An uncollected Bloomburrow Banishing Light #1 printing was selectable and could be saved to a deck through details. No separate deck printing controls remained. Card names and mana costs had matching top positions at 1920 and 980 pixels, without overflow.
- Booster packs initially displayed exactly the two opening actions, with no expansion choice, weekly controls, or dropdown. **Open one pack** opened Foundations first; **Open all** then opened the remaining **23 packs: 11 Foundations and 12 Bloomburrow**, yielding **345 cards**. Replaying the count-zero receipt had no further effects. All 24 new history records were retained and the four-copy budget held.
- Collection Add opened nested details and the printing picker through their body portals. Selecting Bloomburrow Forest #280 persisted in the target deck, and the flow stayed in Collection.
- The final clean preview was restored to **184 owned cards**, **24 unopened packs**, **25 common / 18 uncommon / 12 rare / nine mythic wildcards**, and the original Test deck with nine rows and 11 main-deck cards. The under-art printing control with **1 owned** and the booster top block with 24 packs and exactly two opening buttons were checked again in screenshots.
- A fresh safety-backup comparison matched **all 11 original-profile tables exactly**, including settings, migrations, and operation receipts. The original retained **184 cards / 37 wildcards / one Test deck with nine rows and 11 main-deck cards / 120,135 catalog printings**, with SQLite integrity `ok`. Preview rewards, test openings, and exports stayed isolated.
- The final frontend production build passed after the small page-navigation scroll reset and shared light-theme common-dot change. Navigating pages resets scroll to the top; Collection Add stays on Collection. The verified artifacts were `index-DZBVwFa7.css` and `index-DgZKkxBu.js`.

### Earlier interface refinements (85-test build)

The earlier 83-85-test revisions offered Appearance controls and restricted variants by per-card collected expansion. Those rules and manual reward controls are superseded by fixed Daylight/Larger text, globally unlocked printing choices, and automatic chronological rewards. Their historical observations remain below.

The banner now includes all five Mox cards behind Black Lotus, preferring local Vintage Masters printings with catalog fallbacks. The current interface hides printing switches when there are zero or one available variants and keeps the current expansion/collector label visible. Printing pickers and target dialogs are centered and rendered above their parent page. Color pills use swatches with accessible names, the advanced toggle is icon-only, and color/mana controls share one row only in wider filter panels. Deck quantity changes retain browser tiles while availability updates in the background; filter requests use a small delayed loading indicator. The completed 85-test build and real desktop checks below confirm this refinement.

An intermediate browser revision allowed mixed eligible printings within one deck and offered per-copy/one-or-all printing switches. That behavior is superseded by one selected printing per Oracle identity across main deck and sideboard together. Loading an older mixed deck consolidates it to the first loaded printing in the editor; this remains unsaved until **Save deck**.

### Earlier completed browser checks (85-test build)

- On the first DeckBuilder mount of a session, **Add to deck** from Collection loaded and selected an existing saved deck. Confirming **Add** kept Collection visible and displayed the success notice. Measured positions confirmed that card details, the target dialog, and the printing picker were centered horizontally and vertically, including the picker above the target dialog.
- A single-printing Aegis fixture displayed its static expansion/collector label without a switch button. Allocation changes updated the available browser immediately in the background without a replacement finding-cards panel or a busy grid.
- Selecting Llanowar Elves #439 changed all four copies. Selecting Forest #291 updated that card in both main deck and sideboard. The target flow preserved an existing dirty draft and defaulted to its #291 artwork; creating another deck also preserved a separate unsaved draft containing 60 Forests.
- The six-column choice rendered at 1920 pixels and persisted. At the 980-pixel minimum width in Daylight with Larger text, it capped to two columns without horizontal overflow. All five Mox images loaded, stayed upright, and remained partially visible behind Black Lotus at 1920 pixels in Forest and 980 pixels in Daylight with Larger text.
- Collected-expansion regressions verify that an uncollected, globally unlocked second set is hidden and rejected for deck use; collecting one copy unlocks its same-set variants while retaining one pooled copy budget. A live isolated crafting check confirmed that details immediately gains its expansion and enables Add to deck after first acquisition, other uncollected cards stay locked, and free basic lands remain available. The fixture was restored afterward.

- The integrated TypeScript/Vite production build and **all 85 native tests** passed. Added coverage includes grouped Oracle totals and pagination, pooled printing budgets, eligible owned facets and creature suggestions, consistent novelty exclusion without deleting owned rows, eligibility-cache maintenance, and Forge-version extension behavior.
- Checks in the actual Tauri WebView2 application covered 980- and 1920-pixel widths, Forest, and Daylight with Larger text. The grouped browser, card details, unlocked printing controls, and responsive deck layout were checked in the desktop app.
- The installed Forge **2.0.13** strict checker passed the newly saved 60-card main deck and 15-card sideboard, verifying all **75 requested exact-printing copies**, including Llanowar Elves #439 and Forest #291. The developer script now preloads Forge's card scripts before resolving editions and collector numbers. This verifies the real parser and printing support, without simulating gameplay.
- Migration [006_catalog_eligibility.sql](../src-tauri/migrations/006_catalog_eligibility.sql) adds derived eligibility and a browsing index. A normal-profile native IPC check of the full **120,135-printing** catalog returned **32,668 grouped cards in 627 ms** and owned facets in **299 ms**. A separate development-copy benchmark measured one-time cold eligibility backfill at about **18 seconds**. Imported rows maintain the derived cache, and later browsing reuses the local index.
- Automatic setup with an unchanged detected Forge version does not refetch the full catalog. Existing metadata, owned rows, saved decks, rewards, and artwork caches remain preserved.

### Earlier finishing checks (62-75-test builds)

These results belong to the revisions named below. The current pooled ownership and novelty policy above supersedes earlier exact-printing ownership and half-step filter behavior.

- The modern VMA #4 banner loaded its actual 488×680 artwork. At 980, 1440, and 1920 pixels, its transform and perspective were `none`, image fit was `contain`, and the card stayed within the banner without horizontal overflow. Daylight with larger text also fit at 980×700. The frontend build and all 75 native tests passed; isolated fixture data and preferences were restored afterward.
- The collection-search update passed the frontend build and **75 native tests**. All five requested examples (`draw a card`, `flying`, `destroy target creature`, `gain life`, `deathtouch`) returned rules-text matches in the actual desktop UI. Regression tests also cover names, whitespace/case, multi-face rules, filter combinations, pagination totals, and literal search punctuation. Searches do not modify catalog or collection data.
- Daylight success notices now use a light green surface with dark green text; measured text/background contrast was 9.33. Error notices also use a light-theme palette (measured contrast 7.09). The real Appearance save notice and invalid-folder error were visually checked, then isolated preferences were restored.
- The deck-management revision passed the frontend build and **72 native tests**. Its added coverage checks wildcard cadence, missed claims/late joins, tracked-file migration, deletion, collisions, SQL failure rollback, recovery-path reporting, and rejection of stale folder settings.
- Actual native window sizes of 980×700, 1440×940, 1920×1080, and 2560×1440 matched the WebView viewport without horizontal overflow. The content width has no fixed cap. Deck tiles used three columns at 1920 pixels and four at 2560 pixels. A maximized native window and WebView both measured 1920×1009.
- Theme changes and Larger text persisted after a reload. Larger text increased a 26-pixel heading to 30.68 pixels. The Daylight layout fit the 980-pixel minimum width; its shared card-details modal fit within 980×700 and displayed the complete rules and ownership information.
- Live Copy deck created a distinct Forge file in the app subfolder. Deleting that copy removed the file and its ownership mapping, preserving collection and wildcard totals. Repeated saves reused one path. Forge 2.0.13 parsed the subfolder's 60/15 deck and verified all 75 exact-printing copies. The isolated database was restored after the checks.
- Earlier shared-policy checks passed the production build and **62 native tests**, including fixed-rule, shared-schedule, cold-start helper, and portable-installation cases.
- The isolated live catalog contained **302 printings**. Repeating automatic catalog setup left that count unchanged. A tampered per-user weekly-pack value of 999 was read back as the built-in value of 4.
- The dashboard displayed the **LEA Black Lotus** artwork. Settings showed all three required Forge paths as detected and rendered all 14 expansion rows with their configured themes, without editable rule inputs.
- Saving the same deck twice updated one managed Forge file. Copy deck created its own second file. An incomplete draft containing one owned M15 Elvish Mystic saved to a third Forge file. These saves did not change collection ownership or wildcard balances.
- The installed Forge **2.0.13** Java parser passed the automatically saved 60/15 deck, including all **75 exact printing copies**. This checks parser/support/printing compatibility; it does not simulate gameplay.
- A dashboard render fixture at calendar week 52 showed all 14 unlocked expansion names and the no-upcoming-expansion alert. The operating-system clock was not changed. The layout fit the 980-pixel minimum width without horizontal overflow.
- The Collection wildcard separator and unbracketed mana display were checked. Formatting preserved `1R` and converted the half-white symbol `HW` to `½W`. Crafting the actual FDN Banishing Light printing added one owned copy and spent one common wildcard.
- The isolated test database was restored to its pre-test baseline afterward.

### Earlier normal-profile audit (schema 6)

The final schema-6 normal-profile audit after startup preserved the collection, decks, deck cards, wildcards, league state, opening history, per-set pack balances, expansion reward claims, and captured app/export settings. The totals remained **184 owned cards**, **37 wildcards**, **one Test deck**, and **120,135 catalog printings**. SQLite integrity was `ok`. The normal app reopened without a debugging listener, with port 9222 closed.

An earlier read-only schema-6 inspection also confirmed Foundations in owned facets, a pooled total of two Llanowar Elves, and available Foundations variants #227, #429, and #439. That earlier normal-app restart had no debugging listener, with port 9222 closed.

### Earlier preservation and offline audits

- [x] An earlier normal-profile audit preserved deck contents, wildcards, packs, claim periods, expansion balances, and opening history. The only ownership change was one requested DOM #168 Llanowar Elves, alongside FDN #227 (two copies total). The catalog stayed at 120,135 printings, with no nonbasic card above four copies and SQLite integrity `ok`. The existing Test deck was synced into `constructed/Eternal League`; three known Integration Test exports were archived outside Forge, while both unrelated pre-existing decks were preserved.
- [x] Cold first-run with an empty isolated database and an unreachable process-local proxy displayed Retry setup. The catalog remained empty, and the banner could not create a misleading single-card catalog. Beginning the league twice granted the 12 starting packs once. Windows network settings were unchanged.
- [x] The normal production database was compared with its saved snapshot after startup and migration 005. Collection quantities, saved decks and deck cards, packs, wildcard balances, claim periods, and opening history matched exactly. All 120,135 catalog printings and 183 owned cards were preserved. The normal app was reopened with no debugging listener.
- [x] Shared week boundaries schedule a status refresh even when an earlier weekly reward is still unclaimed, so scheduled expansion unlocks continue updating while the app remains open.

## Earlier automated checks

- TypeScript and Vite production build passed.
- All 46 Rust tests passed without warnings.
- Tests cover configurable deck restrictions, unlimited Basic Land ownership/copy exceptions, default pack migration, Forge version detection, and the existing collection/progression behavior.
- Maintenance tests cover consistent backups including committed WAL data, restore schema and migration validation, upgrading compatible older backups, transactional rollback, and image-cache containment.
- Restore coordination prevents catalog imports and native data mutations from racing with maintenance.
- Four-copy collection protection is enforced across Oracle IDs in both crafting and complete multi-pack transactions. Tests cover concurrent competition for the fourth copy, rejected crafting without spending wildcards, rarity-preserving replacement wildcards, empty-card opening history, and legacy receipt/history compatibility.

## Earlier live interface checks

Those earlier checks used the isolated `com.eternalleague.verification` database with 284 real M15 printings. The normal league database and Forge files are kept separate from destructive test actions.

- One pack immediately displayed all 14 nonland cards and saved the opening once. No sequential reveal controls were required.
- Clicking Typhoid Rats opened the shared Collection details popup with its Deathtouch rules and current owned quantity.
- The saved test deck showed unlimited basic lands. The deck list and right-hand card browser now open the same full details popup used by Collection and booster results.
- Forge 2.0.13 and its installation folder were detected and displayed.
- The interface no longer displays phase progress or About the league.
- Native queries include unowned Basic Land printings in the deck builder while retaining the Collection ownership filter.

That earlier cleanup used one compact page title with relevant actions and moved catalog controls to Application settings. Collection quantities are earned through booster openings and crafting. Manual ownership controls and the league-reset feature were removed, including their native commands. League status and statistics refresh on app focus, visibility changes, and the next weekly reward deadline. The sidebar promotion, top workspace bar, and footer remain removed; the welcome banner has since been restored as described below.

The four-copy policy was also verified in the live isolated app with an M14 Elvish Mystic printing while four M15 copies were owned. The M14 printing remained unowned, its crafting button was disabled, and a direct crafting request was rejected without spending a wildcard. A test pack containing ten common slots from the completed M14 pool awarded ten common wildcards and no cards, with the same rewards recorded in history. Opening two more packs awarded twenty common wildcards while retaining four total copies; replaying that request returned the same receipt without spending or granting again. Reward history fit the 980-pixel minimum window width. The isolated database, catalog, settings, and progression were restored to their pre-test snapshot afterward.

Earlier cleanup smoke checks confirmed the shared full-size popup opens from an Elvish Mystic deck entry, Collection contains no catalog-management or manual quantity controls, and Application settings retain the catalog tools without league reset. Crafting Accursed Spirit in the isolated fixture changed ownership from one to two and common wildcards from three to two. The weekly label displays `4 booster packs`. The then-current overview was visually checked at 1440 pixels and the 980-pixel minimum width, with one page heading and no horizontal overflow. The production build and all 37 native tests passed at that stage, before the later four-copy protection checks raised the completed suite to 45 tests.

## Previous ownership and layout revision (46-test build)

The welcome banner uses cached Forge artwork, and the dashboard omits the unique-printings statistic. The main deck list uses compact rows without a fixed empty-list minimum height. The deck picker offers owned printings and free basic lands. Nonbasic quantities across the main deck and sideboard must stay within ownership of the exact printing; native save, duplicate, and export checks enforce this regardless of an older `requireOwnedCards: false` setting. Older invalid decks can still be loaded and corrected, but cannot be saved with missing quantities. The optional ownership setting and local-file catalog import control have been removed.

At that stage, manual catalog refresh, backup/restore, and image-cache cleanup remained in Application settings. These controls and the entire Application section have since been removed. The internal catalog-import engine and maintenance helpers remain useful to native code and isolated test fixtures; they are not normal application controls.

The production build and all 46 native tests passed. In the isolated desktop league, saving an unowned Act on Impulse and using five Elvish Mystic copies split between main deck and sideboard were rejected without changing the existing deck. The deck picker excluded the unowned card; typing five into the four-owned Elvish Mystic row restored the value to four. Basic-land controls stayed available. Two deck rows measured about 44 pixels each, with a 97-pixel list instead of a forced empty area. The welcome banner and its cached Forge artwork were visually checked at 1440 pixels and the 980-pixel minimum width, with no horizontal overflow. Application settings retained Refresh catalog and had no local-file import control; League settings had no optional ownership bypass.

The previous [Phase 2 and 3 verification](phase-2-and-3-verification.md) records actual Forge parsing and all 75 exact printing copies from the saved 60/15 test deck. Existing opening history remains valid across composition changes; the current build now uses the 15-slot shared format documented above.

## Historical backup, restore, and offline checks

- A 2,052,096-byte SQLite backup was created while the app was running. Reusing the filename was rejected, and an invalid JSON file could not be restored; neither failure changed saved data.
- Restoring the backup through the native service recovered exactly 125 unique printings, 271 owned cards, one deck, 16 wildcards, three packs, and 13 opening records. Settings, catalog metadata, and the complete league status matched the saved snapshot. Restore also created a recovery backup. File chooser automation was not used for this check.
- Offline checks used an unreachable proxy only in the isolated app process; Windows network settings were unchanged. Local search, saved-deck loading, collection statistics, and existing Forge artwork remained available.
- The cache-cleanup UI required `CLEAR IMAGE CACHE`. It removed the companion cache while preserving Forge artwork, which remained loadable afterward.
- With an empty test Forge-cache directory, missing artwork produced an unavailable placeholder and Retry button. The shared details popup still displayed the card's rules and ownership. A failed Scryfall refresh preserved the catalog and collection statistics. That earlier build offered local-file import as a fallback; its user-facing control has since been removed.
- Test settings were restored after the offline checks. Destructive maintenance tests never targeted the normal league database or Forge files.

An earlier development build also tested a typed league reset before the restore round trip. That feature and its native endpoint were subsequently removed at the user's request. This historical check documents how the restore fixture was prepared.

## First real release requirement

Before the first real release, reset all DEVELOPMENT test progress in the release baseline and replace the development shared-start timestamp with the real league start. This is a separate deployment task; current normal development data is not automatically wiped by this revision. Keep the production start stable on subsequent updates and preserve player progress.

Do not ship the preview app identifier/configuration or cloned preview database. Release builds ignore `ETERNAL_LEAGUE_PREVIEW_WEEKS`. The isolated preview and its Forge exports remain development artifacts.

## Delivery scope

The app runs locally through `npm run tauri dev`. GitHub release automation, Windows/Linux packaging, signing, and automatic updates remain Phase 5; no release pipeline or updater is claimed by this milestone.
