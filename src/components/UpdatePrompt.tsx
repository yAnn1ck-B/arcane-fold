import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { isTauri } from "@tauri-apps/api/core";
import { ArrowDownToLine, LoaderCircle, RefreshCw, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { updater } from "@/services/updater";
import {
  isUpdateBlocking,
  UPDATE_CHECK_INTERVAL,
} from "@/services/updater-controller";
import { appLifecycle } from "@/lib/app-lifecycle";
import "@/styles/update-prompt.css";

interface UpdatePromptProps {
  busy?: boolean;
  repairMode?: boolean;
  onReviewDeck?: () => void;
  onResumeUpdate?: () => void;
}

export default function UpdatePrompt({
  busy = false,
  repairMode = false,
  onReviewDeck,
  onResumeUpdate,
}: UpdatePromptProps) {
  const state = useSyncExternalStore(updater.subscribe, updater.getSnapshot);
  const exitState = useSyncExternalStore(
    appLifecycle.subscribe,
    appLifecycle.getSnapshot,
  );
  const dialog = useRef<HTMLDialogElement>(null);
  const enabled = !import.meta.env.DEV && isTauri();
  const blocking = enabled && isUpdateBlocking(state);

  useEffect(() => {
    if (!enabled) return;
    updater.start();
    const poll = () => {
      void updater.poll();
    };
    const verify = () => {
      void updater.check();
    };
    const visible = () => {
      if (document.visibilityState === "visible") verify();
    };
    const timer = window.setInterval(poll, UPDATE_CHECK_INTERVAL);
    window.addEventListener("focus", verify);
    window.addEventListener("online", verify);
    window.addEventListener("offline", verify);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", verify);
      window.removeEventListener("online", verify);
      window.removeEventListener("offline", verify);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [enabled]);

  useEffect(() => {
    if (!blocking || repairMode) return;
    const element = dialog.current;
    if (!element) return;
    if (!element.open) element.showModal();
    const others = () =>
      Array.from(
        document.querySelectorAll<HTMLDialogElement>("dialog[open]"),
      ).filter((item) => item !== element);
    let known = new Set(others());
    const observer = new MutationObserver((records) => {
      if (!element.isConnected) return;
      const now = others();
      const newlyOpened = records.some(
        (record) =>
          record.type === "attributes" &&
          record.target !== element &&
          record.target instanceof HTMLDialogElement &&
          record.target.open,
      );
      const inserted = now.some((item) => !known.has(item));
      known = new Set(now);
      if (!newlyOpened && !inserted) return;
      // Keep pending form dialogs intact, but put the required update above them.
      if (element.open) element.close();
      element.showModal();
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    return () => {
      observer.disconnect();
      element.close();
    };
  }, [blocking, repairMode]);

  if (!blocking) return null;
  const windows = /Windows/i.test(navigator.userAgent);
  const working =
    exitState.busy ||
    ["checking", "downloading", "installing", "restarting"].includes(
      state.phase,
    );
  const percent =
    state.totalBytes && state.totalBytes > 0
      ? Math.min(
          100,
          Math.round((state.downloadedBytes / state.totalBytes) * 100),
        )
      : null;
  const verifying = state.phase === "idle" || state.phase === "checking";
  const title = verifying
    ? "Checking your app version"
    : state.phase === "check-failed"
      ? "Version verification required"
      : state.phase === "installed" || state.phase === "restarting"
        ? "Restart required"
        : "Update required";

  function install() {
    void appLifecycle
      .run("install-update", () => updater.install())
      .catch(() => {});
  }
  function restart() {
    void appLifecycle.run("restart", () => updater.restart()).catch(() => {});
  }
  function resume() {
    onResumeUpdate?.();
    if (state.phase === "downloaded") install();
    else if (state.phase === "installed") restart();
  }

  if (repairMode) {
    return createPortal(
      <aside
        className="required-update-repair"
        aria-label="Required update deck repair"
      >
        <div>
          <strong>Update required</strong>
          <p>
            Finish saving or cancel the pending deck action, then continue the
            update.
          </p>
        </div>
        <Button disabled={busy || exitState.busy} onClick={resume}>
          {state.phase === "downloaded"
            ? windows
              ? "Save, install and restart"
              : "Save and install update"
            : state.phase === "installed"
              ? "Save and restart"
              : "Return to update"}
        </Button>
      </aside>,
      document.body,
    );
  }

  return createPortal(
    <dialog
      ref={dialog}
      className="update-prompt"
      aria-labelledby="required-update-title"
      aria-describedby="required-update-description"
      onCancel={(event) => event.preventDefault()}
    >
      <div className="update-prompt-heading">
        <h2 id="required-update-title">{title}</h2>
        {working && (
          <LoaderCircle size={21} className="spin" aria-hidden="true" />
        )}
      </div>
      <div
        id="required-update-description"
        className="update-prompt-status"
        aria-live="polite"
      >
        {verifying ? (
          <p>Verifying that this app is up to date before continuing.</p>
        ) : state.phase === "check-failed" ? (
          <p>
            Connect to the internet and try again. Version verification is
            required before using the app.
          </p>
        ) : state.phase === "downloading" ? (
          <>
            <p>
              Downloading version {state.version}
              {percent !== null ? ` - ${percent}%` : "..."}
            </p>
            <progress
              max={100}
              value={percent ?? undefined}
              aria-label="Update download"
            />
          </>
        ) : state.phase === "installing" ? (
          <p>Installing the verified update...</p>
        ) : state.phase === "restarting" ? (
          <p>Restarting with the required version...</p>
        ) : state.phase === "installed" ? (
          <p>Restart the app to finish this required update.</p>
        ) : (
          <>
            <p>
              Version {state.version} is required to continue.
              {state.currentVersion
                ? ` Current version: ${state.currentVersion}.`
                : ""}
            </p>
            <p>
              Your saved league stays in place. Pending deck changes are saved
              before installing or restarting.
            </p>
            {state.phase === "downloaded" && busy && (
              <p>
                Waiting for the current operation to finish before installing.
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
      {exitState.error && (
        <p className="update-prompt-error" role="alert">
          {exitState.error}
        </p>
      )}
      {state.notes && (
        <details className="update-prompt-notes">
          <summary>What changed</summary>
          <p>{state.notes}</p>
        </details>
      )}
      <div className="update-prompt-actions">
        {state.phase === "check-failed" && (
          <Button onClick={() => void updater.check()}>
            <RefreshCw size={15} /> Retry verification
          </Button>
        )}
        {state.phase === "available" && (
          <Button onClick={() => void updater.download()}>
            <ArrowDownToLine size={15} />{" "}
            {state.error ? "Retry download" : "Download required update"}
          </Button>
        )}
        {state.phase === "downloaded" && (
          <Button disabled={busy || exitState.busy} onClick={install}>
            {state.error || exitState.error
              ? "Retry installation"
              : windows
                ? "Install and restart"
                : "Install update"}
          </Button>
        )}
        {state.phase === "installed" && (
          <Button disabled={busy || exitState.busy} onClick={restart}>
            <RefreshCw size={15} />{" "}
            {state.error || exitState.error ? "Retry restart" : "Restart now"}
          </Button>
        )}
        {exitState.error && onReviewDeck && (
          <Button
            variant="outline"
            disabled={exitState.busy}
            onClick={onReviewDeck}
          >
            <Wrench size={15} /> Repair deck
          </Button>
        )}
      </div>
    </dialog>,
    document.body,
  );
}
