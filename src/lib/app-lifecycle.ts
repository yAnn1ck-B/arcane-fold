export type ExitIntent = "close" | "install-update" | "restart";
export interface ExitState {
  busy: boolean;
  error: string | null;
  intent: ExitIntent | null;
}

type ExitPreparation = () => Promise<void>;
type ExitAction = () => Promise<void>;

/** Freeze edits, finish registered work, then perform exactly one exit action. */
export class AppLifecycle {
  private readonly preparations = new Set<ExitPreparation>();
  private readonly listeners = new Set<() => void>();
  private state: ExitState = { busy: false, error: null, intent: null };
  private operation: Promise<void> | null = null;
  private prepared = false;
  private retryAction: { intent: ExitIntent; action: ExitAction } | null = null;

  readonly getSnapshot = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  register(prepare: ExitPreparation): () => void {
    this.preparations.add(prepare);
    return () => {
      this.preparations.delete(prepare);
    };
  }

  isLocked(): boolean {
    return this.state.busy;
  }
  canExit(): boolean {
    return this.state.busy && this.prepared;
  }

  run(intent: ExitIntent, action: ExitAction): Promise<void> {
    if (this.operation) return this.operation;
    this.retryAction = { intent, action };
    this.prepared = false;
    this.publish({ busy: true, error: null, intent });
    const work = Promise.resolve().then(() => this.perform(intent, action));
    this.operation = work;
    const clear = () => {
      if (this.operation === work) this.operation = null;
    };
    void work.then(clear, clear);
    return work;
  }

  retry(): Promise<void> {
    const next = this.retryAction;
    return next ? this.run(next.intent, next.action) : Promise.resolve();
  }

  private async perform(intent: ExitIntent, action: ExitAction): Promise<void> {
    try {
      for (const prepare of this.preparations) await prepare();
      this.prepared = true;
      await action();
      this.retryAction = null;
      this.publish({ busy: false, error: null, intent: null });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.publish({
        busy: false,
        error: `The app is staying open. Finish or cancel the pending deck action, then try again. ${detail}`,
        intent,
      });
      throw error;
    } finally {
      this.prepared = false;
    }
  }

  private publish(state: ExitState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
}

export interface CloseEvent {
  preventDefault(): void;
}
export interface CloseTarget {
  onCloseRequested(
    handler: (event: CloseEvent) => void | Promise<void>,
  ): Promise<() => void>;
  destroy(): Promise<void>;
}

/** Registration can finish after StrictMode/HMR cleanup; always release it. */
export function protectWindowClose(
  target: CloseTarget,
  lifecycle: AppLifecycle,
) {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  const ready = (async () => {
    const release = await target.onCloseRequested(async (event) => {
      if (
        !disposed &&
        lifecycle.canExit() &&
        lifecycle.getSnapshot().intent !== "close"
      )
        return;
      event.preventDefault();
      if (disposed || lifecycle.isLocked()) return;
      try {
        await lifecycle.run("close", () => target.destroy());
      } catch {
        // The lifecycle error stays visible; a failed save must never destroy.
      }
    });
    if (disposed) release();
    else unlisten = release;
  })();
  return {
    ready,
    dispose() {
      disposed = true;
      try {
        unlisten?.();
      } catch {
        /* Already-removed native listener. */
      }
      unlisten = undefined;
    },
  };
}

export const appLifecycle = new AppLifecycle();
