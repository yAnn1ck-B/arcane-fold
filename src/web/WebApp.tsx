import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, Layers, LayoutDashboard, Library, LogOut, Package, Swords } from "lucide-react";
import { Button } from "@/components/ui/button";
import ToastProvider from "@/components/ToastProvider";
import type { AppSettings, CatalogCard, DashboardStats, DeckAddRequest, LeagueStatus } from "@/lib/types";
import Dashboard from "@/pages/Dashboard";
import { catalogStatus, getBannerCard } from "@/services/cards";
import { leagueStatus } from "@/services/progression";
import { invoke } from "@/services/league-transport";
import { bindAccount, errorMessage, roomRequest } from "./room-api";
import WebLogin, { type AuthState } from "./WebLogin";

const Boosters = lazy(() => import("@/pages/Boosters"));
const Collection = lazy(() => import("@/pages/Collection"));
const DeckBuilder = lazy(() => import("@/pages/DeckBuilder"));
const LeagueGuide = lazy(() => import("@/pages/LeagueGuide"));
const WebPlay = lazy(() => import("./WebPlay"));

const navigation = [
  { page: "dashboard", title: "Overview", icon: LayoutDashboard },
  { page: "collection", title: "Collection", icon: Library },
  { page: "decks", title: "Deck builder", icon: Swords },
  { page: "play", title: "Play", icon: Layers },
  { page: "boosters", title: "Booster packs", icon: Package },
  { page: "guide", title: "League guide", icon: BookOpen },
] as const;

type WebPage = (typeof navigation)[number]["page"];

function currentPage(): WebPage {
  const params = new URL(window.location.href).searchParams;
  if (params.has("room") || params.has("join")) return "play";
  if (params.get("page") === "settings") return "guide";
  return navigation.find((entry) => entry.page === params.get("page"))?.page ?? "dashboard";
}

interface LeagueView {
  settings: AppSettings;
  league: LeagueStatus;
  stats: DashboardStats;
  catalogCount: number;
}

async function loadLeague(): Promise<LeagueView> {
  const [rules, catalog, league] = await Promise.all([invoke<AppSettings["league"]>("league_rules"), catalogStatus(), leagueStatus()]);
  const stats = await invoke<DashboardStats>("load_dashboard_stats");
  return {
    settings: { league: rules },
    catalogCount: catalog.count, league, stats,
  };
}

const sessionChangeKey = "arcane-fold.session-change";

function notifySessionChange() {
  try { localStorage.setItem(sessionChangeKey, Date.now().toString()); }
  catch { /* Browsers with storage disabled still recheck identity on API requests. */ }
  window.location.reload();
}

export default function WebApp() {
  const [auth, setAuth] = useState<AuthState>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void roomRequest<AuthState>("/auth", undefined, controller.signal).then((state) => {
      if (controller.signal.aborted) return;
      if (state.user) bindAccount(state.user.email);
      setAuth(state);
    }).catch((cause) => { if (!controller.signal.aborted) setError(errorMessage(cause)); });
    return () => controller.abort();
  }, [retry]);

  useEffect(() => {
    const reloadPage = () => window.location.reload();
    const storageChange = (event: StorageEvent) => { if (event.key === sessionChangeKey) reloadPage(); };
    const restorePage = (event: PageTransitionEvent) => { if (event.persisted) reloadPage(); };
    window.addEventListener("storage", storageChange);
    window.addEventListener("pageshow", restorePage);
    window.addEventListener("league-session-changed", reloadPage);
    return () => {
      window.removeEventListener("storage", storageChange);
      window.removeEventListener("pageshow", restorePage);
      window.removeEventListener("league-session-changed", reloadPage);
    };
  }, []);

  if (!auth?.user) return <WebLogin auth={auth} loadError={error}
    onRetry={() => setRetry((value) => value + 1)} onSignedIn={notifySessionChange} />;
  return <PlayerLeague user={auth.user} />;
}

function PlayerLeague({ user }: { user: NonNullable<AuthState["user"]> }) {
  const [page, setPage] = useState(currentPage);
  const [signingOut, setSigningOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const [data, setData] = useState<LeagueView>();
  const [banner, setBanner] = useState<CatalogCard | null>(null);
  const [revision, setRevision] = useState(0);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState("");
  const [add, setAdd] = useState<DeckAddRequest | null>(null);
  const [visited, setVisited] = useState<Partial<Record<WebPage, boolean>>>(() => ({ [currentPage()]: true }));
  const latestRead = useRef(0);
  const flushDeck = useRef<(() => Promise<void>) | null>(null);

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    setLogoutError("");
    try {
      await flushDeck.current?.();
      await roomRequest("/logout", {});
      const url = new URL(window.location.href);
      url.searchParams.delete("room");
      window.history.replaceState(null, "", url);
      notifySessionChange();
    } catch (cause) {
      setLogoutError(errorMessage(cause));
      setSigningOut(false);
    }
  }

  const refreshLeague = useCallback(async () => {
    const sequence = ++latestRead.current;
    try {
      const next = await loadLeague();
      if (sequence !== latestRead.current) return;
      setData(next);
      setRevision((version) => version + 1);
      setError("");
    } catch (cause) {
      if (sequence === latestRead.current) setError(errorMessage(cause));
    }
  }, []);

  useEffect(() => {
    void refreshLeague();
    return () => { latestRead.current++; };
  }, [refreshLeague, reload]);

  const count = data?.catalogCount ?? 0;
  useEffect(() => {
    if (!count) return;
    let active = true;
    void getBannerCard().then((card) => { if (active) setBanner(card); }).catch(() => {});
    return () => { active = false; };
  }, [count]);

  useEffect(() => {
    function refreshVisible() { if (!document.hidden) void refreshLeague(); }
    document.addEventListener("visibilitychange", refreshVisible);
    const due = data?.league.nextRewardAt ? Date.parse(data.league.nextRewardAt) - Date.now() : 0;
    const timer = due > 0 ? window.setTimeout(refreshVisible, Math.min(due + 250, 2147483647)) : undefined;
    return () => {
      document.removeEventListener("visibilitychange", refreshVisible);
      window.clearTimeout(timer);
    };
  }, [data?.league.nextRewardAt, refreshLeague]);

  useEffect(() => {
    function restore() {
      const target = currentPage();
      setPage(target);
      setVisited((previous) => ({ ...previous, [target]: true }));
    }
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);

  function navigate(target: WebPage) {
    if (page === target) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("room");
    url.searchParams.delete("join");
    url.searchParams.set("page", target);
    window.history.pushState(null, "", url);
    setPage(target);
    setVisited((previous) => ({ ...previous, [target]: true }));
    window.scrollTo(0, 0);
  }

  const ready = page === "play" || data;
  return (
    <div className="app-shell web-shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="/arcane-fold.png" width="32" height="32" alt="" />
          <div><strong>ARCANE</strong><span>FOLD</span></div>
        </div>
        <div className="sidebar-divider" />
        <nav className="main-nav" aria-label="Main navigation">
          {navigation.map(({ page: target, title, icon: Icon }) => (
            <button key={target} className={`nav-item ${target === "guide" ? "web-guide-link" : ""} ${target === page ? "active" : ""}`}
              aria-current={target === page ? "page" : undefined} onClick={() => navigate(target)}>
              <Icon size={18} strokeWidth={1.7} /><span>{title}</span>
            </button>
          ))}
        </nav>
        <div className="web-account">
          <span className="web-avatar" aria-hidden>{user.name.charAt(0)}</span>
          <strong>{user.name}</strong>
          <button type="button" onClick={() => void signOut()} disabled={signingOut} title="Sign out" aria-label="Sign out">
            <LogOut size={16} aria-hidden />
          </button>
        </div>
      </aside>
      <main className="main-content" inert={signingOut}><div className="page-content">
        {page !== "play" && <header className="page-heading"><h1>{navigation.find((entry) => entry.page === page)?.title}</h1></header>}
        {logoutError && <div className="notice notice-error" role="alert">Sign out failed. {logoutError}</div>}
        {error && <div className="notice notice-error" role="alert">{error}
          <Button variant="outline" onClick={() => setReload((number) => number + 1)}>Retry</Button>
        </div>}
        {!ready && !error && <div className="loading-state" role="status">Opening your league…</div>}
        <Suspense fallback={<p role="status">Opening page…</p>}>
          {page === "play" && <WebPlay leagueRevision={revision} />}
          {data && <>
            {page === "dashboard" && <Dashboard settings={data.settings} stats={data.stats} bannerCard={banner}
              catalogCount={count} league={data.league} revision={revision}
              onCollection={() => navigate("collection")} onDecks={() => navigate("decks")} onBoosters={() => navigate("boosters")} />}
            {visited.collection && <div hidden={page !== "collection"}><Collection revision={revision}
              league={data.league} catalogCount={count} onChange={refreshLeague}
              onAddToDeck={(card) => {
                setAdd({ requestId: crypto.randomUUID(), card });
                setVisited((previous) => ({ ...previous, decks: true }));
              }} /></div>}
            {visited.decks && <div hidden={page !== "decks"}><DeckBuilder settings={data.settings} revision={revision}
              league={data.league} onChange={refreshLeague} addRequest={add} flushRef={flushDeck}
              onAddRequestHandled={(id) => setAdd((previous) => previous?.requestId === id ? null : previous)} /></div>}
            {visited.boosters && <div hidden={page !== "boosters"}><Boosters active={page === "boosters"} accountEmail={user.email}
              settings={data.settings} revision={revision} onChange={refreshLeague} league={data.league} /></div>}
            {page === "guide" && <LeagueGuide settings={data.settings} leagueStatus={data.league} catalogCount={count} />}
          </>}
        </Suspense>
      </div></main>
      <ToastProvider />
    </div>
  );
}
