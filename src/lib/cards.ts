import type { CatalogCard } from "@/lib/types";

export function isUnlimitedBasic(card: Pick<CatalogCard, "typeLine">) {
  const types = card.typeLine.split(/[—–]/, 1)[0];
  return /\bBasic\b/i.test(types) && /\bLand\b/i.test(types);
}
