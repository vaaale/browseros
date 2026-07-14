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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-gray-800 border border-gray-700 rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
        <h3 className="text-base font-semibold text-gray-100 mb-2">{title}</h3>
        <p className="text-sm text-gray-400 mb-6 whitespace-pre-wrap">{message}</p>
        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm rounded bg-gray-700 hover:bg-gray-600 text-gray-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 text-sm rounded text-white transition-colors ${dangerous ? "bg-red-700 hover:bg-red-600" : "bg-blue-600 hover:bg-blue-500"}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
