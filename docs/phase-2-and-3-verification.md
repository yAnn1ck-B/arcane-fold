# Phase 2 and 3 verification

Verified on Windows on 16 November 2026.

## Automated checks

- TypeScript and Vite production build passed.
- All 25 Rust tests passed, including concurrent catalog edits, malformed-import rollback, exact deck printings, image decoding/containment, and non-overwriting cache sharing.
- Progression tests cover pack composition, mythic fallback, locked sets, insufficient card pools, collection/balance rollback, one-time starting packs, weekly claim periods, concurrent requests, duplicate receipt replay, crafting, and ordered automatic unlocking.
- A clock rollback regression ensures the next reward date does not point at an already-claimed period.

## Real catalog and Forge

The normal app downloaded and imported 120,135 Scryfall printings through its UI. Navigation remained responsive during import. Settings and existing Forge data were preserved.

Further end-to-end testing used an isolated app identifier/database (`com.eternalleague.verification`) with 284 real M15 printings. This kept test rewards and test collection quantities separate from the normal league database.

The UI built and saved a deck with 56 Forest (M15 #266), four Elvish Mystic (M15 #173), and 15 Forest in its sideboard. Direct quantity editing worked, and a fifth Elvish Mystic was rejected. Deck duplication, renaming, and deletion preserved collection quantities.

Installed Forge 2.0.13 parsed the UI-exported file using its actual card scripts and edition database:

```text
PASS Forge parsed "Verification - M15": main=60, sideboard=15, every card supported, constructed conformance passed, exact printing copies verified=75.
```

The strengthened Java harness also rejected an intentionally invalid collector number even when Forge silently substituted another printing. No match was simulated.

## Live progression checks

- Beginning the isolated league granted 12 packs once.
- One pack saved 15 cards before its reveal; Reveal all displayed the saved contents.
- Open All spent the remaining 11 packs and saved 165 more cards without animation.
- All 12 pack openings appeared in persistent history. A test-only 100% wildcard-drop setting produced exactly 12 bonus wildcards.
- Replaying the same opening receipt changed neither pack balance nor the 180 received cards.
- Crafting one Accursed Spirit changed its owned quantity from zero to one and common wildcards from three to two. Replaying that crafting receipt spent no additional wildcard.
- Weekly rewards were rejected before seven days. Moving only the isolated league's start timestamp back one week made one reward claim available; it granted four packs plus the configured wildcard rewards, then rejected another claim for that period.
- Disabling M15 blocked crafting without changing ownership. A one-week automatic unlock schedule enabled its next queued set.
- The WebView console reported no errors.
- A full native process restart preserved all isolated state: 257 recorded cards (including manual deck fixtures), four available packs, 12 opening-history entries, 15 remaining wildcards, and the saved 60/15 deck.

UI automation used Playwright attached to the real Tauri WebView2 development process. Screenshots are local verification artifacts under `output/playwright/`. Temporary debugging is used only for verification and is not enabled in application source.

Phase 4 backup/restore and broader finishing checks, plus Phase 5 installers and signed updates, remain outside this milestone.
