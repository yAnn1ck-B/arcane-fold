/** Format mana and ability symbols for display; stored rules and deck files stay unchanged. */
export function formatMana(value: string) {
  return value.replace(/\{([^}]+)\}/g, (_match: string, symbol: string) =>
    symbol === "HW" ? "\u00bdW" : symbol === "HR" ? "\u00bdR" : symbol,
  );
}
