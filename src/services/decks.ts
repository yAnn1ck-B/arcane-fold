import { invoke } from "@tauri-apps/api/core";
import type {
  DeckDetail,
  DeckDraft,
  DeckSummary,
  DeckValidation,
  ExportResult,
} from "@/lib/types";

export function listDecks() {
  return invoke<DeckSummary[]>("list_decks");
}
export function loadDeck(id: string) {
  return invoke<DeckDetail>("load_deck", { id });
}
export function saveDeck(deck: DeckDraft) {
  return invoke<DeckDetail>("save_deck", { deck });
}
export function saveDeckToForge(deck: DeckDraft) {
  return invoke<{ deck: DeckDetail; export: ExportResult }>(
    "save_deck_to_forge",
    { deck },
  );
}
export function duplicateDeck(id: string) {
  return invoke<DeckDetail>("duplicate_deck", { id });
}
export function deleteDeck(id: string) {
  return invoke<void>("delete_deck", { id });
}
export function validateDeck(deck: DeckDraft, forgeDataDir: string) {
  return invoke<DeckValidation>("validate_deck", { deck, forgeDataDir });
}
export function exportDeck(
  deck: DeckDraft,
  deckDir: string,
  forgeDataDir: string,
) {
  return invoke<ExportResult>("export_deck", { deck, deckDir, forgeDataDir });
}

export function migrateForgeDecks() {
  return invoke<{
    moved: number;
    archived: number;
    deduplicated: number;
    missing: number;
  }>("migrate_forge_decks");
}
