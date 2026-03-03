import { useEffect } from "react";

export function Toast({ message, type, onClose }: { message: string; type: "success" | "error"; onClose: () => void }) {
  useEffect(() => { const t = setTimeout(onClose, 4000); return () => clearTimeout(t); }, [onClose]);
  return (
    <div className={`fixed bottom-4 right-4 px-4 py-3 rounded-lg shadow-lg z-50 ${type === "success" ? "bg-green-900 text-green-200" : "bg-red-900 text-red-200"}`}>
      {message}
    </div>
  );
}
