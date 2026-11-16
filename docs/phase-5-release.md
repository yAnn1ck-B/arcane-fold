# Phase 5: release and clean production policy

This document defines the release procedure and records implementation/verification as Phase 5 proceeds. The complete delivery scope remains in [DEVELOPMENT_PLAN.md](../DEVELOPMENT_PLAN.md). The current working preview and legacy development progress must remain intact.

## Application identities

| Purpose                      | Identifier                  | Launch/configuration                                              |
| ---------------------------- | --------------------------- | ----------------------------------------------------------------- |
| Permanent production         | `com.eternalleague.desktop` | Base `src-tauri/tauri.conf.json`; release builds                  |
| Preserved legacy development | `com.eternalleague.app`     | `npm run tauri dev`; tracked `src-tauri/tauri.dev.conf.json`      |
| Isolated four-week preview   | `com.eternalleague.preview` | Explicit ignored preview configuration and separate Forge exports |

SQLite and companion caches resolve within the profile selected by the Tauri identifier. On Windows the database is under `%APPDATA%\<identifier>\eternal-league.db`. Changing the production identifier after release would strand existing progress, so the production identifier is permanent.

The development wrapper injects the tracked override only when its first argument is `dev` and no explicit `--config` / `-c` was provided. Explicit preview/verification configuration takes precedence, including joined option forms. Injection happens before the runtime `--` argument separator. `build` never gets the development override. Ordinary development launches should use this wrapper rather than starting a debug app directly against the base production identifier. Development and preview builds suppress updater scheduling and prompts, so they cannot offer to replace a working development/preview session with the production installation.

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

The pipeline builds a current-user Windows NSIS installer on Windows 2022 and a Linux AppImage on Ubuntu 22.04, using Node 24 and Rust 1.90. The NSIS configuration prevents downgrade and adds no custom uninstall deletion hooks. Local Windows installation and the Linux AppImage launch/file-replacement checks passed as recorded below; Windows uninstall/reinstall and signed upgrades remain pending.

Default signing happens **locally**. CI needs no signing key or password secrets and drafts only the two raw installers. The public updater verification key is committed in application configuration. `updater.key` and its DPAPI-protected password remain on this PC; they are never uploaded to GitHub or included in source, docs, logs, or artifacts.

Automatic approval review rejected exporting the private key/password to GitHub without explicit user credential-export consent. That consent remains pending. Do not export them or route around the rejection. The local-signing flow completes release signing without credential export. Optional repository variable `RELEASE_SIGNING_MODE=actions` may enable automatic CI signing only after explicit approval and Secrets configuration; it is not required for the first public release.

Local authenticated operations use `scripts/github.mjs`, which obtains credentials in memory and passes a child-only `GH_TOKEN`. Do not print credentials or persist temporary tokens. Keep the signing identity stable between releases so installed clients continue to verify updates.

Production builds check for updates at startup and every four hours; development and preview builds do not start the updater or show update prompts. It presents **Install update** and **Later**, installs only after acceptance, verifies the signed update, and restarts as needed. Updates and reinstalls must retain the database, collection, decks, rewards, settings, and downloaded artwork. NSIS uses its standard user-data-preserving configuration; actual Windows uninstall/reinstall and signed-upgrade preservation still require verification.

## Verification record

Completed identity and local checks:

- Production uses `com.eternalleague.desktop`; tracked development retains `.app`; the isolated preview retains `.preview`. Eight wrapper routing cases passed without changing profiles or Forge files.
- Version preparation/check/tag helpers and their two tests passed. The initial candidate is `0.2.0`, with the fixed shared start committed in the release policy and built-in rules before tagging.
- All **21 Node tests** passed: 13 updater, two version, and six release-verifier tests. These include rejection of missing or incorrect signed trusted-comment versions.
- The native follow-up suite passed **99 tests: 96 unit tests and three cold-configuration integration tests**. The new integration tests check Windows/Linux platform configuration merges, development/preview overrides, freshly generated Tauri context, and the reported missing/null updater configuration case. Signed-version requirements and the HTTPS endpoint remain present after cold configuration loading. `cargo fmt` passed.
- Development/preview updater scheduling and prompts are suppressed. Production keeps the startup/four-hour schedule and explicit download/install controls; public-channel and actual signed-upgrade checks remain pending.
- Workflow validation passed checksum-verified actionlint 1.7.12. Linux Forge path coverage includes `~/.forge`, `~/.cache/forge`, and a bounded scan for extracted installations.

Completed remote build and Linux execution checks:

- [Desktop CI run 43914055166](https://github.com/yAnn1ck-B/eternal-league/actions/runs/43914055166), commit `32404c205218ba6d6ce1948441cc69200380cbe1`, passed **both** Windows and Linux jobs. Linux completed at `2026-11-16T17:17:58Z`; Windows completed at `2026-11-16T17:22:20Z`. This push run passed the then-current 96 native and 21 Node tests on each platform, frontend builds, and packaging; the three newer cold-configuration tests are local follow-up evidence, not part of that run.
- The Linux job produced `Eternal League_0.2.0_amd64.AppImage` (82.84 MiB). Its real Xvfb/software-WebKit smoke check completed in about 6.3 seconds using isolated HOME/XDG/TMPDIR directories.
- The downloaded smoke artifact reports schema **7** and `success`, `freshProfileEmpty`, `relaunchPreserved`, and `reinstallPreserved` all `true`. The first profile had no collection, decks, wildcards, opening history, receipts, league state, or development queue. A non-game settings probe and cache marker survived relaunch and removal/re-copy of the AppImage file, while game progress remained empty.
- Local evidence is `.verification/ci/43914055166-linux-smoke/linux-install-smoke.json`, from artifact `linux-install-smoke-43914055166-1`. Its SHA-256 is `B0DF5F025A7CCC6B95D25809ABFD04F8EB79AB0C039C25E90BCDA88923ADC168`. This verifies AppImage launch and file replacement, not a signed updater installation or desktop/package-manager integration.

Completed local Windows candidate checks:

- The `0.2.0` Windows NSIS installer built successfully, received a local version-bound updater signature, passed signature verification, and installed successfully.
- A cold launch of the installed production app used the fresh `.desktop` profile: owned cards, decks, and wildcards were zero, with no inherited development progress. The release reported `previewWeeks: 0`, Daylight/Larger appearance, and the correct detected Forge version **2.0.13**.
- These results establish local packaging, signing, installation, and first launch. They do not establish Windows uninstall/reinstall or signed-upgrade preservation. The private key remains on this PC.

Still pending before Phase 5 is complete:

- The actual immutable-tag release workflow and its private draft, followed by both final signed deliverables and matching `latest.json` verification.
- Windows uninstall/reinstall preservation and actual signed-upgrade preservation on both supported platforms. Linux file-replacement smoke and updater/controller tests do not substitute for those checks.
- Public repository/release publication and anonymous installer/updater downloads, plus live public-channel notification behavior.

The repository remains private and publication has not occurred. Private-key/password export to GitHub remains unapproved; the local-signing procedure is the supported release path while consent is pending. Earlier application checks remain in [Phase 4 verification](phase-4-verification.md).
