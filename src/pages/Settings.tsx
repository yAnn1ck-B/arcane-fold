import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  CalendarDays,
  FolderOpen,
  Loader2,
  Save,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ToastProvider";
import "@/styles/dashboard-art.css";
import { listSets } from "@/services/cards";
import { chooseDirectory, testForgeIntegration } from "@/services/forge";
import type {
  AppSettings,
  CatalogSet,
  ForgePaths,
  IntegrationReport,
  LeagueStatus,
} from "@/lib/types";

interface SettingsProps {
  settings: AppSettings;
  onSave?: (settings: AppSettings) => Promise<void>;
  report: IntegrationReport | null;
  catalogCount?: number;
  leagueStatus?: LeagueStatus;
  forgeSetupRequest?: number;
  catalogSetupNeeded?: boolean;
  repairOnly?: boolean;
  rulesOnly?: boolean;
}

type SettingsTab = "forge" | "league" | "calendar";
const settingsTabs = [
  { id: "forge", label: "Forge folders", Icon: FolderOpen },
  { id: "league", label: "League rules", Icon: Sparkles },
  { id: "calendar", label: "Expansion calendar", Icon: CalendarDays },
] as const;
type EditablePath = "installDir" | "deckDir" | "imageCacheDir";
const pathFields: { key: EditablePath; label: string; hint: string }[] = [
  {
    key: "installDir",
    label: "Forge installation folder",
    hint: "The Forge installation containing its res folder and desktop application.",
  },
  {
    key: "deckDir",
    label: "Constructed deck folder",
    hint: "League decks are saved in an Eternal League subfolder here.",
  },
  {
    key: "imageCacheDir",
    label: "Card image cache",
    hint: "Artwork already downloaded by Forge is used from this folder.",
  },
];

function pathKey(paths: ForgePaths) {
  return JSON.stringify([
    paths.installDir ?? "",
    paths.deckDir,
    paths.imageCacheDir,
  ]);
}

export default function Settings({
  settings,
  onSave,
  report,
  catalogCount = 0,
  leagueStatus,
  forgeSetupRequest = 0,
  catalogSetupNeeded = false,
  repairOnly = false,
  rulesOnly = false,
}: SettingsProps) {
  const toast = useToast();
  const [tab, setTab] = useState<SettingsTab>(rulesOnly ? "league" : "forge");
  const tabs = repairOnly ? settingsTabs.slice(0, 1) : rulesOnly ? settingsTabs.slice(1) : settingsTabs;
  function navigateTabs(
    event: KeyboardEvent<HTMLButtonElement>,
    current: SettingsTab,
  ) {
    const index = tabs.findIndex(({ id }) => id === current);
    const nextIndex =
      event.key === "ArrowRight"
        ? (index + 1) % tabs.length
        : event.key === "ArrowLeft"
          ? (index + tabs.length - 1) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : null;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = tabs[nextIndex].id;
    setTab(nextTab);
    document.getElementById(`settings-tab-${nextTab}`)?.focus();
  }
  const installInput = useRef<HTMLInputElement>(null);
  const focusedSetupRequest = useRef(0);
  useEffect(() => {
    if (forgeSetupRequest || repairOnly) setTab("forge");
  }, [forgeSetupRequest, repairOnly]);
  useEffect(() => {
    if (
      !forgeSetupRequest ||
      tab !== "forge" ||
      focusedSetupRequest.current === forgeSetupRequest
    )
      return;
    const frame = window.requestAnimationFrame(() => {
      installInput.current?.focus();
      focusedSetupRequest.current = forgeSetupRequest;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [forgeSetupRequest, tab]);
  const [draft, setDraft] = useState(settings);
  const [sets, setSets] = useState<CatalogSet[]>([]);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draftReport, setDraftReport] = useState<{
    key: string;
    report: IntegrationReport;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const savedKey = pathKey(settings.forge);
  useEffect(() => {
    setDraft((current) => ({
      ...current,
      forge: {
        ...settings.forge,
        installDir: settings.forge.installDir || report?.forgeInstallDir || "",
      },
    }));
  }, [savedKey]);
  useEffect(() => {
    void listSets()
      .then(setSets)
      .catch(() => {});
  }, [catalogCount]);
  const draftKey = pathKey(draft.forge);
  const dirty = draftKey !== savedKey;
  const currentReport = dirty
    ? draftReport?.key === draftKey
      ? draftReport.report
      : null
    : report;
  useEffect(() => {
    if (!dirty) return;
    let active = true;
    setChecking(true);
    const timer = window.setTimeout(() => {
      void testForgeIntegration(draft.forge)
        .then((result) => {
          if (active) setDraftReport({ key: draftKey, report: result });
        })
        .catch(() => {
          if (active) setDraftReport(null);
        })
        .finally(() => {
          if (active) setChecking(false);
        });
    }, 400);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [draftKey, dirty]);

  function detected(key: EditablePath) {
    if (!currentReport) return false;
    if (key === "installDir") return currentReport.installDirExists;
    return key === "deckDir"
      ? currentReport.deckDirExists
      : currentReport.imageCacheDirExists;
  }
  async function browse(key: EditablePath) {
    try {
      const selected = await chooseDirectory(draft.forge[key] ?? "");
      if (selected)
        setDraft((current) => ({
          ...current,
          forge: { ...current.forge, [key]: selected },
        }));
    } catch (error) {
      setNotice(String(error));
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !onSave) return;
    setSaving(true);
    setNotice(null);
    try {
      if (pathFields.some(({ key }) => !draft.forge[key]?.trim()))
        throw new Error("Choose all three Forge folders before saving.");
      const checked = await testForgeIntegration(draft.forge);
      setDraftReport({ key: draftKey, report: checked });
      if (
        !checked.installDirExists ||
        !checked.deckDirExists ||
        !checked.imageCacheDirExists
      )
        throw new Error(
          "One or more Forge folders were not detected. Check the highlighted paths.",
        );
      await onSave({ ...settings, forge: draft.forge });
      toast("Forge folders saved.");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setSaving(false);
    }
  }
  const expansionName = (code: string) =>
    settings.league.expansionSchedule.find(
      (entry) => entry.code.toLowerCase() === code.toLowerCase(),
    )?.name ??
    sets.find((set) => set.code.toLowerCase() === code.toLowerCase())?.name ??
    code.toUpperCase();
  const league = settings.league;
  const startingAt = league.startedAt;
  const calendar = [...league.expansionSchedule].sort(
    (a, b) => a.week - b.week,
  );
  const currentWeek = leagueStatus
    ? Math.max(0, (leagueStatus.week || 1) - 1)
    : Math.max(0, Math.floor((Date.now() / 1000 - startingAt) / 604800));
  const unlockedCount = calendar.filter(
    (entry) => entry.week <= currentWeek,
  ).length;
  const currentExpansion = calendar[unlockedCount - 1];
  const nextExpansion = calendar[unlockedCount];
  const composition = [
    [league.booster.commons, "commons"],
    [league.booster.uncommons, "uncommons"],
    [league.booster.rareSlots, "rare or mythic"],
  ]
    .filter(([quantity]) => Number(quantity) > 0)
    .map(([quantity, label]) => `${quantity} ${label}`)
    .join(" · ");
  return (
    <div className="settings-page">
      <div
        className="settings-tabs"
        role="tablist"
        aria-label={rulesOnly ? "League guide sections" : "Settings sections"}
      >
        {tabs.map(
          ({ id, label, Icon }) => (
            <button
              key={id}
              id={`settings-tab-${id}`}
              type="button"
              role="tab"
              aria-controls={`settings-panel-${id}`}
              aria-selected={(repairOnly ? "forge" : tab) === id}
              tabIndex={(repairOnly ? "forge" : tab) === id ? 0 : -1}
              className={`settings-tab ${(repairOnly ? "forge" : tab) === id ? "active" : ""}`}
              onClick={() => setTab(id)}
              onKeyDown={(event) => navigateTabs(event, id)}
            >
              <Icon size={16} /> {label}
            </button>
          ),
        )}
      </div>
      {notice && (
        <div className="notice notice-error" role="alert">
          <TriangleAlert size={18} />
          <span>{notice}</span>
        </div>
      )}
      {!rulesOnly && <form
        id="settings-panel-forge"
        role="tabpanel"
        aria-labelledby="settings-tab-forge"
        onSubmit={save}
        hidden={!repairOnly && tab !== "forge"}
      >
        <section className="panel">
          <div className="panel-body settings-stack forge-paths-body">
            {pathFields.map(({ key, label, hint }) => (
              <div className="field" key={key}>
                <Label htmlFor={`forge-${key}`}>{label}</Label>
                <div className="path-input-row">
                  <Input
                    id={`forge-${key}`}
                    ref={key === "installDir" ? installInput : undefined}
                    value={draft.forge[key] ?? ""}
                    required
                    disabled={saving}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        forge: { ...current.forge, [key]: event.target.value },
                      }))
                    }
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={saving}
                    onClick={() => void browse(key)}
                    aria-label={`Browse ${label.toLowerCase()}`}
                  >
                    <FolderOpen size={15} /> Browse
                  </Button>
                </div>
                <div className="forge-path-status">
                  <span
                    className={detected(key) ? "path-detected" : "path-missing"}
                  >
                    {dirty && checking
                      ? "Checking…"
                      : detected(key)
                        ? key === "installDir" && currentReport?.forgeVersion
                          ? `Detected · Forge ${currentReport.forgeVersion}`
                          : "Detected"
                        : "Not detected"}
                  </span>
                  <span>{hint}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="panel-footer settings-save-row">
            <Button
              type="submit"
              disabled={(!dirty && !catalogSetupNeeded) || saving}
            >
              {saving ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <Save size={15} />
              )}{" "}
              Save folders
            </Button>
          </div>
        </section>
      </form>}
      <section
        id="settings-panel-league"
        role="tabpanel"
        aria-labelledby="settings-tab-league"
        className="panel"
        hidden={repairOnly || tab !== "league"}
      >
        <div className="panel-body settings-stack">
          <dl className="league-rule-summary">
            {startingAt != null && (
              <div>
                <dt>League began</dt>
                <dd>{new Date(startingAt * 1000).toLocaleString()}</dd>
              </div>
            )}
            <div>
              <dt>Starting packs</dt>
              <dd>{league.startingPacks}</dd>
            </div>
            <div>
              <dt>Starting wildcards</dt>
              <dd>
                {(["common", "uncommon", "rare", "mythic", "discovery"] as const)
                  .map((kind) => `${league.startingWildcards?.[kind] ?? 0} ${kind === "discovery" ? "Discovery" : kind}`)
                  .join("; ")}
              </dd>
            </div>
            <div>
              <dt>Weekly packs</dt>
              <dd>{league.weeklyPacks}</dd>
            </div>
            <div>
              <dt>Wildcard rewards</dt>
              <dd>
                {(["common", "uncommon", "rare", "mythic", "discovery"] as const)
                  .map((kind) => {
                    const interval =
                      league.wildcardRewardIntervals?.[kind] ?? 1;
                    const offset = league.wildcardRewardOffsets?.[kind] ?? 0;
                    const firstWeek = interval - offset;
                    return `${league.weeklyWildcards[kind] ?? 0} ${kind === "discovery" ? "Discovery" : kind} ${interval === 1 ? "each week" : `every ${interval} weeks, first at week ${firstWeek}`}`;
                  })
                  .join("; ")}
              </dd>
            </div>
            <div>
              <dt>Crafting</dt>
              <dd>
                Matching-rarity wildcards add copies of owned cards. A Discovery
                wildcard acquires the first copy of any eligible card from an
                unlocked expansion.
              </dd>
            </div>
            <div>
              <dt>Pack contents</dt>
              <dd>{composition}</dd>
            </div>
            {league.booster.commonLandWeight != null && (
              <div>
                <dt>Nonbasic lands</dt>
                <dd>
                  Only common lands are{" "}
                  {league.booster.commonLandWeight === 0.5
                    ? "half as likely"
                    : `${Math.round(league.booster.commonLandWeight * 100)}% as likely`}{" "}
                  to be chosen as other commons. Normally at most{" "}
                  {league.booster.preferredLandLimit} land per pack, with
                  mythic, rare, then uncommon lands taking priority over common
                  lands. This limit relaxes when only missing lands remain at a
                  rarity.
                </dd>
              </div>
            )}
            <div>
              <dt>Basic lands</dt>
              <dd>Free from unlocked expansions; never included in packs.</dd>
            </div>
            <div>
              <dt>Mythic chance</dt>
              <dd>
                {Number((league.mythicProbability * 100).toFixed(2))}% of rare
                slots
              </dd>
            </div>
            <div>
              <dt>Bonus wildcard chance</dt>
              <dd>
                {Number((league.wildcardDropProbability * 100).toFixed(2))}%
              </dd>
            </div>
            <div>
              <dt>Collection limit</dt>
              <dd>4 copies across all printings; basic lands are unlimited</dd>
            </div>
            <div>
              <dt>Main deck</dt>
              <dd>At least {league.deckRestrictions.minimumMainDeck} cards</dd>
            </div>
            <div>
              <dt>Sideboard</dt>
              <dd>Up to {league.deckRestrictions.maximumSideboard} cards</dd>
            </div>
            <div>
              <dt>Deck copies</dt>
              <dd>
                Up to {league.deckRestrictions.normalCopyLimit} of each card,
                with card-specific exceptions; owned copies required
              </dd>
            </div>
            <div>
              <dt>Starting expansions</dt>
              <dd>
                {league.enabledSets.length
                  ? league.enabledSets.map(expansionName).join(", ")
                  : "None"}
              </dd>
            </div>
            <div>
              <dt>Expansion unlock reward</dt>
              <dd>
                8 extra packs reserved for the newly unlocked expansion, in
                addition to weekly rewards.
              </dd>
            </div>
          </dl>
        </div>
      </section>
      <section
        id="settings-panel-calendar"
        role="tabpanel"
        aria-labelledby="settings-tab-calendar"
        className="panel"
        hidden={repairOnly || tab !== "calendar"}
      >
        <div className="panel-body settings-stack">
          <section
            className="expansion-calendar"
            aria-label="Expansion calendar"
          >
            <div className="expansion-calendar-heading">
              <h3>Expansion calendar</h3>
              <span className="calendar-current-week">Week {currentWeek}</span>
            </div>
            <div className="calendar-position">
              <progress
                max={Math.max(calendar.length, 1)}
                value={unlockedCount}
                aria-label={`${unlockedCount} of ${calendar.length} expansions unlocked`}
              />
              <p>
                <strong>
                  {unlockedCount} of {calendar.length} unlocked
                </strong>
                {nextExpansion
                  ? `Next: ${nextExpansion.name} at week ${nextExpansion.week}`
                  : "All scheduled expansions are unlocked"}
              </p>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Week</th>
                  <th>Expansion</th>
                  <th>Theme</th>
                  <th>Extra packs</th>
                </tr>
              </thead>
              <tbody>
                {calendar.map((entry) => (
                  <tr
                    key={entry.code}
                    className={
                      entry.code === currentExpansion?.code
                        ? "calendar-current-row"
                        : ""
                    }
                    aria-current={
                      entry.code === currentExpansion?.code ? "step" : undefined
                    }
                  >
                    <td>
                      <strong>{entry.week}</strong>
                      <small>
                        {new Date(
                          (league.startedAt + entry.week * 604800) * 1000,
                        ).toLocaleDateString()}
                      </small>
                    </td>
                    <td>
                      <span className="calendar-expansion-name">
                        {entry.name}
                      </span>
                      <span
                        className={`calendar-unlock-status ${entry.week <= currentWeek ? "calendar-unlocked" : "calendar-upcoming"}`}
                      >
                        {entry.code === currentExpansion?.code
                          ? "Unlocked - current"
                          : entry.week <= currentWeek
                            ? "Unlocked"
                            : entry.code === nextExpansion?.code
                              ? "Upcoming - next"
                              : "Upcoming"}
                      </span>
                    </td>
                    <td>{entry.description}</td>
                    <td>
                      {entry.bonusPacks ? (
                        <>
                          <strong>+{entry.bonusPacks}</strong>
                          <small>For this expansion</small>
                        </>
                      ) : (
                        "Starting pool"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      </section>
    </div>
  );
}
