const invalidPrintingPart = /[\p{Cc}|\[\]]/u;

export function forgeDeck(name, entries) {
  if (!name.trim() || invalidPrintingPart.test(name)) {
    throw new Error("Choose a deck name without control characters, brackets or pipes before exporting.");
  }
  const lines = ["[metadata]", `Name=${name.trim()}`];
  for (const section of ["main", "sideboard"]) {
    lines.push(section === "main" ? "[Main]" : "[Sideboard]");
    const cards = entries.filter(row => row.section === section)
      .sort((a, b) => a.card.name.localeCompare(b.card.name));
    for (const { card, quantity } of cards) {
      const parts = [
        card.forgeName || card.name,
        card.forgeSetCode || card.setCode,
        card.forgeCollectorNumber || card.collectorNumber,
      ];
      if (parts.some(part => typeof part !== "string" || !part || invalidPrintingPart.test(part))) {
        throw new Error(`${card.name} has an invalid Forge printing identifier.`);
      }
      lines.push(`${quantity} ${parts[0]}|${parts[1].toUpperCase()}|[${parts[2]}]`);
    }
  }
  return lines.join("\n") + "\n";
}

export function forgeFilename(name) {
  const clean = name.trim().replace(/[<>:"/\\|?*\p{Cc}]/gu, "_");
  // Leave room for the extension and a Windows device-name prefix within 255 UTF-8 bytes.
  const { read } = new TextEncoder().encodeInto(clean, new Uint8Array(250));
  const base = clean.slice(0, read).replace(/[. ]+$/u, "") || "Deck";
  const reserved = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
  return `${reserved.test(base) ? "_" : ""}${base}.dck`;
}
