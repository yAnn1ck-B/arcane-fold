# Repository instructions

Arcane Fold is a React and Node.js web app backed by PostgreSQL. Read [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) for product scope and [README.md](README.md) for setup and checks.

- Keep league rules built in and read-only. The permanent shared start is `1794847589` in `web/league-rules.json`. Preserve earned progress, operation receipts and entitlement accounting. Use additive database changes.
- Keep player access, room decisions and private information scoped to the authenticated browser session and seat. Store player state in PostgreSQL. Preserve existing browser session cookies and local preferences across updates.
- Keep deck autosave in the web database. Forge files are explicit user downloads or temporary inputs for the host’s game engine. Existing Forge files do not establish league ownership.
- Keep catalog, artwork and Forge configuration on the host. Preserve existing artwork caches and unrelated Forge files. Avoid adding maintenance controls or manual ownership editing.
- Use `npm ci`, `npm run build` and `npm test`. Run database and installed-Forge checks against isolated test data. Keep local credentials, configuration, player databases and private keys out of source and build artifacts.
- The former desktop release tags and published assets are immutable. Keep historical verification records available. Preserve legacy player data unless its removal has been expressly requested.
