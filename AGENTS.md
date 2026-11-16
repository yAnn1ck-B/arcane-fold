# Repository instructions

Eternal League is a local Tauri 2 / React / SQLite companion to MTG Forge. Read [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) for product scope and [docs/phase-5-release.md](docs/phase-5-release.md) before release work. Keep league rules built in and read-only, preserve earned progress, and avoid adding maintenance controls or manual ownership editing.

## Profiles and data preservation

- Production has the permanent identifier `com.eternalleague.desktop`. Never change it between production versions.
- `com.eternalleague.app` is the preserved legacy DEVELOPMENT profile. `npm run tauri dev` injects `src-tauri/tauri.dev.conf.json` unless an explicit `--config` / `-c` is supplied. Do not bypass this wrapper to start an ordinary debug app against the production identifier.
- `com.eternalleague.preview` is an isolated development preview. Keep its current window, cloned database, and separate Forge exports intact unless the task explicitly requires changing them. Release artifacts must not include preview configuration, identifiers, databases, or debugging capabilities.
- Clean first production launch is achieved with the new production profile, not by deleting development files. Never copy legacy development/preview progress into production automatically. Existing Forge files are not an import source for league ownership.
- Never wipe an existing production database, reset progress on version change, clear artwork caches during updates, or delete unrelated Forge files. Use additive, tested migrations. Updates and reinstalls must preserve data; Windows uninstall preserves user data by default.
- The real shared start is fixed at `1794847589` in `release-policy.json` and `src-tauri/league-rules.json`; validation must keep both identical. Keep it identical on all platforms and stable after first publication. Never derive it per install, build, platform, or later release. Legitimate late-join rewards are expected even for an otherwise clean production profile.
- `ETERNAL_LEAGUE_PREVIEW_WEEKS` is debug-only; release builds ignore it. Do not change the operating-system clock for tests. Do not apply preview rewards to the original development profile.

## Every publish requires a new version

The user intends to release through Codex. Every new publish must use a new, higher SemVer version. Never reuse a published version, move/delete an existing release tag, or replace published assets to conceal a change. Changes that alter the application, embedded configuration, or installer bytes after tagging require a new version and tag. Documentation-only and release-verification-tool-only fixes may be committed on main and used to verify an unchanged tagged candidate; they must not move its tag, rebuild/replace its artifacts, or reuse a published version. Every published release version remains unique and new. An unchanged failed workflow can be rerun without moving its tag.

Use the repository helpers:

1. Inspect the current version and release state. Run `npm run version:check`.
2. Run `npm run release:prepare -- patch`, `minor`, `major`, or an explicit higher `X.Y.Z`. Update the corresponding notes in `CHANGELOG.md`.
3. Confirm matching application versions in all five files: `package.json`, both root version fields in `package-lock.json`, the package in `src-tauri/Cargo.toml`, the `eternal-league` package in `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json`. Config overrides must not introduce a different version. The tag is `vX.Y.Z`; updater metadata uses the same application version.
4. Complete required checks, commit the reviewed release candidate, and run `npm run version:check -- --tag vX.Y.Z`.
5. Run `npm run release:tag` from the clean release branch. It validates and pushes the current main branch with a new annotated immutable tag. The workflow creates a **draft** release.
6. In the default `RELEASE_SIGNING_MODE=local`, wait for the draft's two raw installers and run `node scripts/github.mjs exec node scripts/verify-release.mjs --tag vX.Y.Z --unsigned`.
7. Download the two raw draft assets with `node scripts/github.mjs release download vX.Y.Z --repo OWNER/REPO --dir .verification/releases/vX.Y.Z`, using the repository from `release-policy.json`.
8. Run `npm run release:sign -- vX.Y.Z [dir]` **directly**, not through the GitHub credential helper. The default directory is `.verification/releases/vX.Y.Z`. This LOCAL-only step uses `updater.key` and its DPAPI-protected password, strips GitHub tokens from the signer subprocess, binds signatures with Tauri's `--app-version`, and writes the two `.sig` files plus `latest.json`. It never uploads or publishes anything; private signing material stays on this PC.
9. Run `npm run release:attach -- vX.Y.Z [dir]` separately. It validates the draft, version, URLs, and signature contents, then uploads only the public signatures and updater manifest.
10. Run `node scripts/github.mjs exec node scripts/verify-release.mjs --tag vX.Y.Z`. Require exactly five assets and actual minisign verification of both installers. Use `MINISIGN_EXECUTABLE` for a portable verifier if needed. Version-bound signatures are mandatory (`requireSignedVersion: true`).
11. Publish with `node scripts/github.mjs release edit vX.Y.Z --draft=false --latest` only when the release request authorizes publication and the concrete candidate is ready, then rerun verification with `--published` to check anonymous public downloads.

The first public release is planned as `0.2.0`, following development `0.1.0`. After it exists, always inspect the actual versions and release history rather than reusing this initial number.

## Signing and credentials

- Keep updater private keys, key passwords, GitHub credentials, and tokens secret. Never commit, print, paste into docs, or persist them in release artifacts or command logs. A public updater verification key may be committed.
- Use `scripts/github.mjs` for authenticated local GitHub operations. It obtains the credential in memory and supplies `GH_TOKEN` only to its child process. Do not replace this with commands that echo credentials, dump the environment, or write tokens to files.
- Default signing is LOCAL. CI builds raw installers in a draft without key/password secrets; Codex signs them offline on this PC; a separate attach step uploads only public signatures and updater metadata. Keep the established updater signing identity stable so existing installations can verify future releases. Do not regenerate or rotate it casually.
- Automatic approval review rejected exporting the private key/password to GitHub without explicit credential-export consent. That consent is pending; do not export them, retry through another channel, encode them to evade review, or enable Actions signing as a workaround.
- `RELEASE_SIGNING_MODE=actions` is optional and may be enabled only after explicit user approval for credential export and proper Secrets configuration. Its absence does not block the default local-signing release flow.

## Required release verification

- Use the lockfiles (`npm ci`), pass the production frontend build, native tests, and version validation, and inspect the tag workflow result.
- Verify Windows NSIS `.exe` and Linux `.AppImage` outputs, their updater artifacts/signatures, and matching `latest.json` versions, platforms, and download URLs. A successful frontend build alone is not a completed release.
- Validate a clean production first launch: correct production identifier; no inherited collection, decks, history, receipts, or development queue; legitimate shared-calendar rewards only; detected Forge paths; catalog setup; working artwork.
- Test installation, uninstall/reinstall, and signed upgrade preservation using isolated fixtures on both supported platforms. Keep evidence and any genuine limitations in the release verification notes; never claim an unperformed check.
- Updates check at startup and every four hours. Users choose **Install update** or **Later**. Never force installation, silently erase data, or ship a reset-on-update shortcut.
- Keep `README.md`, the development plan, changelog, and release verification notes aligned with the actual shipped behavior. Preserve older test records as historical rather than rewriting them as current evidence.
