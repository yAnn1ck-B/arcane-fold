export type Page =
  "dashboard" | "collection" | "decks" | "playtest" | "boosters" | "settings";

export interface ForgePaths {
  dataDir: string;
  deckDir: string;
  imageCacheDir: string;
  installDir: string;
}

export interface AppearanceSettings {
  theme: "forest" | "midnight" | "slate" | "light";
  fontSize: "normal" | "large";
}

export interface AppSettings {
  forge: ForgePaths;
  appearance: AppearanceSettings;
  league: {
    startedAt: number;
    expansionSchedule: ExpansionScheduleEntry[];
    startingPacks: number;
    startingWildcards?: WildcardBalances;
    weeklyPacks: number;
    weeklyWildcards: WildcardBalances;
    wildcardRewardIntervals: Record<WildcardKind, number>;
    wildcardRewardOffsets: Record<WildcardKind, number>;
    mythicProbability: number;
    enabledSets: string[];
    booster: {
      commons: number;
      uncommons: number;
      rareSlots: number;
      basicLands: number;
      commonLandWeight: number;
      preferredLandLimit: number;
    };
    wildcardDropProbability: number;
    autoUnlock: { intervalWeeks: number; setCodes: string[] };
    deckRestrictions: {
      minimumMainDeck: number;
      maximumSideboard: number;
      normalCopyLimit: number;
    };
  };
}

export interface ExpansionScheduleEntry {
  week: number;
  code: string;
  name: string;
  description: string;
  bonusPacks: number;
}

export interface IntegrationReport {
  dataDirExists: boolean;
  deckDirExists: boolean;
  imageCacheDirExists: boolean;
  installDirExists: boolean;
  sampleImagePath: string | null;
  sampleDeckPath: string | null;
  warnings: string[];
  forgeVersion: string | null;
  forgeInstallDir: string | null;
}

export interface ExportResult {
  path: string;
  content: string;
}

export interface DashboardStats {
  uniqueCards: number;
  totalCards: number;
  decks: number;
  wildcards: number;
}

export interface CatalogCard {
  id: string;
  oracleId: string;
  name: string;
  setCode: string;
  setName: string;
  collectorNumber: string;
  rarity: string;
  manaCost: string;
  cmc: number;
  typeLine: string;
  oracleText: string;
  producedMana?: string[];
  colors: string[];
  imageUri: string | null;
  backImageUri: string | null;
  owned: number;
  oracleOwned?: number;
  forgeSetCode?: string | null;
}

export interface CardQuery {
  search: string;
  ownedOnly: boolean;
  color: string;
  rarity: string;
  setCode: string;
  typeLine: string;
  manaValue: string;
  minOwned: number;
  page: number;
  pageSize: number;
  includeBasicLands?: boolean;
  colors: string[];
  manaValues: number[];
  cardTypes: string[];
  creatureType: string;
  groupByOracle: boolean;
  availableOnly: boolean;
  allocated: Record<string, number>;
}

export interface CardFilterOptions {
  colors: string[];
  manaValues: number[];
  rarities: string[];
  sets: CatalogSet[];
  cardTypes: string[];
}

export interface DeckAddRequest {
  requestId: string;
  card: CatalogCard;
}

export interface CatalogStatus {
  count: number;
  updatedAt: string | null;
}
export interface CatalogProgress {
  stage: string;
  processed: number;
  total: number | null;
  message: string;
}
export interface CatalogSet {
  code: string;
  name: string;
  count: number;
}
export interface CardQueryResult {
  cards: CatalogCard[];
  total: number;
}
export interface DeckSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  mainCount: number;
  sideboardCount: number;
}
export interface DeckEntry {
  card: CatalogCard;
  section: "main" | "sideboard";
  quantity: number;
}
export interface DeckDetail {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  cards: DeckEntry[];
}
export interface DeckDraft {
  id: string | null;
  name: string;
  cards: { cardId: string; section: "main" | "sideboard"; quantity: number }[];
}
export interface DeckValidation {
  warnings: string[];
  mainCount: number;
  sideboardCount: number;
  canExport: boolean;
}

export type WildcardRarity = "common" | "uncommon" | "rare" | "mythic";
export type WildcardKind = WildcardRarity | "discovery";
export type WildcardBalances = Record<WildcardKind, number>;
export interface BoosterHistory {
  id: string;
  setCode: string;
  openedAt: string;
  cards: CatalogCard[];
  duplicateWildcards?: WildcardBalances;
}
export interface LeagueStatus {
  openablePacks?: number;
  previewWeeks?: number;
  effectiveNow?: string;
  generalPacks?: number;
  setPacks?: Record<string, number>;
  claimableSetPacks?: Record<string, number>;
  joinSetPacks?: Record<string, number>;
  nextExpansion?: ExpansionScheduleEntry | null;
  upcomingExpansions?: ExpansionScheduleEntry[];
  startedAt?: number;
  claimableWeeks?: number;
  claimablePacks?: number;
  claimableWildcards?: WildcardBalances;
  joinPacks?: number;
  joinWildcards?: WildcardBalances;
  started: boolean;
  availablePacks: number;
  wildcards: WildcardBalances;
  enabledSets: string[];
  nextRewardAt: string | null;
  canClaimWeekly: boolean;
  week: number;
  history: BoosterHistory[];
}
export interface BoosterOpening {
  perSetPacks?: Record<string, number>;
  id: string;
  packs: number;
  setCode: string;
  cards: CatalogCard[];
  wildcards: WildcardBalances;
  duplicateWildcards?: WildcardBalances;
}
