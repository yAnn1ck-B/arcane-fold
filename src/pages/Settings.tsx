import { useEffect, useState, type FormEvent } from "react";
import {
  CheckCircle2,
  FolderOpen,
  Loader2,
  Save,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { listSets } from "@/services/cards";
import { chooseDirectory, testForgeIntegration } from "@/services/forge";
import type {
  AppSettings,
  CatalogSet,
  ForgePaths,
  IntegrationReport,
} from "@/lib/types";

interface SettingsProps {
  settings: AppSettings;
  onSave: (settings: AppSettings) => Promise<void>;
  onReport: (report: IntegrationReport) => void;
  report: IntegrationReport | null;
  catalogCount?: number;
}

type SettingsTab = "forge" | "league";
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
  onReport,
  report,
  catalogCount = 0,
}: SettingsProps) {
  const [tab, setTab] = useState<SettingsTab>("forge");
  const [draft, setDraft] = useState(settings);
  const [sets, setSets] = useState<CatalogSet[]>([]);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draftReport, setDraftReport] = useState<{
    key: string;
    report: IntegrationReport;
  } | null>(null);
  const [notice, setNotice] = useState<{
    error: boolean;
    message: string;
  } | null>(null);
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
      setNotice({ error: true, message: String(error) });
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
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
      onReport(checked);
      setNotice({ error: false, message: "Forge folders saved." });
    } catch (error) {
      setNotice({ error: true, message: String(error) });
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
  const composition = [
    [league.booster.commons, "commons"],
    [league.booster.uncommons, "uncommons"],
    [league.booster.rareSlots, "rare or mythic"],
    [league.booster.basicLands, "basic lands"],
  ]
    .filter(([quantity]) => Number(quantity) > 0)
    .map(([quantity, label]) => `${quantity} ${label}`)
    .join(" · ");
  return (
    <div className="settings-page">
      <div
        className="settings-tabs"
        role="tablist"
        aria-label="Settings sections"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "forge"}
          className={`settings-tab ${tab === "forge" ? "active" : ""}`}
          onClick={() => setTab("forge")}
        >
          <FolderOpen size={16} /> Forge folders
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "league"}
          className={`settings-tab ${tab === "league" ? "active" : ""}`}
          onClick={() => setTab("league")}
        >
          <Sparkles size={16} /> League rules
        </button>
      </div>
      {notice && (
        <div
          className={`notice ${notice.error ? "notice-error" : "notice-success"}`}
          role={notice.error ? "alert" : "status"}
        >
          {notice.error ? (
            <TriangleAlert size={18} />
          ) : (
            <CheckCircle2 size={18} />
          )}
          <span>{notice.message}</span>
        </div>
      )}
      <form onSubmit={save} hidden={tab !== "forge"}>
        <section className="panel">
          <div className="panel-body settings-stack forge-paths-body">
            {pathFields.map(({ key, label, hint }) => (
              <div className="field" key={key}>
                <Label htmlFor={`forge-${key}`}>{label}</Label>
                <div className="path-input-row">
                  <Input
                    id={`forge-${key}`}
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
            <Button type="submit" disabled={!dirty || saving}>
              {saving ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <Save size={15} />
              )}{" "}
              Save folders
            </Button>
          </div>
        </section>
      </form>
      <section className="panel" hidden={tab !== "league"}>
        <div className="panel-header">
          <h2 className="section-title">Shared league rules</h2>
        </div>
        <div className="panel-body settings-stack">
          <p className="field-hint">
            These rules come with the app and are the same for everyone. New
            players receive all starting and weekly rewards earned since this
            league began.
          </p>
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
              <dt>Weekly packs</dt>
              <dd>{league.weeklyPacks}</dd>
            </div>
            <div>
              <dt>Wildcard rewards</dt>
              <dd>
                {(["common", "uncommon", "rare", "mythic"] as const)
                  .map((rarity) => {
                    const interval =
                      league.wildcardRewardIntervals?.[rarity] ?? 1;
                    return `${league.weeklyWildcards[rarity]} ${rarity} ${interval === 1 ? "each week" : `every ${interval} weeks`}`;
                  })
                  .join("; ")}
              </dd>
            </div>
            <div>
              <dt>Pack contents</dt>
              <dd>{composition}</dd>
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
          <section
            className="expansion-calendar"
            aria-label="Expansion calendar"
          >
            <h3>Expansion calendar</h3>
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
                {league.expansionSchedule.map((entry) => (
                  <tr key={entry.code}>
                    <td>
                      <strong>{entry.week}</strong>
                      <small>
                        {new Date(
                          (league.startedAt + entry.week * 604800) * 1000,
                        ).toLocaleDateString()}
                      </small>
                    </td>
                    <td>{entry.name}</td>
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
