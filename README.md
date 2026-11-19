# Eternal League

## Browser edition

The `experiment/web-multiplayer` branch runs the league in a browser. A Node.js server owns the matches and runs Forge Desktop 2.0.13 with JDK 17. PostgreSQL holds each browser profile’s collection, deck lists, rewards, rooms, game history and issue reports.

**Play locally.** Open [Eternal League](http://127.0.0.1:4317/?page=play), choose a saved deck or one of the two Foundations practice decks, then select **Create table**. Open the invitation in another browser profile or private window and select **Join table**. Each player sees their own hand and makes their own decisions. Each browser can reload the table or return to it from **Your tables**. Keep the session cookie to retain access to that player’s league. Closing a private window may discard its identity.

**At the table.** Your seat appears next to **Play**. The board tells you when you have a decision and when the opponent is choosing. To take back a play, open the game log, choose the position you want to return to and request an undo. Either player can also request a switch to manual play. Play pauses for the other player to accept or decline. Manual play starts from the agreed position, and its undo history begins there.

**Report a play.** Use **Report game issue** on the table or in a decision dialog and briefly describe what you expected. The report captures the position you were looking at when you clicked. PostgreSQL retains the reporting seat’s view, choices, controls, public history, match ID and revision. The database operator can follow that revision to the original position, including after an agreed undo.

To investigate recent reports, run this query in the web database. For Forge games, the replay cursor identifies the move and priority settings. A retired position points to its original journal in `web_forge_journals` through `(room_id, retired_at)`. A manual position stores its full state in `web_positions.manual_checkpoint`.

```sql
SELECT r.id, r.created_at, r.details, r.room_id, r.revision, r.seat,
       r.snapshot, p.replay_cursor, p.retired_at
FROM web_reports AS r
JOIN web_positions AS p USING (room_id, revision)
ORDER BY r.created_at DESC
LIMIT 20;
```

### Run the web server

Install Node.js 20.19+, PostgreSQL, Forge Desktop 2.0.13 and JDK 17, and put `java` on PATH. In PowerShell, from the repository root:

```powershell
npm ci
$env:FORGE_INSTALL = 'C:\path\to\Forge 2.0.13'
npm run web:db -- --local
npm run web:catalog
npm run web:build
npm start
```

The local setup uses the PostgreSQL 18 tools under Program Files on Windows or PostgreSQL tools on PATH on Linux. Set `PG_BINDIR` for another installation. It creates a dedicated password-protected cluster on loopback port 55432 and database `eternal_league_web`. Run the same database command after restarting the computer. Keep `.web-data` and the ignored `.env.web` with your database backups. To use an existing PostgreSQL database instead, configure `DATABASE_URL` in `.env.web` and run `npm run web:db`. With a PostgreSQL administrator login configured through the PG environment variables, the same command can create the named database first.

The web server binds to `127.0.0.1:4317` by default. Two browser profiles on this computer can play together. An operator serving other devices can configure `WEB_HOST`, `WEB_PORT` and the exact `WEB_ORIGIN` and put the service behind HTTPS. Forge and the database stay on the host. Web profiles begin with the standard shared-calendar entitlements.

`web:catalog` loads Scryfall metadata for the installed Forge editions. For an offline setup, pass `--jsonl <scryfall-records.jsonl>` or `--sqlite <desktop-catalog-snapshot.db>` after `npm run web:catalog --`. The SQLite reader imports only public card metadata. Set `WEB_CARD_IMAGE_CACHE` to a desktop `card-images` directory to reuse its artwork read-only.

## Desktop edition

A desktop companion to MTG Forge. Eternal League manages your permanent collection, decks, booster packs, and wildcards. Forge provides rules-enforced games and computer opponents. Progress stays on your device.

Download [Eternal League 0.4.0](https://github.com/yAnn1ck-B/eternal-league/releases/tag/v0.4.0) for Windows or Linux. Published on 18 November 2026, it adds Discovery wildcards for first copies, restricts ordinary wildcards to owned-card copies, alternates mythic and Discovery rewards, and matches crafting controls to wildcard colors. Existing earned/spent progress is preserved, with missing Discovery entitlements credited once. Both signed installers and the public update endpoint passed cryptographic verification. See [release evidence](docs/phase-5-release.md#current-release-040).

## Required version verification

Production releases from 0.3.1 onward require an online check confirming that the installed version is current before the league can be used. Checks run at startup, when focus returns or connectivity resumes, and every five minutes. There is no Later/dismiss option. Offline/check failures and update download, signature, installation, or restart failures keep the league blocked with retry actions. Download, installation, and restart remain separate explicit steps. Limited deck/Forge-folder repair stays available only to finish pending deck saves; other league actions remain blocked. Development/preview builds bypass the gate.

From 0.3.3 onward, rechecks retain an already-verified session while the request runs, without a checking dialog or disabling the app. A failed result or newly available version blocks when the result arrives; startup and retries after failures still show the required verification screen.

Published **0.3.0 still has optional updates** and needs one ordinary upgrade to adopt this behavior. These client-side checks do not guarantee that every device changes version at the same instant. This policy first shipped in 0.3.1.

## Play (upcoming release)

Use **Report game issue** at the table or in a decision dialog when a play looks wrong. Opening the report captures that seat’s board, available choices and public game history at that moment. Describe what you expected, then save the report. The desktop app keeps the report in its SQLite database in `game_issue_reports`.

Open **Play**, select the players’ saved decks, and choose **Start game**. You can use the same deck for both seats or choose a solo opponent that passes. Each selected main deck needs at least seven cards. Local rules-enforced play uses Forge Desktop 2.0.13 from Settings and a JDK 17 or newer with `java` on PATH.

Keep your opening hand or mulligan. After a mulligan, choose the cards to put on the bottom. When testing both seats, the table switches directly to the player who needs to decide. The current seat sees its own hand. Use the switch-player icon near the end of the toolbar to inspect the other seat.

Creatures face each other across the middle of the table. Lands sit behind them, and artifacts, enchantments and other support cards sit to the right. Select a mana source to activate it. When the source offers multiple abilities or mana colors, choose which one to use. Open either player’s mana counter for its breakdown by color, including colorless. Open **Stack** for pending spells and abilities or **Game log** for the newest public actions. **Undo** replays the previous decision with the original shuffle and decisions. Leaving a rules-enforced game ends its in-memory session.

Use **Switch to manual play** during a game to take over both seats and resolve effects yourself. Confirm the switch and, if prompted, replacement of the existing saved game. The manual table starts at the current position, retains the public log, and saves each move locally. Manual Undo starts at the switch and retains up to 128 moves. **Resume** reopens a saved manual game, including games saved under the former Playtest name. **Remove** deletes that match and its undo history after confirmation.

Play offers casts from other zones when a card grants permission. Open the library counter to see its top card when your seat is allowed to look. The board also prompts for decisions such as dividing counters, assigning combat damage and choosing a card to discard as payment. [Foundations gameplay verification](docs/foundations-play-audit.md)

**Stops** controls when Forge waits for your seat. **Automatic** offers available plays and responses, including tapping lands during your main phases. **Set a stop** adds one pause at your next opportunity or at a selected step such as **After blockers**, on either turn. **Full control** pauses each time you receive priority, which can happen more than once in a step.

**Next** advances play on your turn, **Pass** passes an opportunity on the other player’s turn, and **Resolve** lets the top spell or ability resolve once both seats pass. In Automatic, **End Turn** passes your remaining optional opportunities on your turn. Forge still handles attackers, discards, triggers and responses. From the second main phase onward, End Turn becomes the sole advance action on an empty stack. With an explicit stop, End Turn becomes available in the ending phase.

## Run locally

Use Windows with Node.js 20.19+ (or a supported newer LTS), Rust 1.90+, the MSVC C++ build tools and Windows SDK, and WebView2. See the [official Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```powershell
npm install
npm run tauri dev
```

This workspace has an ignored Rust toolchain in `.tools/`. The npm wrapper uses it when present without changing the global PATH. Other checkouts use Rust from PATH. `npm run dev` starts only the Vite frontend; native file access and SQLite require the Tauri application.

## Forge setup and catalog

The app detects and checks Forge automatically. If the usual installation locations are empty, a bounded background search checks local Desktop/Downloads and portable-app folders, executable and registry hints, then local fixed drives for `forge.exe` with Forge's edition and card resources. **Settings → Forge folders** has three required paths: the Forge installation, constructed-deck folder, and card-image cache. Detected paths appear in their inputs with a per-path status; browse or edit them if needed, then save. If setup cannot find Forge, **Configure Forge** opens the installation field; saving valid folders resumes the catalog setup automatically. The installation's detected version also appears in the sidebar. Forge does not need to be running.

The catalog loads automatically during first setup. Later detected Forge-version changes extend it with missing printings from changed editions. An unchanged Forge version does not trigger a full catalog fetch. Existing catalog rows, collection quantities, decks, wildcard balances, and downloaded artwork are preserved. There are no manual catalog refresh/import, backup/restore, image-cache cleanup, integration-test, or test-export controls, and no Application settings section.

Existing Forge artwork is preferred. Missing images download on demand and are cached locally; known exact Forge filenames may also receive a new image without overwriting existing artwork. The dashboard banner prefers the modern **Vintage Masters Black Lotus**, displayed upright with its full proportions preserved. Mox Pearl, Mox Sapphire, Mox Jet, Mox Ruby, and Mox Emerald form five upright layers behind it; these banner cards do not add collection ownership. The banner has no artwork caption. Unlocked expansions use a compact count with an expandable list of full names. The dashboard also shows the next expansion and its unlock date/bonus, or an alert when no future expansion remains on the shared calendar.

Production SQLite data lives in `%APPDATA%\com.eternalleague.desktop\eternal-league.db`, outside the installation and build directories. Ordinary `npm run tauri dev` launches share the played `com.eternalleague.preview` development profile, its existing four-week offset, and its saved Forge export folder. The normal frontend origin is `http://localhost:1420`. The earlier `com.eternalleague.app` profile is retained on disk. Production starts with its own clean profile; existing development databases and Forge files are left intact. Keep the production identifier and migration history stable across updates. SQL migrations use canonical LF bytes on every platform, enforced by checkout attributes, version validation, and a native build guard. Published 0.3.0 supports local browsing, card rules, deck editing, and progression offline after setup; uncached artwork and missing catalog data require a connection. Versions from 0.3.1 onward require online verification before normal use, as described above.

The interface opens maximized and uses Daylight with Larger text and compact page headings. Appearance controls are removed; the existing theme CSS remains in the source. The app version appears beneath Forge's connection status. The layout fills the available window, and page navigation returns to the top without navigating away during Collection Add. The deck builder groups a compact deck selector and rename icon on the left, with space before New, Copy, and Delete on the right. **Cards per row** offers responsive Auto (up to five columns with the card browser open or seven with it collapsed) or exact choices from 2 through 7. Fixed choices remain unchanged on resize or maximize; narrow card areas scroll horizontally when needed. The choice is remembered locally.

## Shared league rules

The canonical configuration is [src-tauri/league-rules.json](src-tauri/league-rules.json). It is included in the application build and shown read-only in **Settings → League rules**. **Settings → Expansion calendar** marks the current week and expansion, unlocked entries, and upcoming unlocks. Individual users cannot edit league rewards, pack composition, expansion availability, unlock order, or deck rules through Settings.

Version 0.4.0 ships the following shared rules. Published 0.3.3 retains its earlier crafting rules and mythic timing until upgraded; published 0.3.0 retains its earlier 12 starting packs and 4 weekly packs until upgraded:

- One shared start committed in `src-tauri/league-rules.json` before the first public release and kept stable afterward. Phase 4 notes retain the earlier development timestamp.
- 20 starting packs and 6 packs each week.
- Starting wildcards: 10 common, 5 uncommon, 2 rare, 1 mythic, and 1 Discovery.
- Wildcards: 4 common and 2 uncommon each week, 1 rare every two weeks, and 1 mythic every four weeks starting at week 2 (weeks 2, 6, 10, ...). Discovery grants alternate with mythics at weeks 4, 8, 12, and every four weeks thereafter.
- Foundations (`FDN`) at week 0, followed by a fixed expansion unlock every four weeks through week 52. Each later unlock awards 8 additional packs reserved for that expansion.
- 15 pack slots: 10 common, 4 uncommon, and 1 rare/mythic; no basic-land slot.
- A 12.5% mythic chance in the rare slot and no random bonus wildcard drops.
- One shared recipe for every expansion: only common nonbasic lands have half the selection weight. Packs normally contain at most one nonbasic land overall, giving mythic/rare lands priority, then uncommon, then common. Uncommon, rare, and mythic lands use full selection weight; free basic lands never occupy pack slots.
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

Everyone uses the same league calendar. On first app use after successful online version verification, the initial league status grants starting packs and wildcards together, plus all rewards already earned since the shared start. Catalog setup and booster opening are not required to receive the grant. For existing leagues, status updates automatically credit due weekly packs, wildcards, and expansion rewards once. The saved entitlement ledger prevents another starting grant, including after spending wildcards or restarting. Pack contents remain individual to each opening. The historical 0.3.1 reward adjustment adds only the unpaid difference for existing started leagues: 8 starting packs, 2 packs per previously credited week, and the new starting wildcard grant, once. The 0.4.0 Discovery update adds the missing starting Discovery and due calendar rewards once, while preserving previously earned mythics and spent balances. Cards, decks, packs, and opening history are retained.

## Collect and build

From 0.4.0 onward, **All cards** and its totals, filters, and creature-type suggestions show only unlocked expansions. Newly unlocked expansions appear automatically; stored catalog, ownership, and history are preserved.

1. In **Booster packs**, use **Open one pack** or **Open all** beside the total available pack count and wildcard balances. The app credits any newly due rewards automatically, then opens the earned queue in order. All cards appear together after an opening. The next opening replaces the reveal, and leaving the page clears it automatically; there is no Clear contents button. Openings remain in history under their full expansion names.
2. In **Collection → All cards**, open an owned card to spend one matching-rarity wildcard on an additional copy, or use **Discover card** to spend one Discovery wildcard on the first copy of an unowned card of any standard rarity. Both require an eligible nonbasic printing from an unlocked expansion. Cards are grouped by Oracle identity into one tile, with one pooled owned total across printings and no repeated set-code summaries. Crafting stops at four total copies; owning another printing counts as already owning the card. Crafting buttons and panels match their wildcard colors. Overview shows the Discovery name; Collection and Booster packs show its violet dot and number, with a tooltip and accessible label.
3. Use **Add to deck** from Collection to choose a deck and section, or use the owned-card browser in **Deck builder**. The centered target chooser preserves an unsaved deck draft. Confirming **Add** to an existing deck keeps you in Collection and shows a success message. Basic lands appear in that same pool. The browser hides nonbasic cards after all owned copies are allocated to the current main deck and sideboard. Opening a deck selects its current colors, including colorless cards and lands. Use **+** and **−** for quantities; artwork and names open the shared details popup.
4. Deck edits save automatically to Forge and Eternal League, including card quantities, printing changes, and renaming. There is no Save button or routine saving/saved status label. **New deck** and **Copy deck** use centered naming dialogs: New starts with an empty name, while Copy suggests an editable name. A valid name must be confirmed before creation; canceling does not create a deck. Rename and Delete also use centered dialogs, and deleting requires confirmation. League decks live in an **Eternal League** subfolder within the configured Constructed deck folder. Later edits update the same managed file, and deleting a deck removes its managed Forge files. Incomplete owned decks can be saved as drafts, but must meet Forge's rules before play. Save failures remain visible with Retry, and switching decks waits for pending saves.

A nonbasic card's combined quantity across main deck and sideboard cannot exceed its pooled owned total. Owning the card allows any eligible printing from a globally unlocked expansion; collecting that card separately in each expansion is not required. Each card uses one selected printing throughout a deck, across both sections. Open card details to change it: printing metadata appears beneath the artwork, with a small **Printing** button only when multiple choices exist. In Deck builder, selecting a printing updates every copy of that card; in Collection it changes the preview. Details shows a simple owned count and no expansion-unlock list.

Printing, card-details, and target dialogs stay centered above Collection. Native save, copy, and export checks enforce pooled ownership, printing eligibility, and global set unlocks. Older mixed-printing decks use their first loaded printing for all copies in the editor; this normalization is persisted with the next automatic save. Other invalid drafts remain loadable for correction. Decks never consume collection cards; the same owned copies can be used in multiple decks.

Basic lands are free and unlimited once their expansion unlocks. They do not require collecting or crafting. Every eligible basic-land variant becomes available as soon as its expansion is globally unlocked, without collecting that land first; the selected printing still needs Forge support.

Pack selection first chooses a card identity, then an artwork variant; extra printings never increase its chance. Higher-rarity slots choose before lower-rarity slots, while results retain their familiar common-to-mythic display order. It prefers different identities within a pack. The shared land limit and within-pack variety relax when only the remaining collectable cards would otherwise be excluded. A matching wildcard replaces a slot only when all eligible identities of that rolled rarity have reached four copies. Packs keep their 15 slots, rare/mythic odds, and ordinary non-land rarity balance; the land preference has no set-specific overrides. Old openings, receipts, rewards, and collected cards are preserved.

The permanent collection is capped at four copies per Oracle ID across sets and artwork. Packs select another eligible card of the same rarity when a card is already complete. When that rarity's pool is complete, its slots award matching wildcards instead. This protection applies across whole multi-pack transactions and concurrent requests. Rewards and operation receipts are saved atomically, so retrying a completed opening or craft does not spend or grant twice.

Displayed mana uses `1R` rather than `{1}{R}`. Mana-value filters use existing integer values from 0 through 5 and a final 6+ bucket. Silver- and gold-bordered printings, acorn cards, and other novelty, nonstandard, and fractional-cost printings are excluded from browsing, crafting, packs, and deck use. Existing stored data and opening history are preserved.

Collection shows unfiltered Owned/All totals in its view buttons and compact wildcard balances on the right of the same toolbar. Collection and Booster packs reuse the same wildcard-counter component: a visible Wildcards label, colored rarity dots, and counts, with rarity names in tooltips and accessible labels. It has no separate Collection wildcard strip or instructional caption. Counts refresh once per data revision, independently of typed filters. Dashboard wildcard rarity colors appear only on the dots; the text stays dark and tooltips identify each balance.

Collection and Deck builder share the same filters. Search matches card names and rules text, including phrases such as `gain life`; colors and mana values are multi-select pills. Owned-view rarity, expansion, color, mana-value, and type choices come from the actual eligible owned pool, including unlocked basic lands. Main card types use a dropdown, and creature-type suggestions load only after two characters. Advanced deck-browser filters are collapsed initially. The browser itself can be collapsed, stays at most 400 pixels wide, and displays cards in two columns. Deck tiles show the name and mana cost alongside their quantities and actions; long names truncate after two lines. Color buttons use swatches with accessible names, and the advanced-filter toggle is icon-only. Color and mana groups share a row in wider filter panels and stack in the narrow deck browser. Changing a deck quantity keeps the browser tiles visible while the available pool updates in the background. Filter requests use a small delayed loading indicator.

## Verification

Current [0.3.3](https://github.com/yAnn1ck-B/eternal-league/releases/tag/v0.3.3) was published unchanged at `2026-11-17T15:06:03Z` (22:06 Bangkok), release `448755101`, immutable commit `caaa79e7beb2948025432e6ab90e393e07120f08`. [Release workflow 44104854001](https://github.com/yAnn1ck-B/eternal-league/actions/runs/44104854001) and [main CI 44104844797](https://github.com/yAnn1ck-B/eternal-league/actions/runs/44104844797) passed with 143 native and 71 Node checks. Full draft and anonymous public installer/signature/updater verification passed. The actual Windows 0.3.2-to-0.3.3 upgrade and uninstall/reinstall preserved all ten game tables, including seven spent-down common wildcards, zero other wildcards, and three queued packs. A fresh Windows launch granted 20 packs and 10 common, 5 uncommon, 2 rare, and 1 mythic wildcard with zero owned cards, decks, history, or receipts. It detected Forge 2.0.13, prepared 120,139 catalog printings, and loaded all six banner images. Linux package smoke observed legitimate period-zero rewards and preserved them through relaunch and AppImage file reinstall. Native Linux signed replacement from 0.2.1 preserved its current-entitlement fixture, with compensation and online GUI behavior outside that probe. All 13 preview tables matched after 0.3.3 initialization with zero pack adjustment. See [current release evidence and hashes](docs/phase-5-release.md#current-release-033).

Historical [0.3.2](https://github.com/yAnn1ck-B/eternal-league/releases/tag/v0.3.2) was published unchanged at `2026-11-17T13:04:56Z`, immutable commit `59dbc72b3758260af89b5d3aa03e658ad5529663`. [Release workflow 44083393262](https://github.com/yAnn1ck-B/eternal-league/actions/runs/44083393262) and [main CI 44083387726](https://github.com/yAnn1ck-B/eternal-league/actions/runs/44083387726) passed, including 138 native and 69 Node checks. Eight production JavaScript fault-injection cases covered temporary and persistent startup locks and permanent errors; the exact Windows operating-system lock timing was not reproduced. The official Windows 0.3.1-to-0.3.2 upgrade and uninstall/reinstall verified maximized startup, the online gate, and exact fixture preservation. Linux verified signed replacement and preservation with current entitlements pre-recorded; compensation and online GUI behavior were outside that probe. Anonymous public installer/signature/updater verification passed. See [historical 0.3.2 evidence and hashes](docs/phase-5-release.md#current-release-032).

Historical [0.3.1](https://github.com/yAnn1ck-B/eternal-league/releases/tag/v0.3.1) was published unchanged at `2026-11-17T11:31:04Z`, immutable commit `98ea670a7b2708a4ff5d8050e65f78714b6ea202`. [Release workflow 44069450628](https://github.com/yAnn1ck-B/eternal-league/actions/runs/44069450628) and [main CI 44069443369](https://github.com/yAnn1ck-B/eternal-league/actions/runs/44069443369) passed, including 138 native and 59 Node checks. The Windows 0.3.0-to-0.3.1 installer upgrade verified the online gate before applying the one-time reward difference; uninstall/reinstall did not grant it twice. Linux verified signed replacement and preservation with current reward entitlements pre-recorded, without testing compensation or online GUI behavior. Anonymous public installer/signature/updater verification passed. See [historical 0.3.1 evidence and hashes](docs/phase-5-release.md#current-release-031).

```powershell
npm run build
npm run test:decks
npm test
```

The game integration suite uses JDK 17 and the card scripts from Forge Desktop 2.0.13. It runs isolated matches with temporary decks. Run it separately from the default native tests.

```powershell
$env:FORGE_BOLT_TEST_INSTALL = 'C:\path\to\Forge 2.0.13'
npm run test:forge
```

The historical 0.3.0 baseline passed the frontend build, all 126 native checks (122 unit, one migration guard, and three cold-configuration tests), and 55 Node checks (24 deck-autosave/lifecycle checks plus 31 updater/version/verifier/migration checks). The full locked suite passed in a fresh checkout with Rust 1.90 and in both tagged Windows/Linux jobs. An isolated Windows desktop profile verified missing-Forge configuration and automatic setup resumption, compact deck controls and naming dialogs, automatic Forge saves and failure retries, and exact numbered column counts. Auto now rounds up at borderline widths: a scaled laptop layout at 1463 pixels and 175% DPI showed 4 open / 7 collapsed, while 1920 pixels showed 5 open / 7 collapsed. Lost-response checks covered new-deck deduplication and Collection quantity changes and target switching up to four copies. Shared wildcard visuals, full expansion names in opening history, and automatic reveal clearing also passed. Native pack tests cover common-only reduced weight, higher-rarity land priority, normal uncommon identity weighting, shared land preferences, printing-neutral odds, pack variety, rarity odds, basic exclusion, and completion fallbacks. Aggregate simulations covered 650,000 fresh packs across the 13 populated scheduled expansions; the missing Secrets of Strixhaven pool was not simulated. Desktop pack checks used separate data and Forge exports. Native integration tests were not rerun while the actively played preview was running.

Historical release [0.3.0](https://github.com/yAnn1ck-B/eternal-league/releases/tag/v0.3.0) was published unchanged at 2026-11-17T10:06:54Z from immutable commit `1b22f49f534f1047d9b0026a5d16b2d39fd60b9d`. [Tagged workflow 44055179189](https://github.com/yAnn1ck-B/eternal-league/actions/runs/44055179189) completed both platform builds, Actions updater signing, and five-asset cryptographic verification. Anonymous downloads and the public updater endpoint also passed. Windows checks installed the official updater-signed NSIS package, upgraded 0.2.1 to 0.3.0, and uninstalled/reinstalled it with progress preserved. Linux used the real native updater through MockRuntime, rejected tampered bytes, replaced the actual AppImage, and relaunched both official versions with its isolated fixture intact; Linux GUI interaction was not automated. The first public release, 0.2.1, remains historical evidence; rejected `0.2.0` stays unpublished. See [release evidence and payload hashes](docs/phase-5-release.md#historical-release-030).

See [Phase 2 and 3 verification](docs/phase-2-and-3-verification.md) and [finishing verification](docs/phase-4-verification.md). Earlier reports describe the interface at the time those checks ran; superseded test and maintenance controls are no longer in the app. The Phase 4 production frontend build and its 94-test native baseline passed; the historical 0.2.1 [Phase 5 verification](docs/phase-5-release.md) records 100 native tests (96 unit, one migration-guard, and three cold-configuration integration tests) and 31 Node tests (13 updater, two version, 13 release-verifier, and three migration-policy tests). The isolated four-week preview passed live checks of automatic rewards, chronological opening, stable Collection counts, details-only printing changes, and nested Add/details/picker dialogs. Earlier desktop checks covered first-use Collection Add without navigation, centered dialogs, shared whole-deck printing changes, background allocation updates, and the former responsive density behavior at 1920 and 980 pixels in Daylight with Larger text. The current exact 2-7 choices and responsive Auto behavior are described above; the older viewport results do not describe fixed-count resizing. All five Mox images loaded upright behind Black Lotus. Unsaved drafts and normal-profile data were preserved. Cold first-run/offline and normal-data preservation checks also passed; see the finishing notes for details.

The optional developer integration script uses the actual installed Forge parser and card scripts:

```powershell
# Run from the Forge installation folder; substitute absolute paths.
java -cp '<Forge desktop jar>' '<project>\scripts\ForgeDeckCheck.java' '<Forge install folder>' '<saved .dck>'
```

It preloads the installed Forge card scripts, then checks parsing, supported cards, constructed conformance, and exact requested editions/collector numbers without launching a game. The latest installed-Forge check passed against Forge 2.0.13: the newly saved 60-card main deck and 15-card sideboard parsed successfully, including all 75 exact copies using Llanowar Elves #439 and Forest #291.

Migration 006 adds a derived eligibility cache and browsing index without replacing card metadata. A normal-profile native IPC check of the full 120,135-printing catalog returned 32,668 grouped cards in 627 ms; owned facets took 299 ms. A separate development copy measured a one-time cold eligibility backfill of about 18 seconds. The earlier schema-6 normal-profile audit preserved all saved progression, decks, settings, and catalog rows: 184 owned cards, 37 wildcards, one Test deck, and 120,135 catalog printings, with SQLite integrity `ok`.

## Development preview

`ETERNAL_LEAGUE_PREVIEW_WEEKS=4` advances only the development build's league clock by four weeks. Release builds ignore this variable, and the operating-system clock is unchanged. The played development profile began as a clone of the original profile with a separate workspace Forge-export folder. At QA setup, the preview cloned the then-current normal profile (184 owned cards, 37 wildcards, and one Test deck). Advancing four weeks automatically awarded 24 packs and brought wildcards to 64. A controlled QA checkpoint recorded 184 owned cards, 24 unopened packs, 64 wildcards, and the original 11-card Test main deck. The user has since resumed playing; the current preview is preserved and running, and those historical counts are not restoration targets. A fresh safety-backup comparison matched all 11 original-profile tables exactly, including settings, migrations, and receipts; the original catalog stayed at 120,135 printings with SQLite integrity `ok`.

## Delivery and future releases

Phase 5 adds a public GitHub release workflow for a Windows NSIS installer, Linux AppImage, and signed Tauri updates. Delivery validation is tracked in [Phase 5 release notes](docs/phase-5-release.md); earlier local application checks do not replace installer and updater tests.

Production uses the fresh permanent identifier `com.eternalleague.desktop`. This supplies the clean first-release baseline without deleting the existing development or preview profiles. The real shared start is fixed at `1794847589` in `release-policy.json` and the built-in rules; commit both before the first tag. Later updates must preserve that anchor and all player progress. Preview configuration, cloned databases, signing secrets, and development artifacts are excluded from releases.

Every new publish requires a new higher SemVer version across the five application manifests/lockfiles. The release helpers prepare and validate the version, then create an immutable tag whose workflow builds a draft. The first 0.2.1 artifacts were signed locally and attached as public signatures plus `latest.json`. Release 0.3.0 completed the first full GitHub Actions signing run with the established key; automatic Actions signing remains enabled and local signing remains a fallback. Both paths require full cryptographic verification before draft promotion. Secrets must never be committed, printed, or included in release assets. See [AGENTS.md](AGENTS.md) for the durable Codex release instructions and the exact command sequence.
