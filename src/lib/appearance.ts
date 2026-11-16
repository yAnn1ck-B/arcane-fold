import type { AppearanceSettings } from "@/lib/types";

export const defaultAppearance: AppearanceSettings = {
  theme: "light",
  fontSize: "large",
};

export const appearanceThemes = [
  {
    id: "forest",
    name: "Forest",
    description: "Classic green",
    background: "#18201b",
    accent: "#b4c89c",
  },
  {
    id: "midnight",
    name: "Midnight",
    description: "Deep blue",
    background: "#101a30",
    accent: "#9ec6f3",
  },
  {
    id: "slate",
    name: "Slate",
    description: "Neutral charcoal",
    background: "#181b22",
    accent: "#b6c6e1",
  },
  {
    id: "light",
    name: "Daylight",
    description: "Light parchment",
    background: "#fbfaf5",
    accent: "#496845",
  },
] as const;

export function normalizeAppearance(
  value?: Partial<AppearanceSettings>,
): AppearanceSettings {
  return {
    theme: appearanceThemes.some((theme) => theme.id === value?.theme)
      ? value!.theme!
      : defaultAppearance.theme,
    fontSize:
      value?.fontSize === "normal" ? "normal" : defaultAppearance.fontSize,
  };
}
