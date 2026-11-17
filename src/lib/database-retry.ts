export const DATABASE_BUSY_RETRY_DELAYS_MS = [
  250, 500, 1000, 2000, 3000,
] as const;

export interface DatabaseRetryNotice {
  /** One-based number of the failed attempt. */
  attempt: number;
  nextAttempt: number;
  delayMs: number;
  error: unknown;
}

export interface DatabaseRetryOptions {
  /** Total attempts, including the first call. Between 1 and 6; defaults to 6. */
  maxAttempts?: number;
  sleep?: (delayMs: number) => Promise<void>;
  onRetry?: (notice: DatabaseRetryNotice) => void;
}

const BUSY_CODE = /\bSQLITE_(?:BUSY|LOCKED)(?:_[A-Z0-9]+)*\b/i;
const BUSY_MESSAGE =
  /\bdatabase\s+(?:(?:table|schema)\s+)?(?:is\s+)?(?:locked|busy)\b/i;
const PERMANENT_ERROR =
  /\bSQLITE_(?:CONSTRAINT|CORRUPT|NOTADB|READONLY|PERM|AUTH)(?:_[A-Z0-9]+)*\b|\b(?:EACCES|EPERM|PermissionDenied|AccessDenied)\b|\baccess\s+(?:is\s+)?denied\b|\bpermission\s+denied\b|\boperation\s+not\s+permitted\b|\bnot\s+authori[sz]ed\b|\b(?:read[ -]?only|readonly)\s+database\b|\bconstraint\s+(?:failed|violation)\b|\bchecksum\b|\bmigration\b[^\r\n]*(?:modified|mismatch|corrupt)|\bdatabase\s+(?:disk\s+image\s+is\s+malformed|corruption|is\s+corrupt)\b|\bfile\s+is\s+not\s+a\s+database\b/i;

const ERROR_FIELDS = [
  "message",
  "msg",
  "code",
  "extendedCode",
  "errorCode",
  "cause",
  "error",
  "errors",
  "inner",
  "source",
  "Database",
  "database",
  "SqliteError",
  "SqliteFailure",
  "Sqlite",
  "sqlite",
  "Sqlx",
  "SqlxError",
] as const;

/** Recognize SQLite contention, never a bare numeric code such as Windows error 5. */
export function isDatabaseBusy(error: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value: error, depth: 0 },
  ];
  const seen = new Set<object>();
  let busy = false;
  let incomplete = false;
  // Driver errors can be nested or JSON-serialized. Bound traversal and avoid
  // arbitrary SQL/query fields or user-defined object stringification.
  for (let visited = 0; pending.length && visited < 64; visited++) {
    const { value, depth } = pending.shift()!;
    if (typeof value === "string") {
      const text = value.slice(0, 16_000);
      incomplete ||= value.length > text.length;
      if (depth < 5 && /^[\s]*[\[{]/.test(text)) {
        try {
          pending.push({ value: JSON.parse(text), depth: depth + 1 });
          continue;
        } catch {
          // Plain native driver messages are not necessarily JSON.
        }
      }
      if (PERMANENT_ERROR.test(text)) return false;
      busy ||= BUSY_CODE.test(text) || BUSY_MESSAGE.test(text);
    } else if (value && typeof value === "object" && !seen.has(value)) {
      if (depth >= 5) {
        incomplete = true;
        continue;
      }
      seen.add(value);
      if (Array.isArray(value)) {
        incomplete ||= value.length > 16;
        pending.push(
          ...value
            .slice(0, 16)
            .map((entry) => ({ value: entry, depth: depth + 1 })),
        );
      } else {
        for (const field of ERROR_FIELDS) {
          try {
            const child = (value as Record<string, unknown>)[field];
            if (child !== undefined)
              pending.push({ value: child, depth: depth + 1 });
          } catch {
            incomplete = true;
          }
        }
      }
    }
  }
  // If a wrapper could hide a permanent failure beyond our inspection bounds,
  // fail closed rather than retrying only its visible busy-looking prefix.
  return busy && !incomplete && pending.length === 0;
}

const sleep = (delayMs: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, delayMs));

/**
 * Retry idempotent startup work only. Never wrap pack/craft/deck mutations.
 * The default adds at most 6.75 seconds of backoff; each action must settle
 * before another attempt starts. Driver/action timeouts remain the caller's.
 */
export async function retryDatabaseBusy<T>(
  action: () => Promise<T>,
  options: DatabaseRetryOptions = {},
): Promise<T> {
  const maxAttempts =
    options.maxAttempts ?? DATABASE_BUSY_RETRY_DELAYS_MS.length + 1;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 6) {
    throw new RangeError(
      "Database retry maxAttempts must be an integer from 1 to 6.",
    );
  }
  const wait = options.sleep ?? sleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      if (attempt >= maxAttempts || !isDatabaseBusy(error)) throw error;
      const delayMs = DATABASE_BUSY_RETRY_DELAYS_MS[attempt - 1];
      options.onRetry?.({ attempt, nextAttempt: attempt + 1, delayMs, error });
      await wait(delayMs);
    }
  }
}
