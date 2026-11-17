import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import { defaultAppearance } from "@/lib/appearance";
import { retryDatabaseBusy } from "@/lib/database-retry";
import { detectForgePaths } from "@/services/forge";
import type { AppSettings, DashboardStats } from "@/lib/types";

let connection: Promise<Database> | undefined;

export function database() {
  // The native SQL plugin preloads this database and finishes migrations before
  // the webview opens. Reuse it instead of replacing its pool during startup.
  connection ??= Promise.resolve(Database.get("sqlite:eternal-league.db"));
  return connection;
}

export async function loadSettings(): Promise<AppSettings> {
  const db = await database();
  const rows = await retryDatabaseBusy(() =>
    db.select<{ value: string }[]>(
      "SELECT value FROM settings WHERE key = 'app'",
    ),
  );
  const saved = rows[0]
    ? (JSON.parse(rows[0].value) as Partial<AppSettings>)
    : null;
  const [paths, league] = await Promise.all([
    detectForgePaths(),
    invoke<AppSettings["league"]>("league_rules"),
  ]);
  const previous = saved?.forge;
  const savedInstall = previous?.installDir ?? "";
  const standardInstall =
    /[\\/](?:Programs|Program Files(?: \(x86\))?)[\\/]Forge[^\\/]*[\\/]?$/i.test(
      savedInstall,
    );
  const settings: AppSettings = {
    forge: {
      dataDir: previous?.dataDir || paths.dataDir,
      deckDir: previous?.deckDir || paths.deckDir,
      imageCacheDir: previous?.imageCacheDir || paths.imageCacheDir,
      installDir:
        !savedInstall || standardInstall
          ? paths.installDir || savedInstall
          : savedInstall,
    },
    league,
    appearance: { ...defaultAppearance },
  };
  if (JSON.stringify(settings) !== JSON.stringify(saved))
    await saveSettings(settings);
  return settings;
}

export async function saveSettings(settings: AppSettings) {
  await database();
  await retryDatabaseBusy(() =>
    invoke("save_app_settings", { settingsJson: JSON.stringify(settings) }),
  );
}

export async function loadDashboardStats(): Promise<DashboardStats> {
  const db = await database();
  const rows = await retryDatabaseBusy(() =>
    db.select<DashboardStats[]>(`SELECT
    (SELECT COUNT(*) FROM collection WHERE quantity > 0) AS uniqueCards,
    (SELECT COALESCE(SUM(quantity), 0) FROM collection) AS totalCards,
    (SELECT COUNT(*) FROM decks) AS decks,
    (SELECT COALESCE(SUM(quantity), 0) FROM wildcards) AS wildcards`),
  );
  return rows[0];
}
