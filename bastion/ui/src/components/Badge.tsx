const colors: Record<string, string> = {
  running: "bg-green-900/60 text-green-300 border-green-700",
  stopped: "bg-gray-800 text-gray-400 border-gray-600",
  provisioning: "bg-yellow-900/60 text-yellow-300 border-yellow-700",
  failed: "bg-red-900/60 text-red-300 border-red-700",
  unknown: "bg-gray-800 text-gray-500 border-gray-700",
  not_provisioned: "bg-gray-800 text-gray-500 border-gray-700",
};

export function Badge({ status }: { status: string }) {
  const cls = colors[status] ?? colors.unknown;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${cls}`}>
      {status}
    </span>
  );
}
