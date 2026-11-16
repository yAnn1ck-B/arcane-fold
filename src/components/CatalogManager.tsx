import { Database, Download, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CatalogProgress, CatalogStatus } from "@/lib/types";

export interface CatalogManagerProps {
  status: CatalogStatus;
  progress: CatalogProgress | null;
  busy: boolean;
  onImport: () => void;
}

export default function CatalogManager({
  status,
  progress,
  busy,
  onImport,
}: CatalogManagerProps) {
  const percent = progress?.total
    ? Math.min(100, Math.round((progress.processed / progress.total) * 100))
    : null;
  return (
    <section className="panel catalog-manager">
      <div className="catalog-manager-copy">
        <Database size={23} />
        <div>
          <h2>Card catalog</h2>
          <p>
            {busy
              ? (progress?.message ?? "Updating card information…")
              : status.count
                ? `${status.count.toLocaleString()} printings · Last updated ${status.updatedAt ? new Date(status.updatedAt).toLocaleString() : "unknown"}`
                : "Download Scryfall card metadata once. Browse offline; card artwork loads on demand."}
          </p>
        </div>
      </div>
      <div className="catalog-manager-actions">
        <Button
          type="button"
          variant={status.count ? "outline" : "default"}
          onClick={onImport}
          disabled={busy}
        >
          {busy ? (
            <LoaderCircle size={15} className="animate-spin" />
          ) : (
            <Download size={15} />
          )}
          {busy
            ? "Updating catalog…"
            : status.count
              ? "Refresh catalog"
              : "Download card catalog"}
        </Button>
      </div>
      {busy && (
        <div className="catalog-progress" role="status" aria-live="polite">
          <div className="progress-track">
            <div
              className={percent === null ? "progress-indeterminate" : ""}
              style={{ width: percent === null ? "30%" : `${percent}%` }}
            />
          </div>
          <span>
            {progress?.stage === "importing"
              ? `${progress.processed.toLocaleString()} printings processed. You can keep browsing.`
              : percent === null
                ? "Working in the background. You can keep browsing."
                : `${percent}%`}
          </span>
        </div>
      )}
    </section>
  );
}
