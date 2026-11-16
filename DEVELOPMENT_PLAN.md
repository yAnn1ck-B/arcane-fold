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

The dashboard banner uses Black Lotus.

### Deck saving

Every successful **Save deck** writes the deck locally and to Forge. **Copy deck** also creates a managed Forge deck. Repeated saves update that deck's stable managed file; unrelated Forge files are not overwritten. Keep main deck, sideboard, names, and exact printings.

Owned incomplete decks may be saved to Forge as drafts. Nonbasic exact-printing ownership remains mandatory across both sections. Report sync failures honestly. There is no separate Export to Forge button or automatic-export preference.

The application does not need to launch or control Forge.

## 3. Local Database

Keep SQLite simple.

Suggested tables:

| Table | Purpose |
|---|---|
| `cards` | Scryfall card and printing metadata |
| `collection` | Owned printing ID and quantity |
| `decks` | Saved deck names and information |
| `deck_cards` | Cards belonging to each deck |
| `wildcards` | Available wildcards by rarity |
| `booster_history` | Previously opened boosters and contents |
| `settings` | Local Forge paths, sync state, and internal persistence |

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

Show Black Lotus in the welcome banner. Display full unlocked expansion names, the next expansion unlock date and reserved-pack bonus, and an alert when the shared schedule has no upcoming expansion. Use week 0 for the starting pool. Keep page headers compact, omit the unique-printings statistic, and do not add a dashboard League settings button.

### B. Collection Browser

Display owned cards in a visual grid using card artwork.

Support searching and filtering by:

- Card name
- Color
- Mana cost
- Card type
- Rarity
- Expansion
- Owned quantity

Clicking a card opens a larger view with artwork, abilities, rarity, set, and ownership quantity.

Collection quantities come from booster openings and wildcard crafting.

Provide a toggle between **Owned Cards** and **All Cards**.

The All Cards view also allows users to craft cards using wildcards. Separate wildcard balances from the cards below. Display mana without braces, such as `1R`; retain fractional mana filtering because half-mana cards exist.

### C. Deck Builder

Allow users to:

- Create, edit, rename, copy, and delete decks.
- Add cards from their collection.
- Keep nonbasic printing quantities within ownership across the main deck and sideboard together.
- Search and filter available cards.
- View main deck and sideboard separately.
- Open the shared card-details popup from the deck list or right-hand card browser.
- See total cards, mana curve, and color distribution.
- Save and copy decks directly into Forge automatically.

Default to 60-card constructed decks with an optional 15-card sideboard.

Enforce normal four-copy limits, with appropriate exceptions.

Read minimum main-deck size, maximum sideboard size, and normal copy limit from the built-in shared rules. Ownership is always required for nonbasic cards and cannot be disabled by older saved settings. All Basic Land cards, including snow-covered basics and Wastes, are free and unlimited in the deck builder; exact Forge printing support is still checked.

Cards used in one deck remain available for other decks. A saved deck does not consume or lock cards.

Use readable artwork tiles without a forced empty area. Show the deck quantity as a read-only count with +/- controls. Do not expose a direct quantity input or move-between-sections button; players choose the main-deck or sideboard tab and add/remove there. Keep the full card-details popup accessible and make Copy deck a clearly labelled action.

Native save and copy operations reject nonbasic quantities above the owned amount of the exact printing. Existing decks containing missing cards remain loadable for correction; saving requires those entries to be removed or reduced. Incomplete decks are saved to Forge as drafts, while validation still reports deck-size, copy-limit, and Forge-support problems.

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

1. User selects an available pack.
2. Application generates its contents.
3. Contents, collection changes, rewards, and history are saved atomically.
4. All cards are displayed together, with a details popup for each card.
5. Saved openings remain available in history with the same card details.

Include an **Open All** option for opening multiple packs together. Do not require revealing cards one by one.

Prevent users from accidentally claiming the same pack twice.

### E. Wildcards and Crafting

Replace the previously discussed credit system with wildcards only.

Four wildcard rarities:

- Common
- Uncommon
- Rare
- Mythic

One matching wildcard crafts one card of that rarity.

The permanent collection is limited to four copies of each nonbasic card across all printings, identified by Oracle ID. Crafting a fifth copy is rejected without spending a wildcard. Booster slots select another eligible card of the same rarity, or award a matching wildcard when that rarity's pool is complete. Basic lands remain freely available in decks.

Wildcards are earned from the shared weekly schedule and duplicate-protection replacement slots. The current built-in random bonus-drop probability is zero.

In the All Cards browser, provide a **Craft** button.

Crafting a card deducts one wildcard and adds the selected card to the collection.

Show available wildcard balances on the dashboard and crafting screen.

### F. Shared Weekly Rewards and Set Unlocking

Everyone uses the same built-in league calendar, anchored at Unix time `1794801597` on 16 November 2026. The current rules grant 12 starting packs, 4 weekly packs, 4 common and 2 uncommon wildcards each week, 1 rare wildcard every two weeks, and 1 mythic wildcard every four weeks. Claims count shared calendar boundaries, including missed periods and late joining, while preserving existing balances.

A late joiner receives the starting packs plus all scheduled weekly rewards elapsed since that shared start. Existing players can claim all unclaimed periods together. Save claimed periods locally and prevent duplicate rewards, including concurrent claims and retries.

Expansion availability and automatic unlock order come from the same shared configuration. Foundations (`FDN`) starts at week 0. The fixed schedule unlocks Bloomburrow at week 4, Wilds of Eldraine at 8, The Lost Caverns of Ixalan at 12, Outlaws of Thunder Junction at 16, Duskmourn: House of Horror at 20, Kamigawa: Neon Dynasty at 24, The Brothers' War at 28, Aetherdrift at 32, Tarkir: Dragonstorm at 36, Edge of Eternities at 40, Lorwyn Eclipsed at 44, Secrets of Strixhaven at 48, and March of the Machine at 52.

Each later unlock grants 8 additional packs reserved for that set, separate from the normal weekly reward. Track general and per-expansion pack balances independently. Opening all packs uses only the general balance plus the selected expansion's reserved balance; a reward for one expansion cannot be spent on another. Late joiners receive all reserved expansion rewards elapsed since the shared start, and claims grant each unlock bonus once.

Settings displays full expansion names, exact themes from the configuration, dates, and reserved rewards as a read-only calendar. Scheduled unlocks follow the shared calendar, including for players who join later. Locked sets cannot generate packs or be crafted, while already-owned cards remain available.

## 5. Settings

Keep only two sections:

- **Forge folders:** the three required paths, automatically populated and checked, with browse/edit/save for correction.
- **League rules:** a read-only presentation of the rules included in the app build, using full expansion names and a readable unlock order.

Do not expose Application settings, catalog refresh/import, backup/restore, image-cache clearing, export preferences, integration tests, cached-artwork tests, or test-deck export controls. Gameplay rules cannot be changed by an individual user.

Store local Forge paths and app state in SQLite. Load league policy from [src-tauri/league-rules.json](src-tauri/league-rules.json). Refresh collection statistics and league status when the app regains focus, becomes visible, or reaches the next shared weekly reward deadline.

## 6. Card Database and Images

Load the card catalog automatically during first setup. Keep initial progress visible and provide a retry path if setup cannot finish.

Detect later Forge-version changes and append only the missing printings. Do not replace or reload existing catalog rows, alter collection/deck/wildcard data, or clear either artwork cache. Record the detected version so ordinary restarts do not repeat the update. Preserve an existing catalog when offline or when an extension fails, and retry the missing extension later.

Card images are not downloaded in bulk. Reuse Forge's cache and fetch missing artwork only when needed. Local browsing and progression remain available after catalog setup.

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

Current finishing changes include Black Lotus in the restored banner, full expansion names, a wildcard separator, unbracketed mana, responsive deck tiles with up to four columns, fixed shared rules and wildcard cadences, catch-up and reserved expansion rewards, calendar-complete alerts, automatic append-only catalog setup, and stable Forge saves/copies in an app-owned subfolder with deletion cleanup. Appearance preferences offer four themes and larger text; the app version is shown subtly. The interface omits Application maintenance settings, manual catalog/maintenance/test controls, explicit export, direct deck-count inputs, and move buttons. The production frontend build, 72-test native suite, native resizing/maximizing, preference persistence, installed-Forge parsing, cold first-run/offline, and normal-data preservation checks have passed; see [Phase 4 verification](docs/phase-4-verification.md).

### Phase 5: GitHub delivery (Windows and Linux)

- [ ] Use a public GitHub repository with GitHub Free.
- [ ] Configure GitHub Actions to build Windows and Linux applications when a version tag is pushed.
- [ ] Generate a Windows NSIS `.exe` installer with standard Windows uninstall support.
- [ ] Generate a Linux `.AppImage` package.
- [ ] Configure free Tauri updater signing and publish signed update artifacts through GitHub Releases.
- [ ] Automatically check for updates on application startup and every 4 hours while running.
- [ ] Show an update notification with **Install update** and **Later** options. Never force an update.
- [ ] Download and verify updates when accepted, then restart the application as required.
- [ ] Publish the initial GitHub Release containing Windows and Linux builds.
- [ ] Store SQLite data and downloaded artwork in persistent application-data directories, separate from application installation files.
- [ ] Preserve collection, decks, wildcards, rewards, settings, and artwork across updates and reinstalls. Windows uninstall should preserve user data by default.
- [ ] Test installation, uninstallation, automatic updates, and data preservation on both platforms.

**Result:** A publicly available Windows and Linux application with free GitHub-hosted releases, automatic update notifications, standard uninstallation, and persistent user collections.

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
