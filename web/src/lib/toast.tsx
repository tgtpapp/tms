import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

type ToastKind = 'ok' | 'error';
interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

type PushToast = (kind: ToastKind, text: string) => void;

const ToastContext = createContext<PushToast>(() => undefined);

/** Thông báo tự ẩn sau khi đã báo (quy tắc CLAUDE.md mục 6). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = useCallback<PushToast>((kind, text) => {
    const id = Date.now() + Math.random();
    setItems((list) => [...list, { id, kind, text }]);
    window.setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), kind === 'error' ? 6000 : 3000);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): PushToast {
  return useContext(ToastContext);
}
