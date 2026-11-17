import { useEffect, useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { ArrowDownToLine, LoaderCircle, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { updater } from "@/services/updater";
import { UPDATE_CHECK_INTERVAL } from "@/services/updater-controller";
import { appLifecycle } from "@/lib/app-lifecycle";
import "@/styles/update-prompt.css";

export default function UpdatePrompt({ busy = false }: { busy?: boolean }) {
  const state = useSyncExternalStore(updater.subscribe, updater.getSnapshot);
  const exitState = useSyncExternalStore(
    appLifecycle.subscribe,
    appLifecycle.getSnapshot,
  );
  useEffect(() => {
    // Development and preview profiles must never install the production app.
    if (import.meta.env.DEV || !isTauri()) return;
    updater.start();
    const timer = window.setInterval(
      () => void updater.poll(),
      UPDATE_CHECK_INTERVAL,
    );
    return () => window.clearInterval(timer);
  }, []);

  if (
    import.meta.env.DEV ||
    !isTauri() ||
    ["idle", "checking", "current", "dismissed"].includes(state.phase)
  )
    return null;
  const working =
    exitState.busy ||
    ["downloading", "installing", "restarting"].includes(state.phase);
  const windows = /Windows/i.test(navigator.userAgent);
  const percent =
    state.totalBytes && state.totalBytes > 0
      ? Math.min(
          100,
          Math.round((state.downloadedBytes / state.totalBytes) * 100),
        )
      : null;
  const title =
    state.phase === "check-failed"
      ? "Update check unavailable"
      : state.phase === "installed" || state.phase === "restarting"
        ? "Update installed"
        : `Eternal League ${state.version} is available`;

  return (
    <aside className="update-prompt panel" aria-label="Application update">
      <div className="update-prompt-heading">
        <strong>{title}</strong>
        {!working && (
          <Button
            size="icon"
            variant="ghost"
            onClick={() => void updater.dismiss()}
            aria-label="Dismiss update notice"
          >
            <X size={16} />
          </Button>
        )}
      </div>
      <div className="update-prompt-status" aria-live="polite">
        {state.phase === "check-failed" ? (
          <p>
            Your league is ready to use. Try checking for updates again when you
            are online.
          </p>
        ) : state.phase === "downloading" ? (
          <>
            <p>Downloading update{percent !== null ? ` · ${percent}%` : "…"}</p>
            <progress
              max={100}
              value={percent ?? undefined}
              aria-label="Update download"
            />
          </>
        ) : state.phase === "installing" ? (
          <p>Installing the signed update…</p>
        ) : state.phase === "restarting" ? (
          <p>Restarting Eternal League…</p>
        ) : state.phase === "installed" ? (
          <p>Restart when you are ready to use the new version.</p>
        ) : (
          <>
            <p>
              Current version: {state.currentVersion}. Your saved league data
              stays in place.
            </p>
            {state.phase === "downloaded" && (
              <p>
                {busy
                  ? "Finish the current operation before installing."
                  : windows
                    ? "Pending deck changes are saved before installation closes and restarts the app."
                    : "Pending deck changes are saved before installing or restarting."}
              </p>
            )}
          </>
        )}
      </div>
      {state.error && (
        <p className="update-prompt-error" role="alert">
          {state.error}
        </p>
      )}
      {state.notes && (
        <details className="update-prompt-notes">
          <summary>What’s new</summary>
          <p>{state.notes}</p>
        </details>
      )}
      <div className="update-prompt-actions">
        {state.phase === "check-failed" && (
          <Button size="sm" onClick={() => void updater.check()}>
            <RefreshCw size={14} /> Try again
          </Button>
        )}
        {state.phase === "available" && (
          <Button size="sm" onClick={() => void updater.download()}>
            <ArrowDownToLine size={14} />{" "}
            {state.error ? "Retry download" : "Download update"}
          </Button>
        )}
        {state.phase === "downloaded" && (
          <Button
            size="sm"
            disabled={busy || exitState.busy}
            onClick={() =>
              void appLifecycle
                .run("install-update", () => updater.install())
                .catch(() => {})
            }
          >
            {state.error
              ? "Retry installation"
              : windows
                ? "Install and restart"
                : "Install update"}
          </Button>
        )}
        {state.phase === "installed" && (
          <Button
            size="sm"
            disabled={busy || exitState.busy}
            onClick={() =>
              void appLifecycle
                .run("restart", () => updater.restart())
                .catch(() => {})
            }
          >
            <RefreshCw size={14} /> Restart now
          </Button>
        )}
        {working && (
          <LoaderCircle size={17} className="spin" aria-hidden="true" />
        )}
        {!working && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void updater.dismiss()}
          >
            Later
          </Button>
        )}
      </div>
    </aside>
  );
}
