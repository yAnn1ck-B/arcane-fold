import type { DeckDetail, DeckDraft } from "./types";

export type DeckSavePhase = "idle" | "queued" | "saving" | "unnamed" | "error";
export interface DeckSaveState {
  phase: DeckSavePhase;
  pending: boolean;
  error: string | null;
}
export interface DeckSaveAcknowledgement {
  deck: DeckDetail;
  current: boolean;
  session: number;
  revision: number;
}

/** Retain each logical Add target's original contents until that request settles. */
export class CollectionAddBases<T> {
  private readonly bases = new Map<string, T>();

  get(requestId: string, targetId: string): T | undefined {
    return this.bases.get(JSON.stringify([requestId, targetId]));
  }

  capture(requestId: string, targetId: string, base: T): T {
    const key = JSON.stringify([requestId, targetId]);
    if (!this.bases.has(key)) this.bases.set(key, structuredClone(base));
    return this.bases.get(key)!;
  }

  clear(): void {
    this.bases.clear();
  }
}

function copyDraft(draft: DeckDraft): DeckDraft {
  return { ...draft, cards: draft.cards.map((card) => ({ ...card })) };
}
function fingerprint(draft: DeckDraft): string {
  return JSON.stringify({
    name: draft.name,
    cards: [...draft.cards].sort((a, b) =>
      `${a.section}:${a.cardId}`.localeCompare(`${b.section}:${b.cardId}`),
    ),
  });
}

/** One logical editor, one save at a time, with the latest full draft queued. */
export class DeckAutosave {
  private draft: DeckDraft = { id: null, name: "", cards: [] };
  private session = 0;
  private revision = 0;
  private savedRevision = 0;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private error: string | null = null;
  private suspended = false;
  private createRequestId = crypto.randomUUID();

  constructor(
    private readonly save: (draft: DeckDraft, createRequestId?: string) => Promise<DeckDetail>,
    private readonly onState: (state: DeckSaveState) => void,
    private readonly onSaved: (ack: DeckSaveAcknowledgement) => void,
    private readonly debounceMs = 160,
  ) {}

  getDraft(): DeckDraft {
    return copyDraft(this.draft);
  }

  reset(draft: DeckDraft): void {
    this.clearTimer();
    this.session++;
    this.createRequestId = crypto.randomUUID();
    this.draft = copyDraft(draft);
    this.revision = 0;
    this.savedRevision = 0;
    this.error = null;
    this.suspended = false;
    this.publish();
  }

  edit(draft: DeckDraft, force = false): boolean {
    const next = copyDraft({ ...draft, id: this.draft.id ?? draft.id });
    if (!force && fingerprint(next) === fingerprint(this.draft)) return false;
    this.draft = next;
    this.revision++;
    this.error = null;
    this.schedule();
    return true;
  }

  async flush(): Promise<void> {
    this.clearTimer();
    if (this.suspended) throw new Error("A deck action is already in progress.");
    // An explicit flush retries once. A failed drain never schedules its own retry.
    this.error = null;
    while (this.revision > this.savedRevision) {
      if (this.suspended) throw new Error("A deck action is already in progress.");
      if (!this.draft.name.trim()) {
        this.publish();
        throw new Error("Name this deck before continuing.");
      }
      if (!this.running) this.start();
      await this.running;
      if (this.error) throw new Error(this.error);
    }
    this.publish();
  }

  /** Stop buffered writes and wait for any active write before deleting this deck. */
  async suspend(): Promise<void> {
    this.suspended = true;
    this.clearTimer();
    await this.running?.catch(() => {});
  }

  resume(): void {
    this.suspended = false;
    if (!this.error) this.schedule();
    else this.publish();
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    this.clearTimer();
    this.publish();
    if (
      this.suspended || this.running || this.error ||
      this.revision === this.savedRevision || !this.draft.name.trim()
    ) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.start();
      void this.running?.catch(() => {});
    }, this.debounceMs);
  }

  private start(): void {
    const session = this.session;
    const work = this.drain(session);
    this.running = work;
    void work.finally(() => {
      if (this.running === work) this.running = null;
      if (!this.suspended && !this.error && this.revision > this.savedRevision)
        this.schedule();
      else this.publish();
    }).catch(() => {});
  }

  private async drain(session: number): Promise<void> {
    while (
      session === this.session && !this.suspended &&
      this.revision > this.savedRevision
    ) {
      const revision = this.revision;
      const snapshot = copyDraft(this.draft);
      this.publish("saving");
      let deck: DeckDetail;
      try {
        deck = await this.save(snapshot, snapshot.id ? undefined : this.createRequestId);
      } catch (error) {
        if (session !== this.session) return;
        this.error = error instanceof Error ? error.message : String(error);
        this.publish();
        throw error;
      }
      if (session !== this.session) return;
      // Only identity is adopted from an old response. Later edits stay authoritative.
      this.draft.id = deck.id;
      this.savedRevision = revision;
      this.onSaved({ deck, current: revision === this.revision, session, revision });
    }
  }

  private publish(phase?: DeckSavePhase): void {
    const pending = this.revision > this.savedRevision;
    this.onState({
      pending,
      error: this.error,
      phase: this.error ? "error" :
        pending && !this.draft.name.trim() ? "unnamed" :
        phase ?? (this.running ? "saving" : pending ? "queued" : "idle"),
    });
  }
}
