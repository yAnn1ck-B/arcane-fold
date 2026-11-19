# Arcane Fold

Arcane Fold is a browser-based Magic league. Open packs, build a collection and play with a friend. PostgreSQL stores each player’s decks, rewards, matches and reports. The host runs Forge 2.0.13 to enforce the rules.

## Sign in

Database setup creates two player accounts, **Yannick** (`yannick@arcane-fold.test`) and **Jef** (`jef@arcane-fold.test`). The first setup generates a password for each and saves them in `.web-data/player-logins.json` on the host. Keep this file with your private backups. Running setup again preserves both logins.

On the host computer, open the loopback address and choose either name under **Local play** to skip entering a password. Use separate browser profiles or a regular and a private window to play both seats on one computer. On a hosted installation, sign in with your email and generated password. Set `WEB_LOCAL_PLAY=0` to require passwords on the host as well.

If upgrading from the browser-session version, each player should sign in for the first time from the browser profile that holds their existing league. That first sign-in links their collection, decks, rewards and games to their account. Subsequent sign-ins can use any browser.

## Build a deck and take it offline

Open **Deck builder** to create or edit a deck. Changes save automatically to your league. Use **Download Forge deck (.dck)** in the deck toolbar when you want a `.dck` download. The file includes your main deck, sideboard and selected printings. Put it in Forge’s constructed decks folder to use it offline. You can export a work in progress.

## Play with a friend

Open **Play** and use the deck dropdown to choose one of your saved decks or a Foundations practice deck. Both players can use the read-only green **Elves** and red **Burn** decks. These 30-card practice decks stay out of the deck builder and collection.

Choose **Create game** to host. Your opponent chooses a deck and selects **Join game** in the lobby. You share one current game, from waiting for an opponent through the final turn. Each player sees their own hand and makes their own decisions. The lobby keeps finished games available for review and preserves earlier unfinished games for later.

Forge normally asks for decisions when there is a play or response to make. Open **Priority stops** in the three-dot menu to add manual stops on your turns, your opponent’s turns or both. **Select all** and **Clear all** apply to both columns. Checked stops repeat each turn. Your choices carry over to new games, even if you switch seats.

Battlefield cards show a status marker for summoning sickness, phasing, marked damage, counters and abilities granted by effects. Select the marker for details. In manual play, open a permanent to adjust its sickness or phasing when resolving an effect yourself.

In a running game, use the undo arrow beside a saved point in the game log to request a rewind. The game pauses while your opponent decides. Open the three-dot menu to request manual play, concede, report a game issue or return to the lobby. Switching to manual play also requires your opponent’s approval and starts a new undo history at the agreed position. Confirming a concession gives your opponent the win. Finished games keep their result and final board for review.

## Run locally

The host needs Node.js 20.19+ or a supported newer LTS, PostgreSQL, Forge Desktop 2.0.13 and JDK 17 with `java` on PATH. Players only need a browser. From the repository root in PowerShell, run the following.

```powershell
npm ci
$env:FORGE_INSTALL = 'C:\path\to\Forge 2.0.13'
npm run web:db -- --local
npm run web:catalog
npm run build
npm start
```

Open [Arcane Fold on this computer](http://127.0.0.1:4317/). After editing code, `npm run dev` rebuilds and starts the app. Run `npm test` for league, deck and game checks. PostgreSQL integration tests use a configured database. Set `TEST_WEB_POSTGRES=1` for the additional progression integration check, `TEST_WEB_CATALOG=1` for the populated catalog check, and `FORGE_INSTALL` for installed-engine tests.

The local database command provisions a password-protected PostgreSQL cluster on loopback port 55432. Run the same command after restarting the computer. It uses the PostgreSQL 18 tools under Program Files on Windows, or the tools on PATH on Linux. Set `PG_BINDIR` for another installation. Keep `.web-data` and the ignored `.env.web` with your backups. To use an existing database, set `DATABASE_URL` in `.env.web` and run `npm run web:db`.

`web:catalog` loads Scryfall metadata for the installed Forge editions. For offline setup, use `npm run web:catalog -- --jsonl <scryfall-records.jsonl>`. Set `WEB_CARD_IMAGE_CACHE` to an existing card image cache for read-only artwork reuse.

The server listens on `127.0.0.1:4317` by default. To serve other devices, configure `WEB_HOST`, `WEB_PORT` and the exact public `WEB_ORIGIN`, then put the service behind HTTPS. Forge and PostgreSQL stay on the host.

## League rules and support

The **League guide** shows the shared deck limits, pack composition and expansion calendar. Starting and due rewards are credited automatically. Discovery grants first copies, and matching-rarity wildcards add copies of owned cards. [Built-in rules](web/league-rules.json)

Reports include a match ID, revision and the reporting seat’s view. A database operator can inspect recent reports with this query.

```sql
SELECT r.id, r.created_at, r.details, r.room_id, r.revision, r.seat,
       r.snapshot, p.replay_cursor, p.retired_at
FROM web_reports AS r
JOIN web_positions AS p USING (room_id, revision)
ORDER BY r.created_at DESC
LIMIT 20;
```

A Forge position points to its replay cursor. A retired position identifies the original journal in `web_forge_journals` by `(room_id, retired_at)`. A manual position retains the checkpoint in `web_positions.manual_checkpoint`.
