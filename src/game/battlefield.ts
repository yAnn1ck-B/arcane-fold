export type BattlefieldGroup = "Creatures" | "Lands" | "Other permanents";

export function battlefieldGroup(card: {
  typeLine?: string;
  faceDown?: boolean;
  back?: boolean;
  power?: number;
}): BattlefieldGroup {
  // A face-down card may have public power, but its printed type stays private.
  const face = card.faceDown ? undefined : card.typeLine?.split(/\s*\/\/\s*/)[card.back ? 1 : 0];
  const types = face?.split(/[—–]|\s-\s/, 1)[0].toLowerCase().split(/\s+/);
  if (types?.includes("creature") || (!face && card.power != null)) return "Creatures";
  if (types?.includes("land")) return "Lands";
  return "Other permanents";
}
