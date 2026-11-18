import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { appLifecycle, protectWindowClose } from "@/lib/app-lifecycle";
import { migrateForgeDecks } from "@/services/decks";
import {
  AlertCircle,
  ArrowRight,
  Layers,
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
import UpdatePrompt from "@/components/UpdatePrompt";
import { updater } from "@/services/updater";
import { isUpdateBlocking } from "@/services/updater-controller";
import { isDatabaseBusy, retryDatabaseBusy } from "@/lib/database-retry";
import ToastProvider from "@/components/ToastProvider";
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
  DeckAddRequest,
  ForgePaths,
  IntegrationReport,
  LeagueStatus,
  Page,
} from "@/lib/types";

const PlayPage = lazy(() => import("@/pages/Play"));

type CatalogSetupError = {
  message: string;
  action: "configure-forge" | "retry";
};

type CatalogSetupRequest = { id: number; paths: ForgePaths };

function catalogSetupFailure(
  error: unknown,
  inspection?: IntegrationReport,
): CatalogSetupError {
  const message = String(error);
  const folderProblem =
    inspection?.installDirExists === false ||
    /select (?:your |its )?forge installation folder|forge installation (?:was not found|folder.*(?:absolute|invalid|missing|required))|(?:deck export|image cache) folder.*(?:absolute|invalid|missing|required)/i.test(
      message,
    );
  return {
    message: folderProblem
      ? "Choose a valid Forge installation folder to finish setting up your card catalog."
      : `Card catalog setup could not finish: ${message}`,
    action: folderProblem ? "configure-forge" : "retry",
  };
}

export default function App() {
  const desktop = isTauri();
  const enforceUpdates = desktop && !import.meta.env.DEV;
  const updateState = useSyncExternalStore(
    updater.subscribe,
    updater.getSnapshot,
  );
  const updateBlocked = enforceUpdates && isUpdateBlocking(updateState);
  const canUseLeague = useCallback(
    () => !enforceUpdates || !isUpdateBlocking(updater.getSnapshot()),
    [enforceUpdates],
  );
  const [repairMode, setRepairMode] = useState(false);
  const repairing = updateBlocked && repairMode;
  const initializationRequested = useRef(false);
  const refreshPending = useRef(false);
  const exitState = useSyncExternalStore(
    appLifecycle.subscribe,
    appLifecycle.getSnapshot,
  );
  useEffect(() => {
    if (!exitState.busy) return;
    // Body portals escape app-shell inert, so freeze native modal controls too.
    const previous = new Map<HTMLElement, boolean>();
    const freeze = () => {
      for (const dialog of document.querySelectorAll<HTMLElement>(
        "dialog[open]",
      )) {
        if (!previous.has(dialog)) previous.set(dialog, dialog.inert);
        dialog.inert = true;
      }
    };
    freeze();
    const observer = new MutationObserver(freeze);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    return () => {
      observer.disconnect();
      for (const [dialog, inert] of previous) dialog.inert = inert;
    };
  }, [exitState.busy]);
  const [page, setPage] = useState<Page>("dashboard");
  const [deckAddRequest, setDeckAddRequest] = useState<DeckAddRequest | null>(
    null,
  );
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [report, setReport] = useState<IntegrationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [bannerCard, setBannerCard] = useState<CatalogCard | null>(null);
  const [catalogError, setCatalogError] = useState<CatalogSetupError | null>(
    null,
  );
  const [forgeSetupRequest, setForgeSetupRequest] = useState(0);
  const [catalog, setCatalog] = useState<CatalogStatus>({
    count: 0,
    updatedAt: null,
  });
  const [importProgress, setImportProgress] = useState<CatalogProgress | null>(
    null,
  );
  const [importBusy, setImportBusy] = useState(false);
  const importing = useRef(false);
  const pendingCatalog = useRef<CatalogSetupRequest | null>(null);
  const catalogRequestId = useRef(0);
  const activeCatalogRequestId = useRef<number | null>(null);
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
    wildcards: { common: 0, uncommon: 0, rare: 0, mythic: 0, discovery: 0 },
    enabledSets: [],
    nextRewardAt: null,
    canClaimWeekly: false,
    week: 1,
    history: [],
  });
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    const guard = protectWindowClose(getCurrentWindow(), appLifecycle);
    void guard.ready.catch((failure: unknown) => {
      if (active)
        setError(
          `The safe-close handler could not start. Keep the app open until deck changes finish saving: ${String(failure)}`,
        );
    });
    return () => {
      active = false;
      guard.dispose();
    };
  }, [desktop]);
  useEffect(() => {
    if (desktop)
      void getVersion()
        .then(setAppVersion)
        .catch(() => {});
  }, [desktop]);
  useEffect(() => {
    document.documentElement.dataset.theme =
      settings?.appearance.theme ?? "light";
    document.documentElement.dataset.fontSize =
      settings?.appearance.fontSize ?? "large";
  }, [settings?.appearance.theme, settings?.appearance.fontSize]);

  const initialize = useCallback(async () => {
    if (initializing.current || !canUseLeague()) return;
    if (!desktop) {
      setLoading(false);
      return;
    }
    initializing.current = true;
    initializationRequested.current = true;
    setLoading(true);
    setError(null);
    try {
      const loaded = await loadSettings();
      setSettings(loaded);
      setCatalog(await retryDatabaseBusy(catalogStatus));
      setLeague(await retryDatabaseBusy(leagueStatus));
      setStats(await loadDashboardStats());
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
      setError(
        isDatabaseBusy(err)
          ? "Your local database is still busy. Close any other Eternal League windows, then try again. Your saved progress is preserved."
          : `Could not open your local database: ${String(err)}`,
      );
    } finally {
      setLoading(false);
      initializing.current = false;
    }
  }, [desktop, canUseLeague]);

  useEffect(() => {
    if (!updateBlocked && !initializationRequested.current) void initialize();
  }, [initialize, updateBlocked]);

  const handleDataChange = useCallback(() => {
    if (!canUseLeague() || importing.current) {
      refreshPending.current = true;
      return;
    }
    refreshPending.current = false;
    setRevision((value) => value + 1);
    void leagueStatus()
      .then((next) => {
        setLeague(next);
        return loadDashboardStats();
      })
      .then(setStats)
      .catch((err: unknown) => setError(String(err)));
  }, [canUseLeague]);

  useEffect(() => {
    if (!updateBlocked && !importBusy && refreshPending.current)
      handleDataChange();
  }, [updateBlocked, importBusy, handleDataChange]);

  useEffect(() => {
    if (!desktop || loading || !settings || updateBlocked || importBusy) return;
    const refresh = () => {
      if (document.visibilityState === "visible") handleDataChange();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const week = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now() + (league.previewWeeks ?? 0) * week;
    const startedAt = settings.league.startedAt * 1000;
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
    updateBlocked,
    importBusy,
    loading,
    settings,
    league.nextRewardAt,
    league.canClaimWeekly,
    league.week,
    league.previewWeeks,
    handleDataChange,
  ]);

  function navigate(next: Page) {
    if (
      !canUseLeague() &&
      (!repairing || !["decks", "settings"].includes(next))
    )
      return;
    if (next === "collection" || next === "decks" || next === "boosters")
      setVisited((current) => ({ ...current, [next]: true }));
    setPage(next);
    window.requestAnimationFrame(() =>
      window.scrollTo({ top: 0, left: 0, behavior: "instant" }),
    );
  }

  function configureForge() {
    setForgeSetupRequest((request) => request + 1);
    navigate("settings");
  }

  async function prepareCatalog(paths: ForgePaths) {
    if (!canUseLeague()) return;
    pendingCatalog.current = {
      id: ++catalogRequestId.current,
      paths: { ...paths },
    };
    setCatalogError(null);
    setImportProgress(null);
    if (importing.current) return;
    importing.current = true;
    refreshPending.current = true;
    setImportBusy(true);
    let unlisten: (() => void) | undefined;
    try {
      try {
        unlisten = await onCatalogProgress((progress) => {
          if (activeCatalogRequestId.current === catalogRequestId.current)
            setImportProgress(progress);
        });
      } catch {
        // Progress notifications are optional; native setup can still complete.
      }
      while (pendingCatalog.current) {
        const request = pendingCatalog.current;
        pendingCatalog.current = null;
        activeCatalogRequestId.current = request.id;
        const current = () => request.id === catalogRequestId.current;
        let inspection: IntegrationReport | undefined;
        if (current()) setImportProgress(null);
        try {
          inspection = await testForgeIntegration(request.paths);
          if (!current()) continue;
          setReport(inspection);
          if (!inspection.installDirExists)
            throw new Error("Select your Forge installation folder.");
          const prepared = await ensureCatalog(request.paths);
          if (!current()) continue;
          setCatalog(prepared);
          setRevision((value) => value + 1);
          setCatalogError(null);
        } catch (err) {
          if (current()) setCatalogError(catalogSetupFailure(err, inspection));
        }
        if (!current()) continue;
        try {
          const banner = await getBannerCard();
          if (current()) setBannerCard(banner);
        } catch {
          // Already downloaded artwork and the rest of the app remain usable offline.
        }
      }
    } finally {
      try {
        unlisten?.();
      } catch {
        // A listener cleanup failure must not leave setup stuck in a busy state.
      }
      activeCatalogRequestId.current = null;
      importing.current = false;
      setImportBusy(false);
    }
  }

  async function handleSave(updated: AppSettings) {
    if (!canUseLeague() && !repairing)
      throw new Error("Finish the required application update first.");
    await saveSettings(updated);
    const saved = await loadSettings();
    const forgeChanged =
      JSON.stringify(saved.forge) !== JSON.stringify(settings?.forge);
    setSettings(saved);
    if (canUseLeague()) {
      setLeague(await leagueStatus());
      setRevision((value) => value + 1);
    }
    if (forgeChanged) {
      // Invalidate callbacks from an attempt using the previous saved folders.
      catalogRequestId.current += 1;
      setCatalogError(null);
      setReport(null);
    }
    try {
      const checked = await testForgeIntegration(saved.forge);
      setReport(checked);
      if (forgeChanged && checked.installDirExists && checked.deckDirExists) {
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
    { id: "play" as const, label: "Play", icon: Layers },
    { id: "boosters" as const, label: "Booster packs", icon: Package },
  ];

  return (
    <div
      className="app-shell"
      inert={exitState.busy || (updateBlocked && !repairing)}
    >
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
          {navigation
            .filter(({ id }) => !repairing || id === "decks")
            .map(({ id, label, icon: Icon }) => (
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
            onClick={() => navigate("settings")}
            aria-current={page === "settings" ? "page" : undefined}
          >
            <Settings2 size={18} strokeWidth={1.7} />
            <span>{repairing ? "Forge folders" : "Settings"}</span>
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
            {!!league.previewWeeks && (
              <small className="app-version">
                Preview · +{league.previewWeeks} weeks
              </small>
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
                  play: "Play",
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
                {importProgress?.stage === "finalizing"
                  ? "Saving your card catalog…"
                  : catalog.count
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
              <span>{catalogError.message}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (catalogError.action === "configure-forge")
                    configureForge();
                  else void prepareCatalog(settings.forge);
                }}
              >
                {catalogError.action === "configure-forge"
                  ? "Configure Forge"
                  : "Retry setup"}
              </Button>
            </div>
          )}

          {exitState.error && (
            <div className="notice notice-error" role="alert">
              <AlertCircle size={19} />
              <span>{exitState.error}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate("decks")}
              >
                Review deck
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void appLifecycle.retry().catch(() => {})}
              >
                Try again
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
              <div hidden={repairing || page !== "dashboard"}>
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
                <div hidden={repairing || page !== "collection"}>
                  <Collection
                    settings={settings}
                    revision={revision}
                    onChange={handleDataChange}
                    league={league}
                    catalogCount={catalog.count}
                    onSettings={() => navigate("settings")}
                    onAddToDeck={(card) => {
                      setDeckAddRequest({
                        requestId: crypto.randomUUID(),
                        card,
                      });
                      setVisited((current) => ({ ...current, decks: true }));
                    }}
                  />
                </div>
              )}
              {visited.decks && (
                <div hidden={page !== "decks"}>
                  <DeckBuilder
                    repairOnly={repairing}
                    settings={settings}
                    revision={revision}
                    onChange={handleDataChange}
                    league={league}
                    addRequest={deckAddRequest}
                    onAddRequestHandled={(requestId) => {
                      setDeckAddRequest((current) =>
                        current?.requestId === requestId ? null : current,
                      );
                    }}
                  />
                </div>
              )}
              {page === "play" && !updateBlocked && (
                <Suspense fallback={<div role="status">Opening game table…</div>}>
                  <PlayPage
                    settings={settings}
                    canPlay={canUseLeague}
                    onDeckBuilder={() => navigate("decks")}
                  />
                </Suspense>
              )}
              {visited.boosters && (
                <div hidden={repairing || page !== "boosters"}>
                  <Boosters
                    active={page === "boosters" && !updateBlocked}
                    settings={settings}
                    revision={revision}
                    onChange={handleDataChange}
                    league={league}
                  />
                </div>
              )}
              <div hidden={page !== "settings"}>
                <Settings
                  repairOnly={repairing}
                  leagueStatus={league}
                  forgeSetupRequest={forgeSetupRequest}
                  catalogSetupNeeded={catalogError !== null}
                  settings={settings}
                  onSave={handleSave}
                  report={report}
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
      <UpdatePrompt
        busy={(loading && initializationRequested.current) || importBusy}
        repairMode={repairing}
        onReviewDeck={() => {
          setRepairMode(true);
          setVisited((current) => ({ ...current, decks: true }));
          setPage("decks");
        }}
        onResumeUpdate={() => setRepairMode(false)}
      />
      <ToastProvider />
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
