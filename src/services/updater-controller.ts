export type UpdatePhase =
  | "idle"
  | "checking"
  | "current"
  | "check-failed"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "installed"
  | "restarting";

export type UpdateProgress =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

export interface UpdateHandle {
  version: string;
  currentVersion: string;
  body?: string;
  download: (progress: (event: UpdateProgress) => void) => Promise<void>;
  install: () => Promise<void>;
  close: () => Promise<void>;
}

export interface UpdateState {
  phase: UpdatePhase;
  version: string;
  currentVersion: string;
  notes: string;
  error: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
}

export interface UpdateAdapter {
  check: () => Promise<UpdateHandle | null>;
  relaunch: () => Promise<void>;
}

export const UPDATE_CHECK_INTERVAL = 5 * 60 * 1000;

// Only a completed check proving this build current unlocks normal app use.
// Routine rechecks retain that verified state until their result is known.
// A known update stays mandatory through every download/install/restart retry.
export function isUpdateBlocking(state: UpdateState | UpdatePhase): boolean {
  return (typeof state === "string" ? state : state.phase) !== "current";
}

const initialState: UpdateState = {
  phase: "idle",
  version: "",
  currentVersion: "",
  notes: "",
  error: null,
  downloadedBytes: 0,
  totalBytes: null,
};

function errorMessage(error: unknown) {
  return String(error).slice(0, 600);
}

// A single controller survives React's development remount and owns the native
// resources. Checks never download, install, or restart the application.
export class UpdateController {
  private state: UpdateState = initialState;
  private update: UpdateHandle | null = null;
  private started = false;
  private checking = false;
  private nextCheckAt = 0;
  private downloadAttempt = 0;
  private listeners = new Set<() => void>();
  private adapter: UpdateAdapter;
  private now: () => number;

  constructor(adapter: UpdateAdapter, now: () => number = Date.now) {
    this.adapter = adapter;
    this.now = now;
  }

  getSnapshot = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private setState(changes: Partial<UpdateState>) {
    this.state = { ...this.state, ...changes };
    for (const listener of this.listeners) listener();
  }

  start() {
    if (this.started) return;
    this.started = true;
    void this.check();
  }

  async check() {
    if (this.checking || !["idle", "current", "check-failed"].includes(this.state.phase)) return;
    this.checking = true;
    const background = this.state.phase === "current";
    this.nextCheckAt = this.now() + UPDATE_CHECK_INTERVAL;
    const previous = this.update;
    this.update = null;
    // Keep a verified session usable while a routine check is in flight. A
    // failed check or discovered update still blocks as soon as it resolves.
    if (!background) this.setState({ ...initialState, phase: "checking" });
    await previous?.close().catch(() => {});
    try {
      const update = await this.adapter.check();
      this.update = update;
      this.setState(update ? {
        phase: "available",
        version: update.version,
        currentVersion: update.currentVersion,
        notes: update.body?.slice(0, 12_000) ?? "",
      } : { phase: "current" });
    } catch (error) {
      this.setState({ phase: "check-failed", error: errorMessage(error) });
    } finally {
      this.checking = false;
    }
  }

  async poll() {
    if (this.now() < this.nextCheckAt) return;
    await this.check();
  }

  async download() {
    const update = this.update;
    if (this.state.phase !== "available" || !update) return;
    const attempt = ++this.downloadAttempt;
    this.setState({ phase: "downloading", error: null, downloadedBytes: 0, totalBytes: null });
    try {
      await update.download((event) => {
        if (attempt !== this.downloadAttempt || this.state.phase !== "downloading") return;
        if (event.event === "Started") {
          this.setState({ totalBytes: event.data.contentLength ?? null });
        } else if (event.event === "Progress") {
          this.setState({ downloadedBytes: this.state.downloadedBytes + event.data.chunkLength });
        }
      });
      // Tauri verifies the artifact signature before download() resolves.
      this.setState({ phase: "downloaded" });
    } catch (error) {
      this.setState({ phase: "available", error: errorMessage(error) });
    }
  }

  async install() {
    if (this.state.phase !== "downloaded" || !this.update) return;
    this.setState({ phase: "installing", error: null });
    try {
      await this.update.install();
      this.setState({ phase: "installed" });
    } catch (error) {
      this.setState({ phase: "downloaded", error: errorMessage(error) });
    }
  }

  async restart() {
    if (this.state.phase !== "installed") return;
    this.setState({ phase: "restarting", error: null });
    try {
      await this.adapter.relaunch();
    } catch (error) {
      this.setState({ phase: "installed", error: errorMessage(error) });
    }
  }

}
