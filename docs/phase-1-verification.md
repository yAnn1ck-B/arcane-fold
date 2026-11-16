# Phase 1 verification

Verified on Windows on 16 November 2026.

- `npm run build`: TypeScript and Vite production build passed.
- `npm test`: all five native tests passed.
- `npm run tauri dev`: compiled and opened the real desktop application.
- SQLite migrations ran and the dashboard queried the empty collection, decks, and wildcard tables successfully.
- The application detected real Forge data, constructed-deck, and card-image-cache folders.
- Both the dashboard and Settings displayed a JPG from Forge's existing `AER` image cache, through the native command.
- Settings rejected a negative weekly booster count without saving it.
- A changed weekly booster count survived a complete native process restart. The default of four was restored afterward.
- Unsaved Settings edits survived navigation to Overview and back.
- The UI exported `Eternal League - Integration Test.dck` into Forge's constructed-deck folder, with 60 Forest main and 15 Forest sideboard. No existing deck was overwritten.
- The optional Java harness loaded that exact exported file through installed Forge 2.0.13 and its card scripts:

```text
PASS Forge parsed "Integration Test": main=60, sideboard=15, every card supported, constructed conformance passed.
```

The Forge check validates file compatibility and legality; it does not launch or simulate a match. The deck is an integration fixture consisting entirely of basic lands.

Desktop automation could not initialize in this environment. UI checks used Playwright attached to the actual development WebView2 process instead. The local debug port was used only for verification and is not configured in the app source.

Collection browsing, Scryfall imports/downloads, deck editing, booster opening, progression rewards, backup/restore, and signed updates remain scheduled for later phases.
