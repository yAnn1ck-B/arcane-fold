import { useEffect, useRef, useState } from "react";
import {
  Archive,
  Download,
  HardDrive,
  LoaderCircle,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { clearCardImageMemoryCache } from "@/services/cards";
import {
  backupDatabase,
  chooseBackupDestination,
  chooseBackupSource,
  clearImageCache,
  databaseInfo,
  restoreDatabase,
  type DatabaseInfo,
} from "@/services/maintenance";

type PendingAction = { kind: "restore"; source: string } | { kind: "clear" };

function bytesLabel(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}

export default function ApplicationData({ disabled }: { disabled: boolean }) {
  const [info, setInfo] = useState<DatabaseInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    error: boolean;
    message: string;
  } | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [dialogError, setDialogError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const actionRunning = useRef(false);

  useEffect(() => {
    void databaseInfo()
      .then(setInfo)
      .catch((error: unknown) =>
        setNotice({ error: true, message: String(error) }),
      );
  }, []);
  useEffect(() => {
    if (pending) {
      setConfirmation("");
      setDialogError(null);
      dialog.current?.showModal();
    }
  }, [pending]);

  async function backup() {
    if (disabled || actionRunning.current) return;
    actionRunning.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const destination = await chooseBackupDestination();
      if (!destination) return;
      const result = await backupDatabase(destination);
      setNotice({
        error: false,
        message: `Backup saved: ${result.path} (${bytesLabel(result.bytes)}).`,
      });
    } catch (error) {
      setNotice({ error: true, message: String(error) });
    } finally {
      actionRunning.current = false;
      setBusy(false);
    }
  }

  async function chooseRestore() {
    if (disabled || actionRunning.current) return;
    actionRunning.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const source = await chooseBackupSource();
      if (source) setPending({ kind: "restore", source });
    } catch (error) {
      setNotice({ error: true, message: String(error) });
    } finally {
      actionRunning.current = false;
      setBusy(false);
    }
  }

  const phrase = pending?.kind === "restore" ? "RESTORE" : "CLEAR IMAGE CACHE";
  async function confirm() {
    if (
      !pending ||
      confirmation !== phrase ||
      disabled ||
      actionRunning.current
    )
      return;
    actionRunning.current = true;
    setBusy(true);
    setDialogError(null);
    try {
      if (pending.kind === "clear") {
        const result = await clearImageCache();
        clearCardImageMemoryCache();
        setNotice({
          error: false,
          message: `${result.filesRemoved} downloaded image files removed (${bytesLabel(result.bytesRemoved)}). Your Forge cache is preserved.`,
        });
        setPending(null);
      } else {
        const result = await restoreDatabase(pending.source);
        const message = `Backup restored. Safety backup: ${result.backupPath}`;
        try {
          localStorage.removeItem("eternal-league.pending-booster-opening");
        } catch {
          /* Storage is optional. */
        }
        try {
          sessionStorage.setItem("eternal-league.maintenance-notice", message);
        } catch {
          /* Reload still opens the restored saved state. */
        }
        window.location.reload();
      }
    } catch (error) {
      setDialogError(String(error));
    } finally {
      actionRunning.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="panel application-data-panel">
      <div className="panel-header">
        <div>
          <h2 className="section-title">Keep your collection safe</h2>
          <p className="field-hint">
            Optional tools for recovering progress, moving your league, and
            managing downloaded artwork.
          </p>
        </div>
        <HardDrive size={20} className="muted-icon" />
      </div>
      <div className="panel-body settings-stack">
        {notice && (
          <div
            className={`notice ${notice.error ? "notice-error" : "notice-success"}`}
            role={notice.error ? "alert" : "status"}
          >
            {notice.message}
          </div>
        )}
        {info && (
          <div className="data-location">
            <span>Database · {bytesLabel(info.sizeBytes)}</span>
            <code>{info.databasePath}</code>
          </div>
        )}
        {disabled && (
          <p className="settings-note">
            Finish the catalog import and save your settings before managing
            application data.
          </p>
        )}
        <div className="maintenance-action">
          <Archive size={21} />
          <div>
            <h3>Database backup</h3>
            <p>
              Save a recovery copy of your collection, decks, rewards, and
              settings, or move your league to another PC.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={disabled || busy}
            onClick={() => void backup()}
          >
            {busy ? (
              <LoaderCircle size={15} className="animate-spin" />
            ) : (
              <Download size={15} />
            )}{" "}
            Back up database
          </Button>
        </div>
        <div className="maintenance-action">
          <Upload size={21} />
          <div>
            <h3>Restore a backup</h3>
            <p>
              Replaces saved app data after checking the backup. A safety copy
              of current data is created first.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={disabled || busy}
            onClick={() => void chooseRestore()}
          >
            Restore backup
          </Button>
        </div>
        <div className="maintenance-action">
          <Trash2 size={21} />
          <div>
            <h3>Downloaded artwork</h3>
            <p>
              Fix artwork problems or free disk space by clearing downloaded
              images. Artwork downloads again when needed; Forge’s cache is
              preserved.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={disabled || busy}
            onClick={() => setPending({ kind: "clear" })}
          >
            Clear image cache
          </Button>
        </div>
      </div>
      {pending && (
        <dialog
          ref={dialog}
          className="maintenance-dialog"
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (!busy && confirmation === phrase) void confirm();
            }
          }}
          onCancel={(event) => {
            if (busy) event.preventDefault();
            else setPending(null);
          }}
          aria-label={
            pending.kind === "restore"
              ? "Confirm database restore"
              : "Confirm cache cleanup"
          }
        >
          <div className="maintenance-dialog-heading">
            <h2>
              {pending.kind === "restore"
                ? "Restore this backup?"
                : "Clear downloaded artwork?"}
            </h2>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Cancel maintenance"
              disabled={busy}
              onClick={() => setPending(null)}
            >
              <X size={19} />
            </Button>
          </div>
          <p>
            {pending.kind === "restore"
              ? "Saved collection, decks, rewards, and settings will be replaced. Your current database will be backed up before the restore."
              : "Only the companion app’s image cache will be cleared. Existing Forge images are preserved."}
          </p>
          {pending.kind === "restore" && (
            <code className="restore-source">{pending.source}</code>
          )}
          {dialogError && (
            <div className="notice notice-error" role="alert">
              {dialogError}
            </div>
          )}
          <Label htmlFor="maintenance-confirmation">
            Type {phrase} to continue
          </Label>
          <Input
            id="maintenance-confirmation"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
          />
          <div className="maintenance-dialog-actions">
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => setPending(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy || confirmation !== phrase || disabled}
              onClick={() => void confirm()}
            >
              {busy && <LoaderCircle size={15} className="animate-spin" />}
              {pending.kind === "restore"
                ? "Restore database"
                : "Clear downloaded images"}
            </Button>
          </div>
        </dialog>
      )}
    </section>
  );
}
