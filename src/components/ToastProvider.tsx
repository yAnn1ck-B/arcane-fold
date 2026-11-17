import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, X } from "lucide-react";
import "@/styles/toasts.css";

interface ToastMessage {
  id: number;
  message: string;
}

interface ToastLifetime {
  remaining: number;
  startedAt: number;
  timer: number | undefined;
}

let sequence = 0;
let messages: ToastMessage[] = [];
// Portal container changes remount ToastItem; its clock must survive that move.
const lifetimes = new Map<number, ToastLifetime>();
const listeners = new Set<() => void>();
const snapshot = () => messages;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
function forgetLifetime(id: number) {
  const lifetime = lifetimes.get(id);
  if (lifetime?.timer !== undefined) window.clearTimeout(lifetime.timer);
  lifetimes.delete(id);
}
function dismiss(id: number) {
  forgetLifetime(id);
  messages = messages.filter((item) => item.id !== id);
  listeners.forEach((listener) => listener());
}
function pauseLifetime(id: number) {
  const lifetime = lifetimes.get(id);
  if (!lifetime || lifetime.timer === undefined) return;
  window.clearTimeout(lifetime.timer);
  lifetime.timer = undefined;
  lifetime.remaining = Math.max(
    0,
    lifetime.remaining - (Date.now() - lifetime.startedAt),
  );
}
function resumeLifetime(id: number) {
  const lifetime = lifetimes.get(id);
  if (!lifetime || lifetime.timer !== undefined) return;
  lifetime.startedAt = Date.now();
  lifetime.timer = window.setTimeout(() => dismiss(id), lifetime.remaining);
}
function toast(message: string) {
  const id = ++sequence;
  lifetimes.set(id, { remaining: 5000, startedAt: 0, timer: undefined });
  const next = [...messages, { id, message }];
  for (const evicted of next.slice(0, -3)) forgetLifetime(evicted.id);
  messages = next.slice(-3);
  listeners.forEach((listener) => listener());
}

/** Success feedback is independent of page navigation and modal lifetimes. */
export function useToast() {
  return toast;
}

function ToastItem({ item }: { item: ToastMessage }) {
  const hovered = useRef(false);
  const focused = useRef(false);
  const pause = useCallback(() => pauseLifetime(item.id), [item.id]);
  const resume = useCallback(() => {
    if (hovered.current || focused.current) return;
    resumeLifetime(item.id);
  }, [item.id]);
  useEffect(() => {
    resume();
    return pause;
  }, [pause, resume]);
  return (
    <div
      className="app-toast"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      onMouseEnter={() => {
        hovered.current = true;
        pause();
      }}
      onMouseLeave={() => {
        hovered.current = false;
        resume();
      }}
      onFocusCapture={() => {
        focused.current = true;
        pause();
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          focused.current = false;
          resume();
        }
      }}
    >
      <CheckCircle2 size={19} className="app-toast-icon" aria-hidden="true" />
      <span>{item.message}</span>
      <button
        type="button"
        onClick={() => dismiss(item.id)}
        aria-label="Dismiss notification"
      >
        <X size={17} aria-hidden="true" />
      </button>
    </div>
  );
}

export default function ToastProvider() {
  const items = useSyncExternalStore(subscribe, snapshot);
  const [host, setHost] = useState<Element>(() => document.body);
  useEffect(() => {
    const updateHost = () => {
      // Native modal dialogs occupy the browser's top layer. Render inside the
      // foremost modal so its inert backdrop cannot obscure or disable feedback.
      const dialogs = Array.from(
        document.querySelectorAll<HTMLDialogElement>("dialog[open]"),
      );
      const next = dialogs.at(-1) ?? document.body;
      setHost((current) => (current === next ? current : next));
    };
    updateHost();
    const observer = new MutationObserver(updateHost);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    return () => observer.disconnect();
  }, []);
  return createPortal(
    <div className="app-toasts" role="region" aria-label="Notifications">
      {items.map((item) => (
        <ToastItem key={item.id} item={item} />
      ))}
    </div>,
    host,
  );
}
