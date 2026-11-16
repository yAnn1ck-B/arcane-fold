# Phase 4 verification

This document records verification history from Windows on 16 November 2026 with the actual Tauri WebView2 application and installed Forge 2.0.13. The completed shared-policy, automatic-sync, expansion-calendar, cold-start, and production-preservation checks are described first. Older checks below apply to the builds described, including features later removed from the interface.

## Current revision

The canonical rules are [src-tauri/league-rules.json](../src-tauri/league-rules.json). The latest implementation uses 12 starting packs, four weekly packs, four common and two uncommon wildcards weekly, one rare every two weeks, one mythic every four weeks, and 15 pack slots of 10 common / 4 uncommon / 1 rare-or-mythic / 0 basic lands. The shared start is Unix time `1794801597`. Joining later grants all elapsed scheduled rewards; existing players claim all unclaimed periods once. Cadence grants count shared calendar boundaries, so a week-1 claim followed by a week-2 claim awards the first rare correctly.

The same configuration supplies the week-0 Foundations pool and 13 later expansions at weeks 4 through 52. Each later unlock grants eight additional packs reserved for its expansion. General and per-set balances are separate, and an opening can spend only general packs plus its selected set's reserved packs. Settings renders the exact full-name/theme schedule read-only. The dashboard displays full unlocked names, the next unlock date and bonus, or an alert when no future expansion is scheduled.

Current behavior:

- The banner prefers Vintage Masters Black Lotus (#4). It displays the full face upright without perspective or stretching. The dashboard has no League settings button or unique-printings statistic.
- Settings contains the three required Forge paths, read-only league rules, and Appearance preferences. Forest, Midnight, Slate, and Daylight themes and Standard/Larger text are saved locally. The app version appears subtly beneath Forge's connection status. Application maintenance, manual catalog, backup/restore/cache, integration-test, cached-artwork-test, and test-export controls are removed.
- Catalog setup runs automatically; detected Forge-version changes append only missing printings while preserving existing rows, progression, decks, and artwork caches.
- Save deck and Copy deck synchronize stable managed Forge files automatically, including owned incomplete drafts. The files live under the configured Constructed folder's `Eternal League` subfolder. Startup migrates tracked files without re-exporting invalid drafts; distinct superseded versions are archived with non-`.dck` extensions. Delete removes tracked active/archived/previous-folder files. There is no manual export button or export preference.
- Decks use readable artwork tiles with a read-only quantity and +/- controls. Direct quantity inputs and move-between-section buttons are removed. Exact-printing ownership and free basic lands remain enforced.
- Mana displays without braces, including half-mana symbols. The mana-value filter retains half steps because Little Girl and other Un-set cards have fractional mana values. A separator divides wildcard balances from the collection cards.

### Completed checks

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

### Final audits

- [x] Latest normal-profile audit preserved deck contents, wildcards, packs, claim periods, expansion balances, and opening history. The only ownership change was one requested DOM #168 Llanowar Elves, alongside FDN #227 (two copies total). The catalog stayed at 120,135 printings, with no nonbasic card above four copies and SQLite integrity `ok`. The existing Test deck was synced into `constructed/Eternal League`; three known Integration Test exports were archived outside Forge, while both unrelated pre-existing decks were preserved.
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

Further testing uses the isolated `com.eternalleague.verification` database with 284 real M15 printings. The normal league database and Forge files are kept separate from destructive test actions.

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

## Delivery scope

The app runs locally through `npm run tauri dev`. GitHub release automation, Windows/Linux packaging, signing, and automatic updates remain Phase 5; no release pipeline or updater is claimed by this milestone.
