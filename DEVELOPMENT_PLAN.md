# Eternal League: Development Plan

This plan reflects the current product direction. The canonical shared rules are [src-tauri/league-rules.json](src-tauri/league-rules.json). Earlier phase checklists record development milestones; removed test and maintenance controls are historical. Latest verification is tracked in [the finishing notes](docs/phase-4-verification.md).

## 1. Overview

Build a Windows desktop application that works alongside **MTG Forge**.

The application manages a permanent Magic: The Gathering card collection. Users open booster packs, collect cards, earn wildcards, craft specific cards, and build decks that can be played in Forge.

Forge handles gameplay. Our application handles everything related to collecting cards and building decks.

**Technology:**

- Tauri 2 for the Windows desktop application
- React + TypeScript for the frontend
- Tailwind CSS + shadcn/ui for the interface
- SQLite for local storage
- Scryfall for card information
- Forge's existing image cache for card artwork
- GitHub Actions + Releases for builds and automatic updates

Everything runs locally. No server, login, multiplayer, credits, or trading system.

## 2. Forge Integration

Detect and check Forge automatically during setup and when configured paths change. Show the connection status in the sidebar and per-input detection status in Settings.

Settings has three required Forge paths:

- Forge installation folder containing its resources and application.
- Constructed-deck folder, normally `%APPDATA%\Forge\decks\constructed`.
- Card-image cache, normally `%LOCALAPPDATA%\Forge\Cache\pics\cards`.

Populate the installation path directly in its input and show the detected version with that path's status. Do not expose a separate parent Forge-data-folder input, integration-test button, cached-artwork test, test-deck export, or redundant folder-status summary.

### Card images

Check Forge's existing cache first. Download missing artwork on demand and retain it in the companion cache. Share a newly downloaded image into Forge only when its exact filename is known, without overwriting existing artwork. Handle alternate printings, double-faced cards, and different set artwork. Never clear downloaded images as part of catalog or Forge-version updates.

The dashboard banner prefers the modern Vintage Masters Black Lotus, displayed upright with the full card proportions preserved. Show all five Mox cards behind it: Pearl, Sapphire, Jet, Ruby, and Emerald. Prefer locally cataloged Vintage Masters printings and use eligible catalog fallbacks or fetch missing banner metadata without granting ownership.

### Deck saving

Every successful **Save deck** writes the deck locally and to Forge. **Copy deck** also creates a managed Forge deck. Repeated saves update that deck's stable managed file; unrelated Forge files are not overwritten. Keep main deck, sideboard, names, and exact printings.

Owned incomplete decks may be saved to Forge as drafts. Nonbasic quantities across both sections must stay within pooled Oracle ownership, and every selected printing must be eligible and globally unlocked; collection ownership is pooled across expansions. Report sync failures honestly. There is no separate Export to Forge button or automatic-export preference.

The application does not need to launch or control Forge.

## 3. Local Database

Keep SQLite simple.

Suggested tables:

| Table             | Purpose                                                 |
| ----------------- | ------------------------------------------------------- |
| `cards`           | Scryfall card and printing metadata                     |
| `collection`      | Owned printing ID and quantity                          |
| `decks`           | Saved deck names and information                        |
| `deck_cards`      | Cards belonging to each deck                            |
| `wildcards`       | Available wildcards by rarity                           |
| `booster_history` | Previously opened boosters and contents                 |
| `settings`        | Local Forge paths, sync state, and internal persistence |

Use Scryfall printing IDs to identify individual card printings, with Oracle IDs to recognize reprints of the same underlying card.

Store booster contents as JSON in the history table to avoid unnecessary database complexity.

No user accounts, trade records, wallet transactions, or multiplayer tables.

Use basic SQLite transactions to ensure booster rewards and wildcard crafting are saved correctly.

## 4. Application Features

### A. Dashboard

Show:

- Total owned cards
- Saved deck count
- Available booster packs
- Available wildcards
- Current unlocked sets
- Next weekly reward
- Recently created decks

Provide quick actions for opening boosters and building decks.

Show Black Lotus in the welcome banner without an artwork caption. Use colored rarity dots with tooltips and dark readable wildcard text on the dashboard. Display full unlocked expansion names, the next expansion unlock date and reserved-pack bonus, and an alert when the shared schedule has no upcoming expansion. Use week 0 for the starting pool. Keep page headers compact, omit the unique-printings statistic, and do not add a dashboard League settings button.

### B. Collection Browser

Display cards in a visual artwork grid grouped by Oracle identity. Use one tile and one pooled owned total per card across all printings; omit set-code summaries from grouped tiles. Collection quantities come from booster openings and wildcard crafting, with no manual ownership controls.

Provide a toggle between **Owned Cards** and **All Cards**. Both Collection and Deck builder use shared controls:

- Search card names and rules text, including multi-word ability phrases.
- Multi-select color pills and mana-value pills for existing values 0 through 5, plus a 6+ bucket.
- Rarity and full expansion-name dropdowns drawn from the actual eligible pool.
- A dropdown of main card types, such as Creature, Instant, Artifact, and Land.
- A searchable creature-type combobox that requests suggestions only after two characters.

Owned-view choices use actual eligible owned cards plus basic lands from unlocked expansions. Facet choices remain available across active filter selections. The deck browser keeps search, swatch-only color pills, and mana visible while its advanced controls start collapsed behind an icon-only toggle. Color and mana groups align horizontally in wider filter panels and stack in the narrow browser. Keep browser tiles visible while deck quantity changes refresh availability in the background. Use a small delayed loading indicator for filter requests.

Collection's Owned/All buttons include the full unfiltered grouped totals, with compact wildcard balances on the right of the same toolbar. Remove the separate wildcard strip, instructional hints, and redundant result counter. Fetch the two base-scope totals once per data revision with page size one, independently of search keystrokes.

Clicking a card opens the shared full modal with artwork, rules, and a simple `N owned` count. Put static expansion/collector/rarity metadata beneath the artwork, plus a small **Printing** button only when multiple eligible printings exist. Do not show an expansion-unlock list, dropdown, or per-card acquisition explanation. Owning a card enables any eligible printing from globally unlocked expansions, while all copies share one pooled owned budget. Basic lands are free and unlimited through eligible globally unlocked printings.

In Collection, changing a printing changes only the preview. In Deck builder, the same details callback changes every copy of that card across both sections. Card details, the printing picker, and target dialogs are centered body portals, including when DeckBuilder is hidden beneath Collection. Collection's **Add to deck** opens the deck/section chooser, preserves an unsaved deck draft, and leaves the user in Collection after **Add** to an existing deck, with a success notice. New targets use **Create and add**.

The All Cards view allows crafting any selected eligible printing from a globally unlocked expansion with a matching-rarity wildcard, up to four total copies per Oracle identity. Refresh ownership and available printings after crafting. Display mana without braces, such as `1R`. Exclude novelty, nonstandard, silver/gold-bordered, acorn, and fractional-cost printings from browsing, crafting, packs, and deck use while preserving stored collection and history records.

### C. Deck Builder

Allow users to:

- Create, edit, rename, copy, and delete decks.
- Add cards from their collection.
- Keep nonbasic quantities within pooled Oracle ownership across the main deck and sideboard together, with one selected printing per card throughout the deck.
- Search and filter available cards.
- View main deck and sideboard separately.
- Open the shared card-details popup from the deck list or right-hand card browser.
- See total cards, mana curve, and color distribution.
- Save and copy decks directly into Forge automatically.

Default to 60-card constructed decks with an optional 15-card sideboard.

Enforce normal four-copy limits, with appropriate exceptions.

Read minimum main-deck size, maximum sideboard size, and normal copy limit from the built-in shared rules. Ownership is always required for nonbasic cards and cannot be disabled by older saved settings. Eligible Basic Land printings, including snow-covered basics and Wastes when present, are free and unlimited only once their expansion is globally unlocked; exact Forge printing support is still checked.

Cards used in one deck remain available for other decks. A saved deck does not consume or lock cards.

Use readable grouped artwork tiles without a forced empty area. Tile descriptions contain the name and mana cost, alongside read-only quantities and actions. **Cards per row** offers Auto (up to four columns) and 2 through 6, caps the selected count to available editor width, and persists locally. Keep the optional right-hand browser at most 400 pixels wide with two card columns and a collapse control. Opening a saved deck automatically selects its colors and includes colorless cards and lands; new empty decks start without a color restriction. Hide nonbasic cards from the browser once their pooled copies are fully allocated across main deck and sideboard. Show the deck quantity as a read-only count with +/- controls. Do not expose a direct quantity input or move-between-sections button; players choose the main-deck or sideboard tab and add/remove there. Keep the full card-details popup accessible and make Copy deck a clearly labelled action.

Allow any eligible printing from a globally unlocked expansion for an owned nonbasic card, regardless of which expansion supplied its collected copies. Use one printing per Oracle identity across main deck and sideboard together. Only the shared card-details **Printing** action changes it, updating every copy in both sections; remove tile, sidebar, and target printing links. Loading an older mixed-printing deck consolidates it to the first loaded printing in the editor, leaving that change unsaved until **Save deck**. Native save, copy, and export operations reject allocations above pooled ownership, mixed selected printings, ineligible printings, and globally locked sets. Existing invalid drafts remain loadable for correction. Incomplete owned decks save to Forge as drafts while validation still reports deck-size, copy-limit, and Forge-support problems.

### D. Booster Opening

Create a booster pack generator.

Users can open packs from enabled expansions and receive random cards that are permanently added to their collection.

Use the simplified composition built into the app. The current 15-slot pack contains:

- 10 commons.
- 4 uncommons.
- 1 rare or mythic rare, with a 12.5% mythic chance.
- No basic-land slot and no random bonus wildcard drop.

The canonical values are in [src-tauri/league-rules.json](src-tauri/league-rules.json), not editable per-player settings. Historical pack contents remain unchanged. Real sets have different collation; the app uses its shared simplified format and four-copy protection.

**Booster opening experience:**

1. User chooses **Open one pack** or **Open all** beside the total pack count and wildcard balances.
2. The application starts the league if necessary, automatically credits due rewards, and generates contents from the next chronological queue entries.
3. Contents, collection changes, rewards, and history are saved atomically.
4. All cards are displayed together, with a details popup for each card.
5. Saved openings remain available in history with the same card details.

Keep the top block to the total pack count, wildcard balances, and the two opening actions. Remove expansion selection, join/start, weekly-claim controls, and separate general/set balances. Keep actual results, history, and receipt recovery after an interrupted request. Do not require revealing cards one by one.

Prevent users from accidentally claiming the same pack twice.

### E. Wildcards and Crafting

Replace the previously discussed credit system with wildcards only.

Four wildcard rarities:

- Common
- Uncommon
- Rare
- Mythic

One matching wildcard crafts one card of that rarity.

The permanent collection is limited to four copies of each nonbasic card across all printings, identified by Oracle ID. Crafting a fifth copy is rejected without spending a wildcard. Booster slots select another eligible card of the same rarity, or award a matching wildcard when that rarity's pool is complete. Basic lands remain freely available in decks through eligible globally unlocked printings.

Wildcards are earned from the shared weekly schedule and duplicate-protection replacement slots. The current built-in random bonus-drop probability is zero.

In the All Cards browser, provide a **Craft** button.

Crafting a card deducts one wildcard and adds the selected card to the collection.

Show available wildcard balances on the dashboard and crafting screen.

### F. Shared Weekly Rewards and Set Unlocking

Everyone uses the same built-in league calendar, anchored at the single committed `startedAt` value in `src-tauri/league-rules.json`. Set the real production start before the first public release and keep it stable afterward; the earlier development anchor remains recorded in verification history. The current rules grant 12 starting packs, 4 weekly packs, 4 common and 2 uncommon wildcards each week, 1 rare wildcard every two weeks, and 1 mythic wildcard every four weeks. Claims count shared calendar boundaries, including missed periods and late joining, while preserving existing balances.

A late joiner receives the starting packs plus all scheduled weekly rewards elapsed since that shared start. Status updates automatically credit all due periods for existing players. The first opening starts a new league and includes its elapsed catch-up rewards. Record periods locally and prevent duplicate rewards, including concurrent calls and retries.

Expansion availability and automatic unlock order come from the same shared configuration. Foundations (`FDN`) starts at week 0. The fixed schedule unlocks Bloomburrow at week 4, Wilds of Eldraine at 8, The Lost Caverns of Ixalan at 12, Outlaws of Thunder Junction at 16, Duskmourn: House of Horror at 20, Kamigawa: Neon Dynasty at 24, The Brothers' War at 28, Aetherdrift at 32, Tarkir: Dragonstorm at 36, Edge of Eternities at 40, Lorwyn Eclipsed at 44, Secrets of Strixhaven at 48, and March of the Machine at 52.

Each later unlock grants 8 additional packs reserved for that set, separate from the normal weekly reward. Migration 007 records persistent queue entries with assigned set, source, earned period, priority, and remaining quantity. Starting, weekly, and bonus packs open in earned chronological order; reserved packs keep their expansion. The new count-zero **Open all** request consumes the remaining queue atomically. Receipt replay returns the same opening, and legacy set-specific pending receipts remain compatible with the shared balances. Late joiners receive all reserved expansion rewards elapsed since the shared start, and claims grant each unlock bonus once.

Settings displays full expansion names, exact themes from the configuration, dates, and reserved rewards as a read-only calendar. Scheduled unlocks follow the shared calendar, including for players who join later. Locked sets cannot generate packs, be crafted, or supply selected deck printings. Existing ownership remains stored. Its pooled quantity may use any eligible printing from globally unlocked expansions; basic lands require no collection ownership.

## 5. Settings

Keep two sections:

- **Forge folders:** the three required paths, automatically populated and checked, with browse/edit/save for correction.
- **League rules:** a read-only presentation of the rules included in the app build, using full expansion names and a readable unlock order.

Fix the interface to Daylight with Larger text in frontend and native settings normalization. Remove Appearance controls but retain the existing theme CSS. Do not expose Application settings, catalog refresh/import, backup/restore, image-cache clearing, export preferences, integration tests, cached-artwork tests, or test-deck export controls. Gameplay rules cannot be changed by an individual user.

Store local Forge paths and app state in SQLite. Load league policy from [src-tauri/league-rules.json](src-tauri/league-rules.json). Refresh collection statistics and league status when the app regains focus, becomes visible, or reaches the next shared weekly reward deadline.

## 6. Card Database and Images

Load the card catalog automatically during first setup. Keep initial progress visible and provide a retry path if setup cannot finish.

Detect later Forge-version changes and append only the missing printings. Do not replace or reload existing catalog rows, alter collection/deck/wildcard data, or clear either artwork cache. Record the detected version so ordinary restarts with an unchanged Forge version do not refetch the full catalog. Preserve an existing catalog when offline or when an extension fails, and retry the missing extension later.

Migration 006 maintains a derived eligibility cache and a browsing index, backfilling existing metadata once and updating the derived values when catalog rows are added. A normal-profile native IPC check of the full 120,135-printing catalog returned 32,668 grouped cards in 627 ms and owned facets in 299 ms. A separate development copy measured the one-time cold backfill at about 18 seconds. An earlier schema-6 normal-profile audit preserved collection, decks, rewards, opening history, settings, and all catalog rows, with 184 owned cards, 37 wildcards, one Test deck, and SQLite integrity `ok`.

Card images are not downloaded in bulk. Reuse Forge's cache and fetch missing artwork only when needed. Local browsing and progression remain available after catalog setup.

### Development clock preview

The debug-only `ETERNAL_LEAGUE_PREVIEW_WEEKS=4` advances league calculations by four weeks without changing the shared anchor or operating-system clock. Release builds ignore it. Use an isolated `com.eternalleague.preview` clone and separate workspace Forge-export directory, preserving the original league's data and rewards. Live preview checks passed after cloning the current normal profile: 184 owned cards, 37 wildcards, and one Test deck with nine rows and 11 main-deck cards. Four weeks automatically added 24 packs and raised the wildcard total to 64. The clean preview handoff baseline was restored to 184 cards, 24 unopened packs, 64 wildcards, and the original nine-row/11-card-main Test deck. A fresh original-profile comparison matched all 11 tables exactly, including settings, migrations, and receipts; the original stayed at 184 cards, 37 wildcards, one Test deck, and 120,135 catalog printings, with SQLite integrity `ok`. Detailed results are in the finishing notes.

## 7. GitHub and Automatic Updates

Use a GitHub repository for source control and releases.

Set up GitHub Actions to automatically:

1. Install dependencies.
2. Build the React frontend.
3. Build the Tauri Windows application.
4. Produce a Windows installer.
5. Publish versioned releases when a release tag is pushed.

Configure Tauri's official updater with signed releases.

When a new version is available, show an update prompt and allow the user to install it.

Make sure updates preserve the local SQLite database and downloaded card images.

Use database migrations when schema changes are required.

The initial application should run locally through `npm run tauri dev` before any GitHub release pipeline is configured.

## 8. Suggested Project Structure

```text
eternal-league/
├── src/
│   ├── components/
│   ├── pages/
│   │   ├── Dashboard.tsx
│   │   ├── Collection.tsx
│   │   ├── DeckBuilder.tsx
│   │   ├── Boosters.tsx
│   │   └── Settings.tsx
│   ├── services/
│   │   ├── cards.ts
│   │   ├── collection.ts
│   │   ├── decks.ts
│   │   ├── forge.ts
│   │   ├── images.ts
│   │   ├── boosters.ts
│   │   ├── wildcards.ts
│   │   └── database.ts
│   ├── App.tsx
│   └── main.tsx
├── src-tauri/
│   ├── src/
│   ├── migrations/
│   └── tauri.conf.json
├── .github/
│   └── workflows/
├── package.json
└── README.md
```

Keep the code modular, but avoid unnecessary abstraction or complicated service layers.

## 9. Implementation Order

Codex should implement the application in the following order.

### Phase 1: Basic working application

- [x] Create Tauri + React project.
- [x] Add Tailwind and shadcn/ui.
- [x] Implement navigation and basic layout.
- [x] Add SQLite.
- [x] Implement Settings screen.
- [x] Detect Forge folders.
- [x] Display an image from Forge's existing cache.
- [x] Generate and export a test `.dck` file.
- [x] Confirm the deck works in Forge (installed parser, supported-card resolution, and constructed conformance; gameplay was not simulated).

**Result:** A working Windows application connected to Forge.

### Phase 2: Collection and deck builder

- [x] Download and import Scryfall card metadata.
- [x] Implement searchable card browser.
- [x] Implement local image cache and missing-image downloads.
- [x] Implement collection ownership and quantities.
- [x] Implement deck creation and editing.
- [x] Add deck validation.
- [x] Export decks into Forge.

**Result:** Users can maintain a collection and create actual playable decks.

### Phase 3: Booster packs and wildcards

- [x] Implement simplified booster generation (now driven by the shared built-in rules).
- [x] Create booster-opening UI.
- [x] Add received cards to collection.
- [x] Save booster history.
- [x] Implement wildcard balances.
- [x] Implement crafting.
- [x] Add initial and weekly booster rewards.
- [x] Implement enabled sets and set unlocking.

**Result:** Complete single-player collection progression loop.

### Phase 4: Settings and finishing

- [x] Complete league configuration during development (now a read-only shared policy).
- [x] Add collection statistics to dashboard.
- [x] Verify database backup/restore during development (subsequently removed from the interface).
- [x] Improve loading states and error messages.
- [x] Test offline behavior.
- [x] Verify that all screens work with a real Forge installation.

**Result:** A usable local application.

Current finishing changes include Black Lotus with all five Mox cards behind it and no caption, full expansion names, a compact Collection counts/wildcards toolbar, unbracketed mana, responsive deck tiles with persisted Auto or 2-6 density, fixed shared rules and wildcard cadences, catch-up and reserved expansion rewards, calendar-complete alerts, automatic append-only catalog setup, and stable Forge saves/copies in an app-owned subfolder with deletion cleanup. Daylight with Larger text is fixed and the theme CSS remains available; the app version is shown subtly. Collection and deck browsing now group printings by Oracle identity with pooled ownership, printing variants from globally unlocked expansions for owned cards, shared faceted filters, lazy creature-type suggestions, allocation hiding, automatic deck-color selection, and a centered draft-preserving Collection add-to-deck chooser that leaves the user in Collection. Each card uses one chosen printing across the whole deck, with shared switching only when alternatives exist. Novelty and fractional-cost cards are excluded without deleting saved records. Searches match names and card abilities, and Daylight notices use readable light surfaces. The interface omits Application maintenance settings, manual catalog/maintenance/test controls, explicit export, direct deck-count inputs, and move buttons. The Phase 4 production frontend build and 94-test native baseline passed. Phase 5 now records 96 native and 21 Node tests; remote packaging and Linux smoke execution still need their first workflow result. Live isolated four-week preview QA passed for automatic rewards, chronological opening and replay, stable Collection counts in one toolbar row at 1920 and 980 pixels, globally unlocked printings, and nested body-portal dialogs. The final frontend build also passed after page-navigation scroll reset and the shared Daylight charcoal common-rarity dot change. Earlier completed verification includes actual Tauri Collection Add/draft-preservation and centered-dialog checks, whole-deck printing changes, background allocation updates, persisted six-column density at 1920 pixels and a two-column cap at 980 pixels in Daylight with Larger text, all five Mox images loaded upright, native resizing/maximizing, preference persistence, strict installed-Forge parsing of all 75 exact copies from a newly saved 60/15 deck using Llanowar Elves #439 and Forest #291, cold first-run/offline, and normal-data preservation checks; see [Phase 4 verification](docs/phase-4-verification.md).

### Phase 5: GitHub delivery (Windows and Linux)

The operational procedure and verification record are [docs/phase-5-release.md](docs/phase-5-release.md). [AGENTS.md](AGENTS.md) supplies durable instructions for future Codex releases. The user intends to publish subsequent releases through Codex; every new publish requires a new higher SemVer version.

- [x] Separate the fresh permanent production identifier `com.eternalleague.desktop` from the preserved legacy development `.app` and isolated `.preview` profiles.
- [x] Add tracked development configuration and inject it for ordinary `npm run tauri dev`, while preserving explicit preview/verification config overrides. Eight isolated routing cases pass without launching an app or changing profile data.
- [ ] Commit the chosen shared launch timestamp `1794847589` from `release-policy.json` and the built-in rules before the first tag, then verify a clean production first launch. The new production profile supplies the clean DEVELOPMENT release baseline without deleting existing development/preview databases or Forge files.
- [ ] Verify release artifacts exclude preview configuration/identifiers, cloned databases, test exports, debugging capabilities, and signing secrets. Release builds ignore the debug clock; later updates preserve the production start and player progress.
- [ ] Use a public GitHub repository with GitHub Free.
- [ ] Run the configured tag-triggered Windows 2022/Ubuntu 22.04 workflow remotely, producing a draft release for review. Local actionlint validation passed.
- [ ] Generate a Windows NSIS `.exe` installer with standard Windows uninstall support.
- [ ] Generate a Linux `.AppImage` package.
- [ ] Use default LOCAL updater signing: CI drafts raw installers, Codex signs offline using the updater key/DPAPI password, a separate attach step uploads only public signatures and `latest.json`, and full minisign verification runs before promotion. Optional Actions signing requires explicit credential-export approval and approved Secrets configuration.
- [ ] Check for updates at startup and every four hours while running.
- [ ] Show **Install update** and **Later**. Verify signatures, install only after acceptance, and restart as needed; never force an update.
- [x] Require version preparation/validation across `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, its application entry in `Cargo.lock`, and `tauri.conf.json`; update `CHANGELOG.md`. Published versions and tags are immutable.
- [ ] Publish the initial public version (planned `0.2.0`) only after both signed platform assets and updater metadata are verified.
- [ ] Keep SQLite data and downloaded artwork outside installation files. Preserve collection, decks, wildcards, rewards, settings, and artwork across updates and reinstalls. Windows uninstall preserves user data by default.
- [ ] Test clean installation, uninstall/reinstall, signed updates, and data preservation on both platforms, recording actual evidence and any remaining limitations.

**Result:** Public Windows and Linux releases with signed optional updates, persistent player data, and a repeatable Codex release process.

## 10. Instructions for Codex

Build the application incrementally, beginning with Phase 1.

**Priorities:**

- Focus on a working local application rather than production-grade infrastructure.
- Use simple, maintainable TypeScript and React components.
- Keep SQLite straightforward.
- Do not add multiplayer, trading, credits, user authentication, or cloud synchronization.
- Prefer existing Tauri plugins and established libraries.
- Implement functional UI, not placeholder screens.
- Verify integration with actual Forge files.
- Ensure generated decks are compatible with Forge.
- Use the existing Forge image cache wherever possible.
- Download missing card images automatically.
- Keep all progression and settings persistent between sessions.
- Do not require Forge to be running for the companion application to work.
- Preserve local data across application updates.
- Keep gameplay configuration fixed in the shared build file and display it read-only in Settings.
- Add focused tests for deck serialization, booster generation, and collection updates, but avoid unnecessary test infrastructure.

**Start with Phase 1 and make sure the application runs locally. Continue through the remaining phases only after the preceding functionality works.**

The final objective is a complete, straightforward MTG Forge companion application that provides an enjoyable card-collecting and deck-building experience without rebuilding the actual game.
