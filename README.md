# Eternal League

A Windows desktop companion to MTG Forge. Forge handles gameplay; Eternal League manages your permanent collection, decks, booster packs, and wildcards. Progress stays on your device.

## Run locally

Use Windows with Node.js 20.19+ (or a supported newer LTS), Rust 1.90+, the MSVC C++ build tools and Windows SDK, and WebView2. See the [official Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```powershell
npm install
npm run tauri dev
```

This workspace has an ignored Rust toolchain in `.tools/`. The npm wrapper uses it when present without changing the global PATH. Other checkouts use Rust from PATH. `npm run dev` starts only the Vite frontend; native file access and SQLite require the Tauri application.

## Forge setup and catalog

The app detects and checks Forge automatically. **Settings → Forge folders** has three required paths: the Forge installation, constructed-deck folder, and card-image cache. Detected paths appear in their inputs with a per-path status; browse or edit them if needed, then save. The installation's detected version also appears in the sidebar. Forge does not need to be running.

The catalog loads automatically during first setup. Later detected Forge-version changes extend it with missing printings. Existing catalog rows, collection quantities, decks, wildcard balances, and downloaded artwork are preserved. There are no manual catalog refresh/import, backup/restore, image-cache cleanup, integration-test, or test-export controls, and no Application settings section.

Existing Forge artwork is preferred. Missing images download on demand and are cached locally; known exact Forge filenames may also receive a new image without overwriting existing artwork. The dashboard banner prefers the modern **Vintage Masters Black Lotus**, displayed upright with its full proportions preserved. Unlocked expansions are displayed by their full names. The dashboard also shows the next expansion and its unlock date/bonus, or an alert when no future expansion remains on the shared calendar.

SQLite data lives in `%APPDATA%\com.eternalleague.app\eternal-league.db`, outside the source/build directories. Keep the application identifier and migration history stable when updating the app. Local browsing, card rules, deck editing, and progression work offline after setup; uncached artwork and missing catalog data require a connection.

**Settings → Appearance** offers Forest, Midnight, Slate, and Daylight themes, plus Standard or Larger text. Preferences persist locally. The app version appears beneath Forge's connection status. The layout fills the available window, and deck tiles expand to three or four columns on wider screens.

## Shared league rules

The canonical configuration is [src-tauri/league-rules.json](src-tauri/league-rules.json). It is included in the application build and shown read-only in **Settings → League rules**. Individual users cannot edit league rewards, pack composition, expansion availability, unlock order, or deck rules through Settings.

The current build uses:

- A shared start time of `1794801597` Unix seconds, on 16 November 2026.
- 12 starting packs and 4 packs each week.
- Wildcards: 4 common and 2 uncommon each week, 1 rare every two weeks, and 1 mythic every four weeks.
- Foundations (`FDN`) at week 0, followed by a fixed expansion unlock every four weeks through week 52. Each later unlock awards 8 additional packs reserved for that expansion.
- 15 pack slots: 10 common, 4 uncommon, and 1 rare/mythic; no basic-land slot.
- A 12.5% mythic chance in the rare slot and no random bonus wildcard drops.
- A 60-card main-deck minimum, 15-card sideboard maximum, and normal four-copy deck limit with card-specific exceptions.

The expansion calendar comes from the same canonical configuration:

| Week | Expansion | Theme | Extra packs |
|---|---|---|---|
| 0 | Foundations | Balanced starting pool, all five colors | 0 |
| 4 | Bloomburrow | Animal tribes, tokens, aggressive decks | 8 |
| 8 | Wilds of Eldraine | Enchantments, Adventures, fairy-tale themes | 8 |
| 12 | The Lost Caverns of Ixalan | Dinosaurs, explore, graveyard strategies | 8 |
| 16 | Outlaws of Thunder Junction | Outlaws, crime, plotting spells | 8 |
| 20 | Duskmourn: House of Horror | Horror creatures, Rooms, delirium | 8 |
| 24 | Kamigawa: Neon Dynasty | Ninjas, artifacts, enchantments | 8 |
| 28 | The Brothers' War | Artifact-heavy strategies, giant machines | 8 |
| 32 | Aetherdrift | Vehicles, racing, speed mechanics | 8 |
| 36 | Tarkir: Dragonstorm | Dragons, three-color clans | 8 |
| 40 | Edge of Eternities | Spacecraft, colorless and artifact strategies | 8 |
| 44 | Lorwyn Eclipsed | Elves, Goblins, Faeries, Changelings | 8 |
| 48 | Secrets of Strixhaven | Instants, sorceries, spell-focused decks | 8 |
| 52 | March of the Machine | Battles, Phyrexians, multiverse invasion | 8 |

Extra expansion packs are separate from the regular four weekly packs and can only open their assigned set. Late joiners also receive every reserved expansion reward already earned on the shared calendar. The booster page shows general and expansion-specific balances; opening all packs uses only the general balance plus the selected expansion's reserved packs.

Everyone uses the same league calendar. Joining later grants the starting packs plus all scheduled weekly packs and wildcards earned since that shared start. Existing players can claim all unclaimed weekly periods together; each period is granted once. Scheduled expansion unlocks also follow the shared calendar. Random pack contents remain individual to each opening.

## Collect and build

1. In **Booster packs**, join the league and open packs from an unlocked expansion. Open one or up to 100 packs together. All results appear immediately and remain in opening history.
2. In **Collection → All cards**, open a card to spend one matching-rarity wildcard on one printing from an unlocked set. Crafting is blocked at four total copies across all printings of that card.
3. In **Deck builder**, add owned printings or free basic lands. Deck tiles show artwork, mana cost, owned copies, and a read-only deck count. Use **+** and **−** to change quantities, and main-deck/sideboard tabs to choose the section. Artwork and names open the shared full card-details popup.
4. **Save deck** always saves to Forge as well as Eternal League. **Copy deck** creates a separate deck and Forge file. League decks live in an **Eternal League** subfolder within the configured Constructed deck folder. Later saves update the same managed file, and deleting a deck removes its managed Forge files. Incomplete owned decks can be saved as drafts, but must meet Forge's rules before play.

A nonbasic printing's combined quantity across main deck and sideboard cannot exceed the quantity owned. Native save/copy checks enforce this rule. Older drafts containing unowned cards remain loadable so they can be corrected. Decks never consume or reserve collection cards; the same owned copies can be used in multiple decks.

All Basic Land printings, including snow-covered basics and Wastes, are free and unlimited in decks. They do not require collecting or crafting; the exact printing still needs Forge support.

The permanent collection is capped at four copies per Oracle ID across sets and artwork. Packs select another eligible card of the same rarity when a card is already complete. When that rarity's pool is complete, its slots award matching wildcards instead. This protection applies across whole multi-pack transactions and concurrent requests. Rewards and operation receipts are saved atomically, so retrying a completed opening or craft does not spend or grant twice.

Displayed mana uses `1R` rather than `{1}{R}`. Fractional mana values remain searchable because cards such as Little Girl have half mana values; half symbols display as `½W` or `½R`. A separator divides wildcard balances from the collection browser.

Collection and deck searches match card names and rules text. Each word must match either field, so `gain life` can find `gain 3 life`; searches also support abilities such as `flying` and `deathtouch`. Existing ownership, color, expansion, and other filters still apply.

## Verification

```powershell
npm run build
npm test
```

See [Phase 2 and 3 verification](docs/phase-2-and-3-verification.md) and [finishing verification](docs/phase-4-verification.md). Earlier reports describe the interface at the time those checks ran; superseded test and maintenance controls are no longer in the app. The production frontend build and all 75 native tests pass. Desktop checks cover ability searches, Daylight notice contrast, native resizing/maximizing, responsive deck tiles, saved themes/text size, automatic Forge saves and deletion, and exact-printing compatibility with the installed Forge parser. Cold first-run/offline and normal-data preservation checks also passed; see the finishing notes for details.

The optional developer integration script uses the actual installed Forge parser and card scripts:

```powershell
# Run from the Forge installation folder; substitute absolute paths.
java -cp '<Forge desktop jar>' '<project>\scripts\ForgeDeckCheck.java' '<Forge install folder>' '<saved .dck>'
```

It checks parsing, supported cards, constructed conformance, and requested editions/collector numbers without launching a game. The latest installed-Forge check passed against Forge 2.0.13: the automatically saved 60-card main deck and 15-card sideboard parsed successfully, including all 75 exact printing copies.

## Delivery

The app runs locally through `npm run tauri dev`. GitHub release automation, a Windows installer, a Linux AppImage, and signed automatic updates remain Phase 5 and are not yet configured.
