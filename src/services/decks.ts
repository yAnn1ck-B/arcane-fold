import { invoke } from "@/services/league-transport";
import type {
  DeckDetail,
  DeckDraft,
  DeckSummary,
  DeckValidation,
} from "@/lib/types";

export function listDecks() {
  return invoke<DeckSummary[]>("list_decks");
}
export function loadDeck(id: string) {
  return invoke<DeckDetail>("load_deck", { id });
}
export function persistDeck(deck: DeckDraft, createRequestId?: string) {
  return invoke<DeckDetail>("save_deck", { deck, createRequestId });
}
export function deleteDeck(id: string) {
  return invoke<void>("delete_deck", { id });
}
export function validateDeck(deck: DeckDraft) {
  return invoke<DeckValidation>("validate_deck", { deck });
}
