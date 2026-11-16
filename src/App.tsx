import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { migrateForgeDecks } from "@/services/decks";
import {
  AlertCircle,
  ArrowRight,
  LayoutDashboard,
  Library,
  LoaderCircle,
  Monitor,
  Package,
  Settings2,
  Swords,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import Dashboard from "@/pages/Dashboard";
import Settings from "@/pages/Settings";
import Collection from "@/pages/Collection";
import DeckBuilder from "@/pages/DeckBuilder";
import Boosters from "@/pages/Boosters";
import { leagueStatus } from "@/services/progression";
import {
  catalogStatus,
  ensureCatalog,
  getBannerCard,
  onCatalogProgress,
} from "@/services/cards";
import {
  loadDashboardStats,
  loadSettings,
  saveSettings,
} from "@/services/database";
import { testForgeIntegration } from "@/services/forge";
import type {
  AppSettings,
  CatalogProgress,
  CatalogCard,
  CatalogStatus,
  DashboardStats,
  ForgePaths,
  IntegrationReport,
  LeagueStatus,
  Page,
} from "@/lib/types";

export default function App() {
  const [page, setPage] = useState<Page>("dashboard");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [report, setReport] = useState<IntegrationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [bannerCard, setBannerCard] = useState<CatalogCard | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CatalogStatus>({
    count: 0,
    updatedAt: null,
  });
  const [importProgress, setImportProgress] = useState<CatalogProgress | null>(
    null,
  );
  const [importBusy, setImportBusy] = useState(false);
  const importing = useRef(false);
  const pendingCatalog = useRef<ForgePaths | null>(null);
  const initializing = useRef(false);
  const [revision, setRevision] = useState(0);
  const [visited, setVisited] = useState({
    collection: false,
    decks: false,
    boosters: false,
  });
  const [league, setLeague] = useState<LeagueStatus>({
    started: false,
    availablePacks: 0,
    wildcards: { common: 0, uncommon: 0, rare: 0, mythic: 0 },
    enabledSets: [],
    nextRewardAt: null,
    canClaimWeekly: false,
    week: 1,
    history: [],
  });
  const desktop = isTauri();
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    if (desktop)
      void getVersion()
        .then(setAppVersion)
        .catch(() => {});
  }, [desktop]);
  useEffect(() => {
    document.documentElement.dataset.theme =
      settings?.appearance.theme ?? "forest";
    document.documentElement.dataset.fontSize =
      settings?.appearance.fontSize ?? "normal";
  }, [settings?.appearance.theme, settings?.appearance.fontSize]);

  const initialize = useCallback(async () => {
    if (initializing.current) return;
    if (!desktop) {
      setLoading(false);
      return;
    }
    initializing.current = true;
    setLoading(true);
    setError(null);
    try {
      const loaded = await loadSettings();
      setSettings(loaded);
      setStats(await loadDashboardStats());
      setCatalog(await catalogStatus());
      setLeague(await leagueStatus());
      try {
        const checked = await testForgeIntegration(loaded.forge);
        setReport(checked);
        if (checked.installDirExists && checked.deckDirExists) {
          try {
            await migrateForgeDecks();
          } catch (migrationError) {
            setError(
              `Saved Forge decks could not be moved to their current folder: ${String(migrationError)}`,
            );
          }
        }
      } catch (err) {
        setError(
          `Settings loaded, but Forge could not be checked: ${String(err)}`,
        );
      }
      void prepareCatalog(loaded.forge);
    } catch (err) {
      setError(`Could not open your local database: ${String(err)}`);
    } finally {
      setLoading(false);
      initializing.current = false;
    }
  }, [desktop]);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  const handleDataChange = useCallback(() => {
    setRevision((value) => value + 1);
    void loadDashboardStats()
      .then(setStats)
      .catch((err: unknown) => setError(String(err)));
    void leagueStatus()
      .then(setLeague)
      .catch((err: unknown) => setError(String(err)));
  }, []);

  useEffect(() => {
    if (!desktop || loading || !settings) return;
    const refresh = () => {
      if (document.visibilityState === "visible") handleDataChange();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const now = Date.now();
    const startedAt = settings.league.startedAt * 1000;
    const week = 7 * 24 * 60 * 60 * 1000;
    const nextBoundary =
      now < startedAt
        ? startedAt
        : startedAt + (Math.floor((now - startedAt) / week) + 1) * week;
    const due = nextBoundary - now;
    const timer =
      due > 0
        ? window.setTimeout(refresh, Math.min(due + 250, 2_147_483_647))
        : undefined;
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.clearTimeout(timer);
    };
  }, [
    desktop,
    loading,
    settings,
    league.nextRewardAt,
    league.canClaimWeekly,
    league.week,
    handleDataChange,
  ]);

  function navigate(next: Page) {
    if (next === "collection" || next === "decks" || next === "boosters")
      setVisited((current) => ({ ...current, [next]: true }));
    setPage(next);
  }

  async function prepareCatalog(paths: ForgePaths) {
    pendingCatalog.current = paths;
    if (importing.current) return;
    importing.current = true;
    setImportBusy(true);
    setImportProgress(null);
    setCatalogError(null);
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await onCatalogProgress(setImportProgress);
      while (pendingCatalog.current) {
        const current = pendingCatalog.current;
        pendingCatalog.current = null;
        try {
          setCatalog(await ensureCatalog(current));
          setReport(await testForgeIntegration(current));
          setRevision((value) => value + 1);
          setCatalogError(null);
        } catch (err) {
          setCatalogError(
            `Card catalog setup could not finish: ${String(err)}`,
          );
        }
        try {
          setBannerCard(await getBannerCard());
        } catch {
          // Already downloaded artwork and the rest of the app remain usable offline.
        }
      }
    } catch (err) {
      setCatalogError(`Card catalog setup could not finish: ${String(err)}`);
    } finally {
      unlisten?.();
      importing.current = false;
      setImportBusy(false);
    }
  }

  async function handleSave(updated: AppSettings) {
    await saveSettings(updated);
    const saved = await loadSettings();
    const forgeChanged =
      JSON.stringify(saved.forge) !== JSON.stringify(settings?.forge);
    setSettings(saved);
    setLeague(await leagueStatus());
    setRevision((value) => value + 1);
    if (!forgeChanged) return;
    setReport(null);
    try {
      const checked = await testForgeIntegration(saved.forge);
      setReport(checked);
      if (checked.installDirExists && checked.deckDirExists) {
        try {
          await migrateForgeDecks();
        } catch (migrationError) {
          setError(
            `Saved Forge decks could not be moved to their current folder: ${String(migrationError)}`,
          );
        }
      }
      void prepareCatalog(saved.forge);
    } catch (err) {
      setError(`Settings saved. Forge check failed: ${String(err)}`);
    }
  }

  const connected =
    !!report?.installDirExists &&
    report.deckDirExists &&
    report.imageCacheDirExists;
  const navigation = [
    { id: "dashboard" as const, label: "Overview", icon: LayoutDashboard },
    { id: "collection" as const, label: "Collection", icon: Library },
    { id: "decks" as const, label: "Deck builder", icon: Swords },
    { id: "boosters" as const, label: "Booster packs", icon: Package },
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <LayersMark />
          </div>
          <div>
            <strong>ETERNAL</strong>
            <span>L E A G U E</span>
          </div>
        </div>
        <div className="sidebar-divider" />
        <nav className="main-nav" aria-label="Main navigation">
          {navigation.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item ${page === id ? "active" : ""}`}
              onClick={() => navigate(id)}
              aria-current={page === id ? "page" : undefined}
            >
              <Icon size={18} strokeWidth={1.7} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-grow" />
        <nav className="utility-nav" aria-label="App navigation">
          <button
            className={`nav-item ${page === "settings" ? "active" : ""}`}
            onClick={() => setPage("settings")}
            aria-current={page === "settings" ? "page" : undefined}
          >
            <Settings2 size={18} strokeWidth={1.7} />
            <span>Settings</span>
          </button>
        </nav>
        <div className="sidebar-status">
          <span
            className={connected ? "status-dot" : "status-dot status-dot-muted"}
          />
          <div>
            <strong>
              {report?.forgeVersion
                ? `Forge ${report.forgeVersion}`
                : connected
                  ? "Forge detected"
                  : "Forge setup"}
            </strong>
            <span>
              {connected
                ? "Connected on this device"
                : "Configure your folders"}
            </span>
            {appVersion && (
              <small className="app-version">App v{appVersion}</small>
            )}
          </div>
        </div>
      </aside>
      <main className="main-content">
        <div className="page-content">
          <header className="page-heading">
            <h1>
              {
                {
                  settings: "Settings",
                  collection: "Collection",
                  decks: "Deck builder",
                  dashboard: "Overview",
                  boosters: "Booster packs",
                }[page]
              }
            </h1>
          </header>

          {importBusy && (
            <div className="notice" role="status">
              <LoaderCircle size={17} className="animate-spin" />
              <span>
                {catalog.count
                  ? "Checking card catalog for this Forge version…"
                  : "Preparing your card catalog…"}
                {importProgress?.processed
                  ? ` ${importProgress.processed.toLocaleString()} printings processed.`
                  : ""}
              </span>
            </div>
          )}
          {catalogError && settings && !importBusy && (
            <div className="notice notice-error" role="alert">
              <AlertCircle size={18} />
              <span>{catalogError}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void prepareCatalog(settings.forge)}
              >
                Retry setup
              </Button>
            </div>
          )}

          {error && (
            <div className="notice notice-error" role="alert">
              <AlertCircle size={19} />
              <div>{error}</div>
              <Button variant="ghost" size="sm" onClick={() => setError(null)}>
                Dismiss
              </Button>
            </div>
          )}
          {!desktop ? (
            <section className="panel desktop-message">
              <Monitor size={38} />
              <h2>Made for your desktop.</h2>
              <p>
                Open the Tauri application to connect Forge and save your
                settings in SQLite.
              </p>
              <code>npm run tauri dev</code>
              <span>
                The browser preview cannot access native files or your database.
              </span>
            </section>
          ) : loading ? (
            <div className="loading-state" role="status">
              <LoaderCircle className="animate-spin" size={26} />
              <p>Opening your local league…</p>
            </div>
          ) : settings && stats ? (
            <>
              <div hidden={page !== "dashboard"}>
                <Dashboard
                  settings={settings}
                  stats={stats}
                  bannerCard={bannerCard}
                  catalogCount={catalog.count}
                  onCollection={() => navigate("collection")}
                  onDecks={() => navigate("decks")}
                  league={league}
                  onBoosters={() => navigate("boosters")}
                  revision={revision}
                />
              </div>
              {visited.collection && (
                <div hidden={page !== "collection"}>
                  <Collection
                    settings={settings}
                    revision={revision}
                    onChange={handleDataChange}
                    league={league}
                    catalogCount={catalog.count}
                    onSettings={() => navigate("settings")}
                  />
                </div>
              )}
              {visited.decks && (
                <div hidden={page !== "decks"}>
                  <DeckBuilder
                    settings={settings}
                    revision={revision}
                    onChange={handleDataChange}
                    league={league}
                  />
                </div>
              )}
              {visited.boosters && (
                <div hidden={page !== "boosters"}>
                  <Boosters
                    settings={settings}
                    revision={revision}
                    onChange={handleDataChange}
                    league={league}
                  />
                </div>
              )}
              <div hidden={page !== "settings"}>
                <Settings
                  settings={settings}
                  onSave={handleSave}
                  report={report}
                  onReport={setReport}
                  catalogCount={catalog.count}
                />
              </div>
            </>
          ) : (
            <section className="panel desktop-message">
              <AlertCircle size={34} />
              <h2>Your league could not be opened.</h2>
              <p>
                Review the error above, then try connecting again. Your saved
                data will be preserved.
              </p>
              <Button onClick={() => void initialize()}>
                Try again <ArrowRight size={15} />
              </Button>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}

function LayersMark() {
  return (
    <svg
      width="30"
      height="36"
      viewBox="0 0 30 36"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M15 2 28 9.5v17L15 34 2 26.5v-17L15 2Z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="m9 12 6-3.5 6 3.5v12l-6 3.5L9 24V12Z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M15 9v18M9 12l12 12M21 12 9 24"
        stroke="currentColor"
        strokeWidth=".8"
      />
    </svg>
  );
}
