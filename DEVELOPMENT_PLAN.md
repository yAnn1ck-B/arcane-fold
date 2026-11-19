# Eternal League: Development Plan

This plan reflects the current product direction. The canonical shared rules are [src-tauri/league-rules.json](src-tauri/league-rules.json). Earlier phase checklists record development milestones; removed test and maintenance controls are historical. Latest verification is tracked in [the finishing notes](docs/phase-4-verification.md).

## 1. Overview

Build a Windows desktop application that works alongside **MTG Forge**.

The application manages a permanent Magic: The Gathering card collection. Users open booster packs, collect cards, earn wildcards, craft specific cards, and build decks that can be played in Forge.

### Play (unreleased)

**Play** starts a local rules-enforced game from one or two saved main decks. Forge handles phases, priority, legal actions and player decisions. When one person tests both seats, the board opens the deciding seat’s view automatically. The opening-hand dialog handles keeping, mulligans and bottoming cards. The shared board puts the two battlefields and the current hand beside an optional right panel for the stack and public game log.

An active game can switch permanently to manual play after confirmation. The native bridge exports the suspended position at its current revision. The app checks card conservation and writes a manual checkpoint before closing Forge. Replacing a saved manual game requires consent for that save revision. Manual Undo begins at the handoff. Both engines retain the public log; only the current seat's private cards are shown at the table.

The manual table supports zone moves, life, mana, counters, tokens, attachments, combat markers, stack entries and turn changes. Each move updates a local checkpoint in the existing profile store. Players can resume or remove a saved manual table, including one from an earlier build. Removal requires confirmation for the displayed revision. Both game modes place creatures toward the middle, lands behind them and support permanents to the right. They show the newest public actions first and let players inspect each seat’s mana pool by color. Fixed scenarios are automated integration fixtures.

Foundations is the first set for interaction coverage. The installed Forge 2.0.13 regression suite loads all 771 printings across 517 distinct names. A separate sweep plays every distinct card through the controller. Fixed positions and seeded decks exercise both sides of player decisions and check the resulting hands, stack, battlefield and life totals. [Foundations gameplay verification](docs/foundations-play-audit.md)

The suite covers alternate activations, private scry and surveil ordering, discards, sacrifices and flashback. Combo tests cover Tatyova with Temple of Mystery in either trigger order, Wildwood Scourge with a kicked Gnarlid Colony, and Mossborn Hydra with Doubling Season and Evolving Wilds. Bloodthirsty Conqueror and Marauding Blight-Priest can drain an opponent to zero, and the opponent can interrupt the loop with Unsummon. [Documented Conqueror combo](https://commanderspellbook.com/combo/110-6191/)

Other cases check when a choice takes effect. Dwynen's Elite checks for another Elf again on resolution. Felidar Savior can target up to two distinct creatures, and Affectionate Indrik chooses its target before its controller decides whether to fight. [Foundations release notes](https://magic.wizards.com/en/news/feature/foundations-release-notes)

Wildborn Preserver's controller chooses whether and how much to pay as its trigger resolves. Declining ends the effect. Paying any legal amount, including zero, puts a second ability on the stack. Players can respond before it adds the counters. [Wildborn Preserver ruling](https://magic.wizards.com/en/news/feature/throne-eldraine-release-notes-2019-09-20)

Automatic priority checks each seat's legal plays. A player can also request their next priority, a specific step on either turn, or every priority window. These settings are private to the seat. Installed-engine tests compare automatic and full-control decisions for the same positions, including responses to one's own spells and triggers.

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

Deck edits save automatically to the app and Forge, with serialized writes and the latest full draft queued. New and Copy require a confirmed name before creation; retries do not create duplicate decks. Repeated saves update that deck's stable managed file; unrelated Forge files are not overwritten. Keep main deck, sideboard, names, and exact printings. Window close, update installation, and restart wait for pending deck actions and saves; failed saves leave the app open with persistent recovery actions. There is no Save button or routine save-status label.

Owned incomplete decks may be saved to Forge as drafts. Nonbasic quantities across both sections must stay within pooled Oracle ownership, and every selected printing must be eligible and globally unlocked; collection ownership is pooled across expansions. Report sync failures honestly. There is no separate Export to Forge button or automatic-export preference.

The companion uses Forge files directly for its catalog and deck integration. Starting a game launches a local Java process for that match.

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

Provide a toggle between **Owned Cards** and **All Cards**. All Cards shows only eligible printings from globally unlocked expansions, including its grouped totals, filter options, and creature-type suggestions. Future expansions appear automatically when the shared calendar unlocks them; retain all stored ownership and historical card details. Both Collection and Deck builder use shared controls:

- Search card names and rules text, including multi-word ability phrases.
- Multi-select color pills and mana-value pills for existing values 0 through 5, plus a 6+ bucket.
- Rarity and full expansion-name dropdowns drawn from the actual eligible pool.
- A dropdown of main card types, such as Creature, Instant, Artifact, and Land.
- A searchable creature-type combobox that requests suggestions only after two characters.

Owned-view choices use actual eligible owned cards plus basic lands from unlocked expansions. Facet choices remain available across active filter selections. The deck browser keeps search, swatch-only color pills, and mana visible while its advanced controls start collapsed behind an icon-only toggle. Color and mana groups align horizontally in wider filter panels and stack in the narrow browser. Keep browser tiles visible while deck quantity changes refresh availability in the background. Use a small delayed loading indicator for filter requests.

Collection's Owned/All buttons include the full unfiltered grouped totals, with compact wildcard balances on the right of the same toolbar. Remove the separate wildcard strip, instructional hints, and redundant result counter. Fetch the two base-scope totals once per data revision with page size one, independently of search keystrokes.

Clicking a card opens the shared full modal with artwork, rules, and a simple `N owned` count. Put static expansion/collector/rarity metadata beneath the artwork, plus a small **Printing** button only when multiple eligible printings exist. Do not show an expansion-unlock list, dropdown, or per-card acquisition explanation. Owning a card enables any eligible printing from globally unlocked expansions, while all copies share one pooled owned budget. Basic lands are free and unlimited through eligible globally unlocked printings.

In Collection, changing a printing changes only the preview. In Deck builder, the same details callback changes every copy of that card across both sections. Card details, the printing picker, and target dialogs are centered body portals, including when DeckBuilder is hidden beneath Collection. Collection's **Add to deck** opens the deck/section chooser, preserves an unsaved deck draft, and leaves the user in Collection after **Add** to an existing deck, with a success notice. New targets use **Create and add**.

The All Cards view allows copying owned cards with a matching-rarity wildcard, up to four total copies per Oracle identity. A Discovery wildcard grants the first copy of an unowned card of any standard rarity. Both require a selected eligible nonbasic printing from a globally unlocked expansion; ownership of another printing counts as owning the card. Refresh ownership and available printings after crafting. Display mana without braces, such as `1R`. Exclude novelty, nonstandard, silver/gold-bordered, acorn, and fractional-cost printings from browsing, crafting, packs, and deck use while preserving stored collection and history records.

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

Use readable grouped artwork tiles without a forced empty area. Tile descriptions contain the name and mana cost, alongside read-only quantities and actions. **Cards per row** offers responsive Auto (up to five columns with the browser open or seven when collapsed), favors another column at borderline widths, and persists locally. Fixed choices from 2 through 7 keep the exact count on resize/maximize, with horizontal scrolling when necessary. Group the capped-width deck selector and Rename icon together, with space before New, Copy, and Delete. Use centered naming and delete-confirmation dialogs. Keep the optional right-hand browser at most 400 pixels wide with two card columns and a collapse control. Opening a saved deck automatically selects its colors and includes colorless cards and lands; new empty decks start without a color restriction. Hide nonbasic cards from the browser once their pooled copies are fully allocated across main deck and sideboard. Show the deck quantity as a read-only count with +/- controls. Do not expose a direct quantity input or move-between-sections button; players choose the main-deck or sideboard tab and add/remove there. Keep the full card-details popup accessible and label icon actions with tooltips and accessible names.

Allow any eligible printing from a globally unlocked expansion for an owned nonbasic card, regardless of which expansion supplied its collected copies. Use one printing per Oracle identity across main deck and sideboard together. Only the shared card-details **Printing** action changes it, updating every copy in both sections; remove tile, sidebar, and target printing links. Loading an older mixed-printing deck consolidates it to the first loaded printing in the editor, writing the consolidated selection on the next automatic save. Native save, copy, and export operations reject allocations above pooled ownership, mixed selected printings, ineligible printings, and globally locked sets. Existing invalid drafts remain loadable for correction. Incomplete owned decks save to Forge as drafts while validation still reports deck-size, copy-limit, and Forge-support problems.

### D. Booster Opening

Create a booster pack generator.

Users can open packs from enabled expansions and receive random cards that are permanently added to their collection.

Use the simplified composition built into the app. The current 15-slot pack contains:

- 10 commons.
- 4 uncommons.
- 1 rare or mythic rare, with a 12.5% mythic chance.
- No basic-land slot and no random bonus wildcard drop.

The canonical values are in [src-tauri/league-rules.json](src-tauri/league-rules.json), not editable per-player settings. Historical pack contents remain unchanged. Real sets have different collation; the app uses its shared simplified format and four-copy protection.

Use one selection algorithm for every expansion, without set-code exceptions. Only common nonbasic lands have half the selection weight of other common identities; uncommon, rare, and mythic lands use full weight. Prefer at most one nonbasic land across the whole pack. Resolve slots in descending rarity order (mythic, rare, uncommon, common), so higher-rarity lands have priority and a common land never displaces a chosen higher-rarity land. The normal rare/mythic roll stays unchanged. Keep the revealed results in common-to-mythic order. A spell on the front of a modal double-faced card stays in the spell pool, even when its back is a land. Exclude basic lands from every pack, including old saved slot settings: they are free through unlocked expansions.

Select card identities before choosing artwork, so extra printings do not improve a card's odds. Prefer different identities within each pack whenever the eligible preferred pool permits. Four-copy protection applies across all printings and the whole opening batch. Land and variety preferences relax when needed to award the remaining collectable cards; award a matching wildcard only when that entire rolled rarity is already complete. Do not redistribute a rolled mythic into rare cards merely because the mythic collection is complete. Use system randomness for actual openings and fixed seeds only in isolated tests. Existing collection quantities, earned packs, opening history, and completed retry receipts remain intact when the recipe changes.

**Booster opening experience:**

1. User chooses **Open one pack** or **Open all** beside the total pack count and wildcard balances.
2. First app use has already granted starting packs and wildcards. Opening automatically credits any newly due rewards and generates contents from the next chronological queue entries, retaining transactional auto-start as a fallback.
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

One matching wildcard crafts one additional copy of an already-owned card of that rarity. A separate Discovery wildcard grants the first copy of an unowned card of any standard rarity from an unlocked expansion. Each discovery immediately adds the card; later copies use ordinary wildcards. Discovery wildcards cannot be spent on owned cards or free basic lands. Previously collected or crafted cards remain owned and can be copied.

The permanent collection is limited to four copies of each nonbasic card across all printings, identified by Oracle ID. Crafting a fifth copy is rejected without spending a wildcard. Booster slots select another eligible card of the same rarity, or award a matching wildcard when that rarity's pool is complete. Basic lands remain freely available in decks through eligible globally unlocked printings.

Ordinary wildcards are earned from the starting grant, shared weekly schedule, and duplicate-protection replacement slots. Discovery wildcards are earned only from their starting grant and shared-calendar schedule, not random pack or duplicate replacements. The current built-in random bonus-drop probability is zero.

In the All Cards browser, provide **Craft** for additional copies and **Discover card** for a first copy, with the relevant balance and cost shown.

Crafting a card atomically deducts one appropriate wildcard and adds the selected card to the collection. Requests bind their intended currency so retries or concurrent ownership changes cannot silently spend a different type. Completed historical crafting receipts remain replayable without a second spend.

Show available wildcard balances on the dashboard and crafting screen.

### F. Shared Weekly Rewards and Set Unlocking

Everyone uses the same built-in league calendar, anchored at the single committed `startedAt` value in `src-tauri/league-rules.json`. Set the real production start before the first public release and keep it stable afterward; the earlier development anchor remains recorded in verification history. Grant 20 starting packs, 6 weekly packs, and starting wildcards of 10 common, 5 uncommon, 2 rare, 1 mythic, and 1 Discovery. Keep 4 common and 2 uncommon each week and 1 rare every two weeks. Alternate 1 mythic at weeks 2, 6, 10, ... with 1 Discovery at weeks 4, 8, 12, ...; each has a four-week interval. Version 0.4.0 ships this Discovery policy; published 0.3.3 retains its earlier mythic timing and crafting rules until upgraded. Published 0.3.0 retains its earlier 12/4 pack amounts until upgraded. Claims count shared calendar boundaries, including missed periods and late joining, while preserving existing balances.

A late joiner receives the starting packs and wildcards plus all scheduled rewards elapsed since that shared start. On first app use after online version verification, the initial status call starts a new league and credits those rewards together, without requiring a catalog or booster opening. Status updates automatically credit all due periods for existing players. Reuse the existing entitlement ledger so players who already received or spent their starting wildcards are not granted them again. Record periods locally and prevent duplicate rewards, including concurrent calls and retries. For the historical 0.3.1 change, already-started leagues receive the positive entitlement difference exactly once: 8 additional starting packs, 2 per already-credited week, and the starting wildcard grant. Keep earned/spent progress and historical receipts intact; record the applied entitlement policy atomically with its rewards. First-use grants shipped in 0.3.3.

On upgrade, existing players receive their missing starting Discovery once through the same entitlement ledger; new players receive it as part of the ordinary starting grant. Catch up due Discovery periods and the shifted mythic entitlement without regranting already-credited or spent rewards. Previously earned mythics remain intact. Persist reward accounting atomically with grants so status refreshes, concurrent calls, retries, and relaunches cannot repeat compensation. Never reset collection, decks, packs, history, or existing wildcard balances for this change.

Expansion availability and automatic unlock order come from the same shared configuration. Foundations (`FDN`) starts at week 0. The fixed schedule unlocks Bloomburrow at week 4, Wilds of Eldraine at 8, The Lost Caverns of Ixalan at 12, Outlaws of Thunder Junction at 16, Duskmourn: House of Horror at 20, Kamigawa: Neon Dynasty at 24, The Brothers' War at 28, Aetherdrift at 32, Tarkir: Dragonstorm at 36, Edge of Eternities at 40, Lorwyn Eclipsed at 44, Secrets of Strixhaven at 48, and March of the Machine at 52.

Each later unlock grants 8 additional packs reserved for that set, separate from the normal weekly reward. Migration 007 records persistent queue entries with assigned set, source, earned period, priority, and remaining quantity. Starting, weekly, and bonus packs open in earned chronological order; reserved packs keep their expansion. The new count-zero **Open all** request consumes the remaining queue atomically. Receipt replay returns the same opening, and legacy set-specific pending receipts remain compatible with the shared balances. Late joiners receive all reserved expansion rewards elapsed since the shared start, and claims grant each unlock bonus once.

Settings displays full expansion names, exact themes from the configuration, dates, and reserved rewards in a separate read-only **Expansion calendar** tab alongside Forge folders and League rules. Scheduled unlocks follow the shared calendar, including for players who join later. Locked sets cannot generate packs, be crafted, or supply selected deck printings. Existing ownership remains stored. Its pooled quantity may use any eligible printing from globally unlocked expansions; basic lands require no collection ownership.

## 5. Settings

Keep three tabs:

- **Forge folders:** the three required paths, automatically populated and checked, with browse/edit/save for correction.
- **League rules:** a read-only presentation of the rewards, pack composition, and deck rules included in the app build.
- **Expansion calendar:** full expansion names, themes, unlock dates, reserved-pack bonuses, and the current shared-calendar position.

Fix the interface to Daylight with Larger text in frontend and native settings normalization. Remove Appearance controls but retain the existing theme CSS. Do not expose Application settings, catalog refresh/import, backup/restore, image-cache clearing, export preferences, integration tests, cached-artwork tests, or test-deck export controls. Gameplay rules cannot be changed by an individual user.

Store local Forge paths and app state in SQLite. Load league policy from [src-tauri/league-rules.json](src-tauri/league-rules.json). Refresh collection statistics and league status when the app regains focus, becomes visible, or reaches the next shared weekly reward deadline.

## 6. Card Database and Images

Load the card catalog automatically during first setup. Keep initial progress visible and provide a retry path if setup cannot finish.

Detect later Forge-version changes and append only the missing printings. Do not replace or reload existing catalog rows, alter collection/deck/wildcard data, or clear either artwork cache. Record the detected version so ordinary restarts with an unchanged Forge version do not refetch the full catalog. Preserve an existing catalog when offline or when an extension fails, and retry the missing extension later.

Migration 006 maintains a derived eligibility cache and a browsing index, backfilling existing metadata once and updating the derived values when catalog rows are added. A normal-profile native IPC check of the full 120,135-printing catalog returned 32,668 grouped cards in 627 ms and owned facets in 299 ms. A separate development copy measured the one-time cold backfill at about 18 seconds. An earlier schema-6 normal-profile audit preserved collection, decks, rewards, opening history, settings, and all catalog rows, with 184 owned cards, 37 wildcards, one Test deck, and SQLite integrity `ok`.

Card images are not downloaded in bulk. Reuse Forge's cache and fetch missing artwork only when needed. Local browsing and progression remain available after catalog setup.

### Development clock preview

The debug-only `ETERNAL_LEAGUE_PREVIEW_WEEKS=4` advances league calculations by four weeks without changing the shared anchor or operating-system clock. Release builds ignore it. Ordinary development continues on the played `com.eternalleague.preview` profile with its existing four-week offset and saved Forge-export directory. Live preview checks passed after cloning the current normal profile: 184 owned cards, 37 wildcards, and one Test deck with nine rows and 11 main-deck cards. Four weeks automatically added 24 packs and raised the wildcard total to 64. A historical controlled QA handoff checkpoint recorded 184 cards, 24 unopened packs, 64 wildcards, and the original nine-row/11-card-main Test deck. The user has since resumed playing in that preview; preserve its current earned progress and running window rather than restoring those historical counts. A fresh original-profile comparison matched all 11 tables exactly, including settings, migrations, and receipts; the original stayed at 184 cards, 37 wildcards, one Test deck, and 120,135 catalog printings, with SQLite integrity `ok`. Detailed results are in the finishing notes.

## 7. GitHub and Automatic Updates

Use a GitHub repository for source control and releases.

Set up GitHub Actions to automatically:

1. Install dependencies.
2. Build the React frontend.
3. Build the Tauri Windows application.
4. Produce a Windows installer.
5. Create a draft versioned release when a release tag is pushed; sign and verify its public updater artifacts before publication.

Configure Tauri's official updater with signed releases.

When a new version is available, production builds show an update prompt and allow the user to install it. Development and preview builds suppress updater scheduling and prompts so they cannot replace those sessions with the production app.

Make sure updates preserve the local SQLite database and downloaded card images.

Use additive database migrations when schema changes are required. SQLx hashes their exact bytes: `.gitattributes` requires LF for SQL, version validation rejects CR/CRLF, and the native build guard checks before embedding migrations. Preserve existing migration content and runtime checksum verification.

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

Current finishing changes include Black Lotus with all five Mox cards behind it and no caption, full expansion names, a compact Collection counts/wildcards toolbar, unbracketed mana, responsive deck tiles with persisted Auto or exact 2-7 density, fixed shared rules and wildcard cadences, catch-up and reserved expansion rewards, calendar-complete alerts, automatic append-only catalog setup, and stable Forge saves/copies in an app-owned subfolder with deletion cleanup. Daylight with Larger text is fixed and the theme CSS remains available; the app version is shown subtly. Collection and deck browsing now group printings by Oracle identity with pooled ownership, printing variants from globally unlocked expansions for owned cards, shared faceted filters, lazy creature-type suggestions, allocation hiding, automatic deck-color selection, and a centered draft-preserving Collection add-to-deck chooser that leaves the user in Collection. Each card uses one chosen printing across the whole deck, with shared switching only when alternatives exist. Novelty and fractional-cost cards are excluded without deleting saved records. Searches match names and card abilities, and Daylight notices use readable light surfaces. The interface omits Application maintenance settings, manual catalog/maintenance/test controls, explicit export, direct deck-count inputs, and move buttons. The Phase 4 production frontend build and 94-test native baseline passed. The historical 0.2.1 Phase 5 baseline records 100 native tests (96 unit, one migration-guard, and three cold-configuration integration tests) and 31 Node tests (13 updater, two version, 13 release-verifier, and three migration-policy tests). CI run 43914055166 passed Windows/Linux packaging and Linux isolated first-launch/relaunch/AppImage-file-replacement preservation; local Windows NSIS signing, installation, and a clean production cold launch also passed. Actual Windows uninstall/reinstall and a real signed upgrade passed. The Linux native signed-upgrade probe also passed from QA 0.1.9 to the canonical-LF 0.2.0 AppImage, preserving game data, settings, artwork, and the Forge file; it did not automate the Linux GUI. The final 0.2.1 tagged installers and private draft passed cryptographic verification, independent CI verification, official Windows cold launch, and final Linux package smoke. Public release 0.2.1 is published unchanged and anonymous installer/updater verification passed. The actual native public-channel update passed with exact fixture preservation. Automatic Actions signing is explicitly authorized and active after successful real-Secrets smoke verification; the first full application release in that mode subsequently completed with 0.3.0, recorded below. Live isolated four-week preview QA passed for automatic rewards, chronological opening and replay, stable Collection counts in one toolbar row at 1920 and 980 pixels, globally unlocked printings, and nested body-portal dialogs. The final frontend build also passed after page-navigation scroll reset and the shared Daylight charcoal common-rarity dot change. Earlier completed verification includes actual Tauri Collection Add/draft-preservation and centered-dialog checks, whole-deck printing changes, background allocation updates, persisted six-column density at 1920 pixels and a two-column cap at 980 pixels in Daylight with Larger text, all five Mox images loaded upright, native resizing/maximizing, preference persistence, strict installed-Forge parsing of all 75 exact copies from a newly saved 60/15 deck using Llanowar Elves #439 and Forest #291, cold first-run/offline, and normal-data preservation checks; see [Phase 4 verification](docs/phase-4-verification.md).

### Phase 5: GitHub delivery (Windows and Linux)

The operational procedure and verification record are [docs/phase-5-release.md](docs/phase-5-release.md). [AGENTS.md](AGENTS.md) supplies durable instructions for future Codex releases. The user intends to publish subsequent releases through Codex; every new publish requires a new higher SemVer version.

**Current delivered release: [0.4.0](https://github.com/yAnn1ck-B/eternal-league/releases/tag/v0.4.0).** Published unchanged at `2026-11-18T03:18:08Z`, release `449460080`, immutable commit `6d9c9fe2e97408342919b19832640906c4983935`. Release workflow `44225717102`, main CI `44225712028`, all 150 native/71 Node checks, full signed-draft verification, and anonymous installer/updater verification passed. The release adds first-copy Discovery wildcards, owned-only ordinary crafting, alternating mythic/Discovery rewards, rarity-colored controls, and unlocked-set All Cards scoping. Windows actual 0.3.3-to-0.4.0 upgrade and uninstall/reinstall retained genuine production progress while adding the missing starting Discovery once; no factory reset or seed was used. Linux first-launch/relaunch/reinstall passed; its separate signed-upgrade probe rejected tampering and preserved the 0.2.1-to-0.4.0 replacement fixture and permissions, with pre-recorded entitlements and no compensation or online GUI claim. All 13 preview tables and Forge exports remained unchanged, and the played preview reopened with no extra grant. See [evidence, hashes, and exact limitations](docs/phase-5-release.md#current-release-040).

**Historical delivered release: [0.3.3](https://github.com/yAnn1ck-B/eternal-league/releases/tag/v0.3.3).** Published unchanged at `2026-11-17T15:06:03Z` (22:06 Bangkok), release `448755101`, immutable commit `caaa79e7beb2948025432e6ab90e393e07120f08`. Release workflow `44104854001` and main CI `44104844797` passed with 143 native and 71 Node checks. Full draft and anonymous public installer/signature/updater verification passed. The release grants starting rewards on first use, separates the expansion calendar into its own Settings tab, and keeps successful background version checks quiet. Actual Windows 0.3.2-to-0.3.3 installation and uninstall/reinstall preserved all ten game tables, including seven spent-down common wildcards, zero other wildcards, and three queued packs. Fresh Windows startup granted 20 packs and 10 common, 5 uncommon, 2 rare, and 1 mythic wildcard with zero owned cards, decks, history, or receipts. It detected Forge 2.0.13, prepared 120,139 catalog printings, and loaded all six banner images. Linux package smoke observed legitimate period-zero rewards and preserved them through relaunch and file reinstall. Native Linux signed replacement from 0.2.1 preserved its current-entitlement fixture. Compensation and online GUI behavior were outside that probe. All 13 preview tables matched after 0.3.3 initialization with zero pack adjustment, and the preview reopened. See [current release evidence and hashes](docs/phase-5-release.md#current-release-033).

**Historical delivered release: [0.3.2](https://github.com/yAnn1ck-B/eternal-league/releases/tag/v0.3.2).** Published unchanged at `2026-11-17T13:04:56Z`, release `448600171`, immutable commit `59dbc72b3758260af89b5d3aa03e658ad5529663`. Release workflow `44083393262` and main CI `44083387726` passed with 138 native and 69 Node checks; anonymous public installer/signature/updater verification passed. The release opens maximized and adds bounded temporary startup-lock recovery using the preloaded database. Eight production JavaScript fault-injection cases passed; exact Windows operating-system lock timing was not reproduced. The official Windows 0.3.1-to-0.3.2 upgrade and uninstall/reinstall preserved the current-entitlement fixture and verified maximized startup and the online gate. Linux signed replacement/relaunch preserved its fixture, without testing compensation or online GUI behavior. All 13 preview tables matched after startup with zero pack adjustment. Rules and reward entitlements are unchanged. See [historical 0.3.2 evidence and hashes](docs/phase-5-release.md#current-release-032).

**Historical delivered release: [0.3.1](https://github.com/yAnn1ck-B/eternal-league/releases/tag/v0.3.1).** Published unchanged at `2026-11-17T11:31:04Z`, release `448500359`, immutable commit `98ea670a7b2708a4ff5d8050e65f78714b6ea202`. Release workflow `44069450628` and main CI `44069443369` passed with 138 native and 59 Node checks; anonymous public installer/signature/updater verification passed. Windows actual NSIS upgrade verified the mandatory online gate, credited the reward adjustment once, and preserved progress through uninstall/reinstall. Linux verified actual signed replacement/relaunch with its current-entitlement fixture preserved; compensation and online GUI behavior were outside that probe. The formal preview audit allowed only +16 packs, the initial wildcard grant, and built-in rule refresh; existing cards/decks/history/receipts/schema/Forge exports remained unchanged. See [historical 0.3.1 evidence and hashes](docs/phase-5-release.md#current-release-031).

**Historical delivered release: [0.3.0](https://github.com/yAnn1ck-B/eternal-league/releases/tag/v0.3.0).** Published unchanged at `2026-11-17T10:06:54Z`, release `448393920`, immutable commit `1b22f49f534f1047d9b0026a5d16b2d39fd60b9d`. [Workflow 44055179189](https://github.com/yAnn1ck-B/eternal-league/actions/runs/44055179189) passed Windows/Linux builds, the first complete Actions updater-signing release, all 126 native and 55 Node checks, and full cryptographic draft verification. Anonymous verification of both installers and the public updater endpoint passed after publication.

The official Windows updater-signed NSIS package passed manual installation, 0.2.1-to-0.3.0 upgrade, uninstall/reinstall, and exact isolated progress preservation. Linux passed schema-7 package smoke and a real native signed upgrade from the published 0.2.1 AppImage to the exact 0.3.0 payload: MockRuntime drove the updater plugin, tampered bytes were rejected, both actual applications launched, and game/settings-probe/cache/Forge fixtures and permissions survived. Linux GUI interaction was not automated. See [current release evidence and payload hashes](docs/phase-5-release.md#historical-release-030). Earlier 0.2.x checks below remain historical records.

- [x] Separate the fresh permanent production identifier `com.eternalleague.desktop` from the preserved legacy development `.app` and isolated `.preview` profiles.
- [x] Add tracked development configuration and inject it for ordinary `npm run tauri dev`, while preserving explicit preview/verification config overrides. Eight isolated routing cases pass without launching an app or changing profile data.
- [x] Commit the fixed shared launch timestamp `1794847589` in `release-policy.json` and the built-in rules before the first tag, and verify clean production first launch. Local installed Windows and isolated Linux launches had no inherited game progress; existing development/preview data remains separate.
- [x] Verify local frozen production-candidate isolation: inherited preview clock was ignored, `.desktop` had zero inherited progress, preview sizing ACL was rejected, bundle resources contain no cloned database/snapshot, and the full repository-history audit found no private signing key. The official final Windows installer repeated these isolation checks successfully; later updates preserve production progress.
- [x] Use a public GitHub repository with GitHub Free. The user explicitly approved exposing source/history; public visibility is confirmed.
- [x] Configure pinned Windows 2022/Ubuntu 22.04 CI and tag-release workflows. Push CI run 43914055166 passed both platform builds, packaging, 96 native tests, and 21 Node tests; Linux installation smoke also passed.
- [x] Build replacement `0.2.1` and verify its private draft before publication. Tagged run 43925283400 passed both package jobs (100 native / 31 Node tests each). Its read-scoped draft-verifier failure was resolved by independent write-scoped run 43929551728, which passed actual full cryptographic verification. Future workflow permissions were fixed in 48f7c6f without moving the tag. Immutable `v0.2.0` remains rejected and unpublished.
- [x] Generate the Windows NSIS `.exe` installer. Local 0.2.1 version-bound signing, signature verification, actual silent uninstall/reinstall, and real signed upgrade from test-only 0.1.9 all passed with exact fixture/settings/cache preservation. The official final 0.2.1 asset also passed signature verification and cold launch against the canonical-LF factory database.
- [x] Generate the Linux `.AppImage` package. CI verified a clean schema-7 first launch and settings/cache probe retention after relaunch and AppImage file replacement in isolated directories. A separate real native signed-upgrade probe passed from QA 0.1.9 to the canonical-LF 0.2.0 AppImage; the final 0.2.1 AppImage separately passed package smoke, downloaded-byte checks, and full cryptographic verification.
- [x] Implement LOCAL updater signing (used for the historical 0.2.1 release and retained as a fallback): CI drafts raw installers, Codex signs offline using the updater key/DPAPI password, a separate attach step uploads only public signatures and `latest.json`, and full minisign verification runs before promotion. The user has now explicitly approved future Actions signing with the established key/password stored as repository Secrets; verify configuration and workflow outcomes without exposing values.
- [x] Suppress updater scheduling and prompts in development/preview builds. Three cold-configuration integration tests preserve updater settings across Windows/Linux and development/preview configuration merges.
- [x] Implement startup/four-hour update scheduling. The Windows startup notification was live-tested; controller tests cover the interval without claiming an installed four-hour wall-clock session.
- [x] Implement explicit update consent. Actual Windows Later dismissal caused no payload download; a tampered payload failed native verification, valid Retry remained on 0.1.9 until explicit Install and restart, and passive NSIS upgraded/relaunched 0.2.1 with preserved data. The Linux native signed-upgrade probe also passed with explicit harness control and tamper rejection; Linux GUI interaction was not automated; the actual Windows public-channel update also passed.
- [x] Require version preparation/validation across `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, its application entry in `Cargo.lock`, and `tauri.conf.json`; update `CHANGELOG.md`. Published versions and tags are immutable.
- [x] Publish initial public version `0.2.1`. The unchanged verified assets were promoted at 2026-11-17T00:13:37Z after explicit user approval. Release 447403813 is public; the rejected unpublished `0.2.0` tag remains immutable.
- [x] Verify anonymous public installer/updater downloads. Full `--published` verification passed both signatures and the latest updater endpoint without authorization headers.
- [x] Verify actual native public-channel startup/update behavior. QA 0.1.9 detected published 0.2.1 over production HTTPS, downloaded the real GitHub payload/signature, stayed on 0.1.9 until explicit Install and restart, then relaunched as 0.2.1 with the exact cards/deck/wildcards/settings/cache fixture retained.
- [x] Enable automatic Actions signing after separate explicit activation approval. Real encrypted-Secrets signing workflow 43987014045 passed fixture signing and public-key/version verification; `RELEASE_SIGNING_MODE=actions` is verified active. Secrets were not logged. The first full release in this mode completed with 0.3.0, including both platforms and cryptographic verification.
- [x] Publish the higher immutable `0.3.0` release through automatic Actions signing, verify exact signed installers and anonymous public delivery, and repeat real Windows/Linux upgrade-preservation checks.
- [x] Keep SQLite data and downloaded artwork outside installation files. Preserve collection, decks, wildcards, rewards, settings, and artwork across updates and reinstalls. Windows uninstall preserves user data by default.
- [x] Verify actual Linux native signed-upgrade preservation. Run 43922258852 launched QA 0.1.9 and upgraded 0.2.0 AppImages, rejected tampering, used the real native installer, and preserved two cards, one deck, seven wildcards, history, receipt, queued packs, settings, cache, permissions, and an external Forge deck. It did not automate GUI interactions and does not approve the replacement 0.2.1 artifacts.

Historical 0.2.x Windows evidence includes cold zero-progress production launch, exact fixture retention through uninstall/reinstall, native tamper rejection, and explicit 0.1.9-to-0.2.1 signed installation/restart. The fixture was restored to its verified factory database, the QA app uninstalled, and only its guarded QA-created manufacturer registry key removed; no AppData was deleted. A historical controlled QA cold restart recorded week four, 24 unopened packs, 184 cards, 64 wildcards, one deck, and suppressed development updater prompts. The user is now actively playing; the current preview remains preserved and running, with legitimately changing counts. Original 184-card/37-wildcard/one-deck data stayed unchanged. The repository is public, and release 0.2.1 is published unchanged. Official tagged Windows `0.2.0` failed against the existing LF factory QA database on migration checksum consistency; that unpublished candidate is rejected. Replacement `0.2.1` completed its private release gates with fixed LF migration bytes. Both exact official assets were locally signed and fully verified; green independent CI run 43929551728 verified the same five assets without key export. The official Windows artifact cold-launched without checksum error and the final Linux AppImage passed schema-7 smoke. Only known newline-variant migration-7 checksums were normalized in the backed-up preview and empty production-QA databases; game/catalog/settings digests stayed identical at that historical normalization checkpoint (preview 184 cards / 64 wildcards / one deck, QA zero progress). The legacy `.app` profile and all its tables/migration metadata stayed unchanged at 184 cards / 37 wildcards / one deck. No runtime checksum repair or data wipe was added. The user explicitly approved public visibility, v0.2.1 promotion, and storing the encrypted established updater key/password as GitHub Actions secrets for future releases. All three operations are confirmed; the full anonymous verifier passed. The native public HTTPS update/restart test and real encrypted-Secrets signing smoke both passed; automatic CI signing is explicitly authorized and active. At that 0.2.1 checkpoint its first full Actions release remained unperformed; 0.3.0 has since completed it, as recorded above. Full evidence and limits are in [Phase 5 release notes](docs/phase-5-release.md).

**Result:** Public Windows and Linux releases with signed optional updates, persistent player data, and a repeatable Codex release process.

### Shipped in 0.3.1: required version verification

The user explicitly replaced the optional-update policy, and 0.3.1 ships the required-verification gate. Normal league use requires successful online verification that the installed version is current, checked at startup, focus/reconnect, and every five minutes. There is no Later/dismiss bypass. Offline/check failures and download/signature/install/restart failures stay blocked and retryable. Keep separate explicit update steps and cryptographic verification. Recovery may expose only current-deck and Forge-folder repair needed to finish pending autosaves; other league activity remains blocked. Development/preview builds bypass the gate.

Version 0.3.3 keeps an already-verified `current` session usable during routine rechecks, without flashing the modal or disabling inputs. Startup/retry checks remain blocking. A failed result or detected update blocks immediately on completion; a successful no-update result stays quiet. Concurrent focus/periodic requests share one check.

Version 0.3.1 is published with this behavior. Already-shipped 0.3.0 uses optional updates and requires one ordinary upgrade to adopt it. Periodic client checks do not establish a central-server guarantee of simultaneous versions. The current release record above describes the actual installed Windows gate checks and the narrower Linux preservation scope.

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
