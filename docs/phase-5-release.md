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

Use the actual version, not the placeholder. Changes after tagging that alter the application, embedded configuration, or installers need a new release version/tag. Documentation-only and release-verification-tool-only fixes may land on main and verify the unchanged candidate without moving its tag or replacing its artifacts; each published release still receives a unique new version. Published tags and artifacts remain immutable. An unchanged failed workflow can be rerun against its original tag.

## Signing and update behavior

The pipeline builds a current-user Windows NSIS installer on Windows 2022 and a Linux AppImage on Ubuntu 22.04, using Node 24 and Rust 1.90. The NSIS configuration prevents downgrade and adds no custom uninstall deletion hooks. Windows installation, silent uninstall/reinstall, and the real signed upgrade passed as recorded below. Linux AppImage launch/file-replacement passed; Linux signed-upgrade preservation remains unverified.

Default signing happens **locally**. CI needs no signing key or password secrets and drafts only the two raw installers. The public updater verification key is committed in application configuration. `updater.key` and its DPAPI-protected password remain on this PC; they are never uploaded to GitHub or included in source, docs, logs, or artifacts.

Automatic approval review rejected exporting the private key/password to GitHub without explicit user credential-export consent. That consent remains pending. Do not export them or route around the rejection. The local-signing flow completes release signing without credential export. Optional repository variable `RELEASE_SIGNING_MODE=actions` may enable automatic CI signing only after explicit approval and Secrets configuration; it is not required for the first public release.

Local authenticated operations use `scripts/github.mjs`, which obtains credentials in memory and passes a child-only `GH_TOKEN`. Do not print credentials or persist temporary tokens. Keep the signing identity stable between releases so installed clients continue to verify updates.

Production builds check for updates at startup and every four hours; development and preview builds do not start the updater or show update prompts. It presents **Install update** and **Later**, installs only after acceptance, verifies the signed update, and restarts as needed. Updates and reinstalls must retain the database, collection, decks, rewards, settings, and downloaded artwork. Actual Windows silent uninstall/reinstall and signed-upgrade preservation passed with the fixture described below. Linux signed-upgrade preservation remains unverified.

## Verification record

Completed identity and local checks:

- Production uses `com.eternalleague.desktop`; tracked development retains `.app`; the isolated preview retains `.preview`. Eight wrapper routing cases passed without changing profiles or Forge files.
- Version preparation/check/tag helpers and their two tests passed. The initial candidate is `0.2.0`, with the fixed shared start committed in the release policy and built-in rules before tagging.
- All **24 Node tests** passed: 13 updater, two version, and nine release-verifier tests. Alongside signed trusted-comment checks, real local HTTP tests verify authenticated draft asset-API downloads, cross-origin redirect credential stripping, anonymous published browser-URL downloads, and rejection of API URLs in the updater manifest.
- The native follow-up suite passed **99 tests: 96 unit tests and three cold-configuration integration tests**. The new integration tests check Windows/Linux platform configuration merges, development/preview overrides, freshly generated Tauri context, and the reported missing/null updater configuration case. Signed-version requirements and the HTTPS endpoint remain present after cold configuration loading. `cargo fmt` passed.
- Development/preview updater scheduling and prompts are suppressed. Production keeps the startup/four-hour schedule and explicit download/install controls; the actual Windows loopback signed-upgrade check passed, while public-channel and Linux signed-upgrade checks remain pending.
- The verification-tool-only follow-up downloads draft installer bytes from authenticated REST asset URLs while requiring manifest URLs to match the corresponding public browser download URLs. Published verification remains anonymous and uses those public URLs. The local HTTP regressions exercise transport routing; they do not claim a live private-draft asset download. This helper change leaves the immutable `v0.2.0` application and installers unchanged.
- Workflow validation passed checksum-verified actionlint 1.7.12. Linux Forge path coverage includes `~/.forge`, `~/.cache/forge`, and a bounded scan for extracted installations.

Completed remote build and Linux execution checks:

- [Desktop CI run 43914055166](https://github.com/yAnn1ck-B/eternal-league/actions/runs/43914055166), commit `32404c205218ba6d6ce1948441cc69200380cbe1`, passed **both** Windows and Linux jobs. Linux completed at `2026-11-16T17:17:58Z`; Windows completed at `2026-11-16T17:22:20Z`. This push run passed the then-current 96 native and 21 Node tests on each platform, frontend builds, and packaging; the three newer cold-configuration tests are local follow-up evidence, not part of that run.
- The Linux job produced `Eternal League_0.2.0_amd64.AppImage` (82.84 MiB). Its real Xvfb/software-WebKit smoke check completed in about 6.3 seconds using isolated HOME/XDG/TMPDIR directories.
- The downloaded smoke artifact reports schema **7** and `success`, `freshProfileEmpty`, `relaunchPreserved`, and `reinstallPreserved` all `true`. The first profile had no collection, decks, wildcards, opening history, receipts, league state, or development queue. A non-game settings probe and cache marker survived relaunch and removal/re-copy of the AppImage file, while game progress remained empty.
- Local evidence is `.verification/ci/43914055166-linux-smoke/linux-install-smoke.json`, from artifact `linux-install-smoke-43914055166-1`. Its SHA-256 is `B0DF5F025A7CCC6B95D25809ABFD04F8EB79AB0C039C25E90BCDA88923ADC168`. This verifies AppImage launch and file replacement, not a signed updater installation or desktop/package-manager integration.

Completed local Windows installer and updater checks:

- The version-bound signed `0.2.0` NSIS installer installed silently into the guarded workspace QA directory. A cold installed production launch had zero owned cards, decks, and wildcards, no inherited development progress, `previewWeeks: 0`, Daylight/Larger appearance, version **0.2.0**, and detected Forge **2.0.13**.
- A guarded fixture then added one real FDN Llanowar Elves printing with **two owned copies**, **one deck/main row of quantity one**, **seven common wildcards**, a non-game settings probe, and an artwork-cache marker. Forge exports were redirected to the workspace. Cold relaunch and actual silent uninstall/reinstall of `0.2.0` preserved the exact rows, settings, and cache marker.
- After uninstalling that candidate, an ignored test-only **0.1.9** build with a loopback updater configuration was installed. Its actual startup update notification appeared. Choosing **Later** dismissed it; the server log showed no automatic installer-payload download.
- A tampered payload failed native verification with **The signature verification failed**. Retrying the valid payload enabled the explicit **Install and restart** action while the running app still reported **0.1.9**. Accepting that action closed the old process, ran the real passive NSIS upgrade, and restarted PID 28408 reporting native version **0.2.0**. `previewWeeks` remained zero and every fixture assertion still passed.
- Cleanup restored the factory database using the verified backup and matching logical digest, removed only the hash-verified QA cache marker, uninstalled the QA app, and stopped only the owned loopback server. The original profile remained **184 owned cards / 37 wildcards / one deck**, with integrity `ok` and unchanged data.
- The QA-only manufacturer registry key was removed after verifying its pretest baseline was empty, no uninstall registration remained, its default value matched the fixed QA workspace path, it contained only the expected install-location/language values, and it had no subkeys. No AppData was deleted. A cold preview restart still showed week four, 24 unopened packs, 184 cards, 64 wildcards, one deck, and no development updater prompt. The original audit remained 184 cards / 37 wildcards / one deck.
- The frozen production installer was also launched with `ETERNAL_LEAGUE_PREVIEW_WEEKS=4` inherited. Native status still reported `previewWeeks: 0`, an unstarted zero-wildcard league, and the correct `.desktop` database. Calling `plugin:window|set_size` failed with **Command plugin:window|set_size not allowed by ACL**, proving the preview-only sizing capability was absent. Bundle resources include no cloned database/snapshot; the full repository-history audit found no private signing key. Final tagged-asset verification remains a separate gate.
- Evidence is `.verification/windows-installer-evidence.json`. Screenshots are `output/playwright/phase5-windows-fresh-offline.png`, `phase5-tampered-update-rejected.png`, `phase5-verified-update-awaits-install.png`, and `phase5-signed-upgrade-complete.png`. These checks verify the real Windows install/update path against a local server; they do not claim public GitHub delivery or a Linux signed upgrade. The four-hour interval is covered by controller tests, not a four-hour installed wall-clock session.

The annotated tag **v0.2.0** points immutably to commit **385e4ac3204978e2ce49f7a268fc29f7e11d8d0e**. [Tagged release workflow 43918186616](https://github.com/yAnn1ck-B/eternal-league/actions/runs/43918186616) was still running when this Windows record was written. Documentation commits may follow; the tag must not be moved.

Still pending before Phase 5 is complete:

- The actual immutable-tag release workflow and its private draft, followed by both final signed deliverables and matching `latest.json` verification.
- Actual Linux signed-upgrade preservation. Linux file-replacement smoke and controller tests do not substitute for that check; Windows uninstall/reinstall and real signed upgrade have passed.
- Public repository/release publication and anonymous installer/updater downloads, plus live public-channel notification behavior.

The repository remains private and publication has not occurred. Public visibility/publication and private-key/password export are awaiting explicit consent after automatic approval review rejected those actions; the local-signing procedure is the supported release path while consent is pending. Earlier application checks remain in [Phase 4 verification](phase-4-verification.md).
