import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

export interface DatabaseInfo {
  databasePath: string;
  cachePath: string;
  sizeBytes: number;
}
export function databaseInfo() {
  return invoke<DatabaseInfo>("database_info");
}
export function backupDatabase(destination: string) {
  return invoke<{ path: string; bytes: number }>("backup_database", {
    destination,
  });
}
export function restoreDatabase(source: string) {
  return invoke<{
    restartRequired: boolean;
    reloadRequired: boolean;
    backupPath: string;
  }>("restore_database", { source });
}
export function clearImageCache() {
  return invoke<{ filesRemoved: number; bytesRemoved: number }>(
    "clear_image_cache",
    { confirmation: "CLEAR IMAGE CACHE" },
  );
}
export function chooseBackupDestination() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return save({
    title: "Back up Arcane Fold",
    defaultPath: `Arcane-Fold-${timestamp}.db`,
    filters: [{ name: "SQLite database", extensions: ["db"] }],
  });
}
export async function chooseBackupSource() {
  const selected = await open({
    title: "Restore an Arcane Fold backup",
    multiple: false,
    filters: [
      { name: "SQLite database", extensions: ["db", "sqlite", "sqlite3"] },
    ],
  });
  return typeof selected === "string" ? selected : null;
}
