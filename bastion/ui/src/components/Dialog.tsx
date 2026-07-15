interface Props {
  open: boolean;
  title: string;
  message: string;
  onConfirm(): void;
  onCancel(): void;
  confirmLabel?: string;
  dangerous?: boolean;
}

export function Dialog({ open, title, message, onConfirm, onCancel, confirmLabel = "Confirm", dangerous }: Props) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.7)" }}>
      <div
        className="max-w-md w-full mx-4 p-6 rounded-lg shadow-xl"
        style={{ background: "#1a1a1a", border: "1px solid #444" }}
      >
        <h3 className="text-base font-semibold mb-2" style={{ color: "#eee" }}>{title}</h3>
        <p className="text-sm mb-6 whitespace-pre-wrap" style={{ color: "#aaa" }}>{message}</p>
        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm rounded cursor-pointer transition-colors"
            style={{ background: "#222", border: "1px solid #444", color: "#ccc" }}
            onMouseOver={(e) => (e.currentTarget.style.background = "#2a2a2a")}
            onMouseOut={(e) => (e.currentTarget.style.background = "#222")}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 text-sm rounded text-white cursor-pointer transition-colors"
            style={{ background: dangerous ? "#7f1d1d" : "#2563eb" }}
            onMouseOver={(e) => (e.currentTarget.style.background = dangerous ? "#991b1b" : "#1d4ed8")}
            onMouseOut={(e) => (e.currentTarget.style.background = dangerous ? "#7f1d1d" : "#2563eb")}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
