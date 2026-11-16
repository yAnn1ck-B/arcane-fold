# Phase 5: release and clean production policy

This document defines the release procedure and records implementation/verification as Phase 5 proceeds. The complete delivery scope remains in [DEVELOPMENT_PLAN.md](../DEVELOPMENT_PLAN.md). The current working preview and legacy development progress must remain intact.

## Application identities

| Purpose                      | Identifier                  | Launch/configuration                                              |
| ---------------------------- | --------------------------- | ----------------------------------------------------------------- |
| Permanent production         | `com.eternalleague.desktop` | Base `src-tauri/tauri.conf.json`; release builds                  |
| Preserved legacy development | `com.eternalleague.app`     | `npm run tauri dev`; tracked `src-tauri/tauri.dev.conf.json`      |
| Isolated four-week preview   | `com.eternalleague.preview` | Explicit ignored preview configuration and separate Forge exports |

SQLite and companion caches resolve within the profile selected by the Tauri identifier. On Windows the database is under `%APPDATA%\<identifier>\eternal-league.db`. Changing the production identifier after release would strand existing progress, so the production identifier is permanent.

The development wrapper injects the tracked override only when its first argument is `dev` and no explicit `--config` / `-c` was provided. Explicit preview/verification configuration takes precedence, including joined option forms. Injection happens before the runtime `--` argument separator. `build` never gets the development override. Ordinary development launches should use this wrapper rather than starting a debug app directly against the base production identifier.

This separation provides a clean first production profile without deleting or moving any legacy `.app`, `.preview`, or Forge data. Production must not automatically import development ownership, decks, settings, opening history, operation receipts, or queued rewards. Reusing existing Forge artwork is allowed; external artwork and untracked Forge decks are not collection progress. Fresh migrations may create initial schema rows, and normal catalog setup may import metadata. A late installation still receives rewards legitimately earned since the shared production start.

## One real league start

The initial production start has been chosen once as **`1794847589`**, recorded in [release-policy.json](../release-policy.json) and [league-rules.json](../src-tauri/league-rules.json). Commit those matching values before the first tag. Both platforms bundle that same value; do not calculate separate starts at build time or first launch.

After the first public release, version preparation and upgrades never change that anchor. Late friends receive the same elapsed shared-calendar benefits. The fresh production identity resets the DEVELOPMENT release baseline; it does not wipe existing development files or add a destructive production-upgrade migration.

Release artifacts exclude the preview identifier/configuration, cloned databases, test exports, and debugging capabilities. `ETERNAL_LEAGUE_PREVIEW_WEEKS=4` remains development-only and is ignored by release builds. No operating-system clock changes are needed.

## Version and publish contract

Every new publish receives a new, higher SemVer version. The first public version is planned as `0.2.0`; development began at `0.1.0`. Never reuse a published version or move an existing tag.

The version helper synchronizes five files:

- `package.json` application version.
- `package-lock.json` root version and `packages[""].version`.
- `src-tauri/Cargo.toml` package version.
- The `eternal-league` package entry in `src-tauri/Cargo.lock`.
- `src-tauri/tauri.conf.json` version.

Use these commands when requested to release:

```powershell
npm run version:check
npm run release:prepare -- minor
# Review changes and CHANGELOG.md, run required checks, then commit.
npm run version:check -- --tag vX.Y.Z
npm run release:tag
```

`release:prepare` accepts `patch`, `minor`, `major`, or an explicit higher `X.Y.Z`. It must never change the shared league anchor after initial release preparation. `release:tag` requires a clean worktree, validates the candidate, and pushes main plus a new annotated tag. The tag workflow builds a **draft** release; it does not publish an unchecked candidate automatically.

The default `RELEASE_SIGNING_MODE=local` workflow creates a draft containing only the raw Windows and Linux installers. Verify this two-asset draft, download it, sign offline on this PC, then attach and verify the complete signed draft:

```powershell
node scripts/github.mjs exec node scripts/verify-release.mjs --tag vX.Y.Z --unsigned
node scripts/github.mjs release download vX.Y.Z --repo yAnn1ck-B/eternal-league --dir .verification/releases/vX.Y.Z
npm run release:sign -- vX.Y.Z
npm run release:attach -- vX.Y.Z
node scripts/github.mjs exec node scripts/verify-release.mjs --tag vX.Y.Z
```

Read the repository from `release-policy.json` if it changes. `release:sign` and `release:attach` accept an optional directory after the tag; both default to `.verification/releases/vX.Y.Z`.

The **LOCAL-only signing helper** reads the local updater key and DPAPI-protected password, removes GitHub tokens from the signer subprocess, binds signatures to the application version with Tauri's `--app-version`, and writes the two public `.sig` files and `latest.json`. Run it directly, not under the GitHub credential helper. It performs no upload or publication.

The **separate attach helper** validates the draft, version, URLs, and signature contents before uploading only the two public signatures and updater manifest. Full verification then requires exactly five assets and actual minisign verification of both installers. The app requires version-bound signatures with `requireSignedVersion: true`. Use `MINISIGN_EXECUTABLE` for a portable Windows verifier or provide minisign on PATH; the verified local verifier is official minisign 0.12.

After verification, promote that exact draft and verify public downloads anonymously:

```powershell
node scripts/github.mjs release edit vX.Y.Z --draft=false --latest
node scripts/github.mjs exec node scripts/verify-release.mjs --tag vX.Y.Z --published
```

Use the actual version, not the placeholder. Changes after tagging need a new release version/tag. Published tags and artifacts remain immutable. An unchanged failed workflow can be rerun against its original tag.

## Signing and update behavior

The pipeline builds a current-user Windows NSIS installer on Windows 2022 and a Linux AppImage on Ubuntu 22.04, using Node 24 and Rust 1.90. The NSIS configuration prevents downgrade and adds no custom uninstall deletion hooks. Installation/uninstallation behavior still requires the platform tests recorded below.

Default signing happens **locally**. CI needs no signing key or password secrets and drafts only the two raw installers. The public updater verification key is committed in application configuration. `updater.key` and its DPAPI-protected password remain on this PC; they are never uploaded to GitHub or included in source, docs, logs, or artifacts.

Automatic approval review rejected exporting the private key/password to GitHub without explicit user credential-export consent. That consent remains pending. Do not export them or route around the rejection. The local-signing flow completes release signing without credential export. Optional repository variable `RELEASE_SIGNING_MODE=actions` may enable automatic CI signing only after explicit approval and Secrets configuration; it is not required for the first public release.

Local authenticated operations use `scripts/github.mjs`, which obtains credentials in memory and passes a child-only `GH_TOKEN`. Do not print credentials or persist temporary tokens. Keep the signing identity stable between releases so installed clients continue to verify updates.

The app checks for updates at startup and every four hours. It presents **Install update** and **Later**, installs only after acceptance, verifies the signed update, and restarts as needed. Updates and reinstalls retain the database, collection, decks, rewards, settings, and downloaded artwork. Windows uninstall preserves user data by default.

## Verification record

Completed identity/routing checks:

- Base production identity is `com.eternalleague.desktop`; tracked development is `.app`; ignored preview remains `.preview`.
- Eight isolated wrapper cases passed: ordinary development, production build, explicit long/short config options, their joined forms, runtime argument separation, and a different CLI command. No application process, profile, or Forge file was changed by these checks.

Other completed local checks:

- The version preparation/check/tag helpers are implemented and their two tests passed. The initial application version is now `0.2.0`, with the fixed production start recorded in the release policy.
- All **21 Node tests** passed: 13 updater, two version, and six release-verifier tests, including rejection of missing or incorrect signed trusted-comment versions. All **96 native tests** passed, including Linux Forge path coverage. `cargo fmt` passed.
- The workflow passed checksum-verified actionlint 1.7.12 validation. The configured Windows/Linux jobs and draft/local-signing contract are validated locally; this is not evidence that remote packaging or installation has already run.
- Linux Forge detection includes `~/.forge` and `~/.cache/forge` defaults plus a bounded extracted-install scan. No Linux GUI installation or updater preservation check is claimed by those path tests.
- A Linux AppImage first-launch/relaunch/file-reinstall smoke test is configured in CI and release packaging with isolated HOME/XDG/TMPDIR. It checks schema 7, zero game progress, and settings/cache marker preservation, and uploads JSON evidence. Python syntax and workflow lint passed; actual Linux smoke execution awaits the first CI run.

Phase 5 delivery validation still needs recorded evidence for:

- Remote execution of the complete immutable-tag build workflow.
- Downloadable Windows NSIS and Linux AppImage deliverables with valid updater signatures and correct manifest URLs/versions.
- First launch with a clean production profile, including legitimate shared rewards without inherited development progress.
- Installation, uninstall/reinstall, and signed update preservation on both supported platforms.
- Public release publication and client startup/four-hour update notification behavior.

Earlier application checks are recorded in [Phase 4 verification](phase-4-verification.md); they do not substitute for packaging and updater tests.
