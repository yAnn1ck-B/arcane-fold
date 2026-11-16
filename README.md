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

The catalog loads automatically during first setup. Later detected Forge-version changes extend it with missing printings from changed editions. An unchanged Forge version does not trigger a full catalog fetch. Existing catalog rows, collection quantities, decks, wildcard balances, and downloaded artwork are preserved. There are no manual catalog refresh/import, backup/restore, image-cache cleanup, integration-test, or test-export controls, and no Application settings section.

Existing Forge artwork is preferred. Missing images download on demand and are cached locally; known exact Forge filenames may also receive a new image without overwriting existing artwork. The dashboard banner prefers the modern **Vintage Masters Black Lotus**, displayed upright with its full proportions preserved. Mox Pearl, Mox Sapphire, Mox Jet, Mox Ruby, and Mox Emerald form five upright layers behind it; these banner cards do not add collection ownership. The banner has no artwork caption. Unlocked expansions are displayed by their full names. The dashboard also shows the next expansion and its unlock date/bonus, or an alert when no future expansion remains on the shared calendar.

Production SQLite data lives in `%APPDATA%\com.eternalleague.desktop\eternal-league.db`, outside the installation and build directories. Ordinary `npm run tauri dev` launches preserve the legacy `com.eternalleague.app` development profile, while the isolated preview uses `com.eternalleague.preview`. Production starts with its own clean profile; existing development databases and Forge files are left intact. Keep the production identifier and migration history stable across updates. Local browsing, card rules, deck editing, and progression work offline after setup; uncached artwork and missing catalog data require a connection.

The interface uses Daylight with Larger text. Appearance controls are removed; the existing theme CSS remains in the source. The app version appears beneath Forge's connection status. The layout fills the available window, and page navigation returns to the top without navigating away during Collection Add. **Cards per row** offers Auto (up to four columns) or 2 through 6 columns, caps the selection to the available editor width, and remembers it locally.

## Shared league rules

The canonical configuration is [src-tauri/league-rules.json](src-tauri/league-rules.json). It is included in the application build and shown read-only in **Settings → League rules**. Individual users cannot edit league rewards, pack composition, expansion availability, unlock order, or deck rules through Settings.

The current build uses:

- One shared start committed in `src-tauri/league-rules.json` before the first public release and kept stable afterward. Phase 4 notes retain the earlier development timestamp.
- 12 starting packs and 4 packs each week.
- Wildcards: 4 common and 2 uncommon each week, 1 rare every two weeks, and 1 mythic every four weeks.
- Foundations (`FDN`) at week 0, followed by a fixed expansion unlock every four weeks through week 52. Each later unlock awards 8 additional packs reserved for that expansion.
- 15 pack slots: 10 common, 4 uncommon, and 1 rare/mythic; no basic-land slot.
- A 12.5% mythic chance in the rare slot and no random bonus wildcard drops.
- A 60-card main-deck minimum, 15-card sideboard maximum, and normal four-copy deck limit with card-specific exceptions.

The expansion calendar comes from the same canonical configuration:

| Week | Expansion                   | Theme                                         | Extra packs |
| ---- | --------------------------- | --------------------------------------------- | ----------- |
| 0    | Foundations                 | Balanced starting pool, all five colors       | 0           |
| 4    | Bloomburrow                 | Animal tribes, tokens, aggressive decks       | 8           |
| 8    | Wilds of Eldraine           | Enchantments, Adventures, fairy-tale themes   | 8           |
| 12   | The Lost Caverns of Ixalan  | Dinosaurs, explore, graveyard strategies      | 8           |
| 16   | Outlaws of Thunder Junction | Outlaws, crime, plotting spells               | 8           |
| 20   | Duskmourn: House of Horror  | Horror creatures, Rooms, delirium             | 8           |
| 24   | Kamigawa: Neon Dynasty      | Ninjas, artifacts, enchantments               | 8           |
| 28   | The Brothers' War           | Artifact-heavy strategies, giant machines     | 8           |
| 32   | Aetherdrift                 | Vehicles, racing, speed mechanics             | 8           |
| 36   | Tarkir: Dragonstorm         | Dragons, three-color clans                    | 8           |
| 40   | Edge of Eternities          | Spacecraft, colorless and artifact strategies | 8           |
| 44   | Lorwyn Eclipsed             | Elves, Goblins, Faeries, Changelings          | 8           |
| 48   | Secrets of Strixhaven       | Instants, sorceries, spell-focused decks      | 8           |
| 52   | March of the Machine        | Battles, Phyrexians, multiverse invasion      | 8           |

Each expansion unlock adds eight reserved packs to the same persistent chronological queue as starting and weekly packs. A queued pack keeps its assigned expansion. **Open one pack** opens the next earned pack; **Open all** consumes the remaining queue in order, including multiple expansions. There is no expansion selector or manual reward-claim action.

Everyone uses the same league calendar. Starting automatically with the first opening grants the starting packs and all rewards already earned since the shared start. For existing leagues, status updates automatically credit due weekly packs, wildcards, and expansion rewards once. Pack contents remain individual to each opening.

## Collect and build

1. In **Booster packs**, use **Open one pack** or **Open all** beside the total available pack count and wildcard balances. The app starts the league and credits due rewards automatically, then opens the earned queue in order. Results appear together and remain in history.
2. In **Collection → All cards**, open a card to spend one matching-rarity wildcard on one copy from an unlocked set. Cards are grouped by Oracle identity into one tile, with one pooled owned total across printings and no repeated set-code summaries. Crafting stops at four total copies. An unowned card from a globally unlocked expansion can still be crafted.
3. Use **Add to deck** from Collection to choose a deck and section, or use the owned-card browser in **Deck builder**. The centered target chooser preserves an unsaved deck draft. Confirming **Add** to an existing deck keeps you in Collection and shows a success message. Basic lands appear in that same pool. The browser hides nonbasic cards after all owned copies are allocated to the current main deck and sideboard. Opening a deck selects its current colors, including colorless cards and lands. Use **+** and **−** for quantities; artwork and names open the shared details popup.
4. **Save deck** always saves to Forge as well as Eternal League. **Copy deck** creates a separate deck and Forge file. League decks live in an **Eternal League** subfolder within the configured Constructed deck folder. Later saves update the same managed file, and deleting a deck removes its managed Forge files. Incomplete owned decks can be saved as drafts, but must meet Forge's rules before play.

A nonbasic card's combined quantity across main deck and sideboard cannot exceed its pooled owned total. Owning the card allows any eligible printing from a globally unlocked expansion; collecting that card separately in each expansion is not required. Each card uses one selected printing throughout a deck, across both sections. Open card details to change it: printing metadata appears beneath the artwork, with a small **Printing** button only when multiple choices exist. In Deck builder, selecting a printing updates every copy of that card; in Collection it changes the preview. Details shows a simple owned count and no expansion-unlock list.

Printing, card-details, and target dialogs stay centered above Collection. Native save, copy, and export checks enforce pooled ownership, printing eligibility, and global set unlocks. Older mixed-printing decks use their first loaded printing for all copies in the editor; this change is saved only when you choose **Save deck**. Other invalid drafts remain loadable for correction. Decks never consume collection cards; the same owned copies can be used in multiple decks.

Basic lands are free and unlimited once their expansion unlocks. They do not require collecting or crafting. Every eligible basic-land variant becomes available as soon as its expansion is globally unlocked, without collecting that land first; the selected printing still needs Forge support.

The permanent collection is capped at four copies per Oracle ID across sets and artwork. Packs select another eligible card of the same rarity when a card is already complete. When that rarity's pool is complete, its slots award matching wildcards instead. This protection applies across whole multi-pack transactions and concurrent requests. Rewards and operation receipts are saved atomically, so retrying a completed opening or craft does not spend or grant twice.

Displayed mana uses `1R` rather than `{1}{R}`. Mana-value filters use existing integer values from 0 through 5 and a final 6+ bucket. Silver- and gold-bordered printings, acorn cards, and other novelty, nonstandard, and fractional-cost printings are excluded from browsing, crafting, packs, and deck use. Existing stored data and opening history are preserved.

Collection shows unfiltered Owned/All totals in its view buttons and compact wildcard balances on the right of the same toolbar. It has no separate wildcard strip or instructional caption. Counts refresh once per data revision, independently of typed filters. Dashboard wildcard rarity colors appear only on the dots; the text stays dark and tooltips identify each balance.

Collection and Deck builder share the same filters. Search matches card names and rules text, including phrases such as `gain life`; colors and mana values are multi-select pills. Owned-view rarity, expansion, color, mana-value, and type choices come from the actual eligible owned pool, including unlocked basic lands. Main card types use a dropdown, and creature-type suggestions load only after two characters. Advanced deck-browser filters are collapsed initially. The browser itself can be collapsed, stays at most 400 pixels wide, and displays cards in two columns. Deck tiles show the name and mana cost alongside their quantities and actions; long names truncate after two lines. Color buttons use swatches with accessible names, and the advanced-filter toggle is icon-only. Color and mana groups share a row in wider filter panels and stack in the narrow deck browser. Changing a deck quantity keeps the browser tiles visible while the available pool updates in the background. Filter requests use a small delayed loading indicator.

## Verification

```powershell
npm run build
npm test
```

See [Phase 2 and 3 verification](docs/phase-2-and-3-verification.md) and [finishing verification](docs/phase-4-verification.md). Earlier reports describe the interface at the time those checks ran; superseded test and maintenance controls are no longer in the app. The Phase 4 production frontend build and its 94-test native baseline passed; [Phase 5 verification](docs/phase-5-release.md) now records 96 native tests and 21 Node tests. The isolated four-week preview passed live checks of automatic rewards, chronological opening, stable Collection counts, details-only printing changes, and nested Add/details/picker dialogs. Desktop checks cover first-use Collection Add without navigation, centered dialogs, shared whole-deck printing changes, background allocation updates, persisted six-column density at 1920 pixels and a two-column cap at 980 pixels in Daylight with Larger text. All five Mox images loaded upright behind Black Lotus. Unsaved drafts and normal-profile data were preserved. Cold first-run/offline and normal-data preservation checks also passed; see the finishing notes for details.

The optional developer integration script uses the actual installed Forge parser and card scripts:

```powershell
# Run from the Forge installation folder; substitute absolute paths.
java -cp '<Forge desktop jar>' '<project>\scripts\ForgeDeckCheck.java' '<Forge install folder>' '<saved .dck>'
```

It preloads the installed Forge card scripts, then checks parsing, supported cards, constructed conformance, and exact requested editions/collector numbers without launching a game. The latest installed-Forge check passed against Forge 2.0.13: the newly saved 60-card main deck and 15-card sideboard parsed successfully, including all 75 exact copies using Llanowar Elves #439 and Forest #291.

Migration 006 adds a derived eligibility cache and browsing index without replacing card metadata. A normal-profile native IPC check of the full 120,135-printing catalog returned 32,668 grouped cards in 627 ms; owned facets took 299 ms. A separate development copy measured a one-time cold eligibility backfill of about 18 seconds. The earlier schema-6 normal-profile audit preserved all saved progression, decks, settings, and catalog rows: 184 owned cards, 37 wildcards, one Test deck, and 120,135 catalog printings, with SQLite integrity `ok`.

## Development preview

`ETERNAL_LEAGUE_PREVIEW_WEEKS=4` advances only the development build's league clock by four weeks. Release builds ignore this variable, and the operating-system clock is unchanged. Preview work uses the isolated `com.eternalleague.preview` clone of the normal profile and a separate workspace Forge-export folder, so earned rewards and test exports do not change the original league. The preview cloned the current normal profile (184 owned cards, 37 wildcards, and one Test deck). Advancing four weeks automatically awarded 24 packs and brought wildcards to 64; the clean handoff baseline has been restored to 184 owned cards, 24 unopened packs, 64 wildcards, and the original 11-card Test main deck. A fresh safety-backup comparison matched all 11 original-profile tables exactly, including settings, migrations, and receipts; the original catalog stayed at 120,135 printings with SQLite integrity `ok`.

## Delivery and future releases

Phase 5 adds a public GitHub release workflow for a Windows NSIS installer, Linux AppImage, and signed Tauri updates. Delivery validation is tracked in [Phase 5 release notes](docs/phase-5-release.md); earlier local application checks do not replace installer and updater tests.

Production uses the fresh permanent identifier `com.eternalleague.desktop`. This supplies the clean first-release baseline without deleting the existing development or preview profiles. The real shared start is fixed at `1794847589` in `release-policy.json` and the built-in rules; commit both before the first tag. Later updates must preserve that anchor and all player progress. Preview configuration, cloned databases, signing secrets, and development artifacts are excluded from releases.

Every new publish requires a new higher SemVer version across the five application manifests/lockfiles. The release helpers prepare and validate the version, then create an immutable tag whose workflow builds a draft. By default CI drafts only the two raw installers. Codex signs them locally in an offline step, then separately attaches public signatures plus `latest.json`, verifies both installers cryptographically, and promotes the draft. Private signing material stays on this PC; optional Actions signing requires explicit credential-export approval. See [AGENTS.md](AGENTS.md) for the durable Codex release instructions and the exact command sequence.
