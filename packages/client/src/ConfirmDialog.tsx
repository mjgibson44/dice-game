import type { ReactNode } from "react";

interface ConfirmDialogProps {
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  /** Red confirm button for destructive actions. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ title, children, confirmLabel, danger = false, onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" role="alertdialog" aria-labelledby="confirm-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="confirm-title">{title}</h2>
        {children && <p className="muted">{children}</p>}
        <button type="button" className={`modal-button ${danger ? "danger" : "primary"}`} onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button type="button" className="modal-button secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
