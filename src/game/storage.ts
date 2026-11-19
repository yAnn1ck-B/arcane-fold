import { getIdentifier } from "@tauri-apps/api/app";
import { appLifecycle } from "@/lib/app-lifecycle";
import { restoreSession, type SavedTable } from "./session";

const store = "tables";
const slot = "current";

async function openTables(): Promise<IDBDatabase> {
  const identifier = await getIdentifier();
  return new Promise((resolve, reject) => {
    // The original database name keeps existing manual games available after the Play rename.
    const request = indexedDB.open(identifier + ".playtest", 1);
    request.onupgradeneeded = () => request.result.createObjectStore(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadSession() {
  const db = await openTables();
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).get(slot);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return value === undefined ? null : restoreSession(value);
  } finally {
    db.close();
  }
}

async function writeTable(saved: SavedTable | null, previous: string | undefined) {
  const db = await openTables();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      const tables = tx.objectStore(store);
      const read = tables.get(slot);
      let conflict = false;
      read.onsuccess = () => {
        if (read.result?.revision !== previous) {
          conflict = true;
          tx.abort();
          return;
        }
        if (saved) tables.put(saved, slot);
        else tables.delete(slot);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(
          conflict
            ? new Error(
                "This saved game has changed. Reopen Play to load the current save.",
              )
            : tx.error ?? new Error("The game save was interrupted."),
        );
    });
  } finally {
    db.close();
  }
}

async function finishWrite(pending: Promise<void>) {
  const unregister = appLifecycle.register(() => pending);
  try {
    await pending;
  } finally {
    unregister();
  }
}

export function saveSession(saved: SavedTable, previous: string | undefined) {
  return finishWrite(writeTable(saved, previous));
}

export function removeSession(revision: string) {
  return finishWrite(writeTable(null, revision));
}
