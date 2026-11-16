import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { UpdateController } from "./updater-controller";

export const updater = new UpdateController({
  check: async () => {
    const update = await check({ timeout: 15_000 });
    return update ? {
      version: update.version,
      currentVersion: update.currentVersion,
      body: update.body,
      download: (progress) => update.download(progress, { timeout: 120_000 }),
      // This is called only from the explicit install button. Windows' NSIS
      // installer closes the app and restarts it after replacing the binary.
      install: () => update.install({ restartAfterInstall: true }),
      close: () => update.close(),
    } : null;
  },
  relaunch,
});
