import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { GameIssueButton } from "./GameIssueButton";

/** Native modal keeps focus and keyboard navigation in the open zone. */
export function TableDialog({
  title,
  label = title,
  subtitle,
  closeLabel = "Close",
  onClose,
  className = "",
  reportable = true,
  children,
}: {
  title: string;
  label?: string;
  subtitle?: string;
  closeLabel?: string;
  onClose?: () => void;
  className?: string;
  reportable?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (opener instanceof HTMLElement && opener.isConnected)
        opener.focus({ preventScroll: true });
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={`pt-card-dialog pt-zone-dialog ${className}`}
      aria-label={label === title ? undefined : label}
      aria-labelledby={label === title ? titleId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        onClose?.();
      }}
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        const box = e.currentTarget.getBoundingClientRect();
        if (
          e.clientX < box.left ||
          e.clientX >= box.right ||
          e.clientY < box.top ||
          e.clientY >= box.bottom
        )
          onClose?.();
      }}
    >
      <header className="pt-pile-heading">
        <div>
          {subtitle && <small>{subtitle}</small>}
          <h2
            id={titleId}
            tabIndex={onClose ? undefined : -1}
            autoFocus={!onClose}
          >
            {title}
          </h2>
        </div>
        <div className="pt-dialog-tools">
        {reportable && <GameIssueButton />}
        {onClose && (
          <button
            type="button"
            className="pt-btn"
            autoFocus
            aria-label={closeLabel}
            onClick={onClose}
          >
            <X size={17} aria-hidden="true" />
          </button>
        )}
        </div>
      </header>
      <div className="pt-zone-body">{children}</div>
    </dialog>
  );
}
