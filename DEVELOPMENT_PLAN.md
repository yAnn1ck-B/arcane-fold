# Arcane Fold development plan

Arcane Fold runs in the browser. React and TypeScript provide the player interface. The Node.js server owns multiplayer rooms, hosts Forge matches and stores league progress in PostgreSQL. [Setup and usage](README.md)

## Collect and build

- Overview shows collection totals, deck count, pack and wildcard balances, and the shared calendar.
- Collection shows unlocked printings and supports search, filters, alternate artwork, crafting and adding cards to a deck. Ownership is pooled across printings of the same Oracle identity. Basic lands from unlocked sets are free to use.
- The deckbuilder saves named decks and drafts to the player’s league. It tracks main deck and sideboard quantities and selected printings. Players can create, rename, copy and delete decks. A separate download control produces a Forge constructed deck file on request.
- Deck checks use a 60-card main-deck minimum, a 15-card sideboard maximum and the normal four-copy limit with card-specific exceptions. Keep incomplete drafts usable during deckbuilding.

## Shared progression

Use the built-in rules and permanent start timestamp `1794847589` for every player. First use grants the starting packs and wildcards together with due calendar rewards. Preserve previously credited periods, spent balances and opening receipts when players return. [Rules and expansion schedule](web/league-rules.json)

- Grant 20 starting packs and 6 weekly packs. Each subsequent expansion unlock adds 8 packs reserved for that expansion. Open packs from the queue in order.
- Grant 10 common, 5 uncommon, 2 rare, 1 mythic and 1 Discovery wildcard at the start. Weekly grants include 4 common and 2 uncommon. Rare arrives every two weeks. Mythic arrives at weeks 2, 6, 10 and onward, and Discovery arrives at weeks 4, 8, 12 and onward.
- A Discovery wildcard grants the first copy. Matching-rarity wildcards grant further copies up to the ownership cap. Spending and ownership changes belong in the same transaction.
- Each pack has 10 commons, 4 uncommons and 1 rare or mythic. The mythic chance is 12.5%. Prefer distinct identities and at most one nonbasic land. Common nonbasic lands have half the usual selection weight. Four-copy protection spans printings and the opening batch. Award a matching wildcard when the rolled rarity pool is complete.

## Play

Players choose a saved deck or a Foundations practice deck from the Play dropdown. Each player can host or play in one current game at a time. The lobby lists open games by host and lets separate pairs play in parallel. Existing unfinished positions remain available to resume. Forge 2.0.13 runs on the host and handles actions, priority and private decisions. Keep hand visibility, controls and the board scoped to the requesting seat. Players can resume a game after reloading, concede during play and review the final result.

A rewind or switch to manual play requires both players’ consent during a running game. Save the new position and its revision together, retaining the public history. Manual play supports zones, life, mana, counters, tokens, attachments, stack entries and turn changes. A game issue report captures the reporting seat’s visible state and the exact server position.

## Storage and verification

PostgreSQL is authoritative for player identity, collection, entitlements, decks, receipts, room positions and reports. Browser preferences stay local. Catalog and artwork setup belong on the host. Existing Forge deck files are user exports and do not establish league ownership.

Run the production web build and the Node test suite. Use isolated players, schemas or transactions for integration checks. For changes to the Forge bridge, exercise the installed engine with the configured JDK and Forge installation. The Foundations inventory and sweeps cover selected interactions across the set. [Foundations gameplay verification](docs/foundations-play-audit.md)

The desktop phase notes and tagged releases record earlier versions. [Historical release evidence](docs/phase-5-release.md)
