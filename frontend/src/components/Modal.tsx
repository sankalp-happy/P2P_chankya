import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  right,
  maxWidth = 1240,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: ReactNode;
  right?: ReactNode;
  maxWidth?: number;
  children: ReactNode;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
      prevFocus?.focus?.();
    };
  }, [open, onClose]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[100] grid place-items-center p-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
          <div className="absolute inset-0 bg-black/70 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="panel relative flex max-h-[88vh] w-full flex-col [--pb:var(--color-line-strong)] [--pf:var(--color-bg)] [--px:8px]"
            style={{ maxWidth }}
            initial={{ y: 14, scale: 0.985 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: 8, scale: 0.99 }}
            transition={{ type: 'spring', stiffness: 420, damping: 34 }}
          >
            <header className="flex shrink-0 items-start justify-between gap-4 px-6 pt-5 pb-4">
              <div>
                <h2 id={titleId} className="title text-[24px]">
                  {title}
                </h2>
                {subtitle && <div className="mt-1.5 text-[13px] text-dim">{subtitle}</div>}
              </div>
              <div className="flex items-center gap-3">
                {right}
                <button ref={closeRef} className="btn h-9 w-9 px-0" onClick={onClose} aria-label="Close">
                  <svg viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
                    <path d="M5 5l10 10M15 5 5 15" />
                  </svg>
                </button>
              </div>
            </header>
            <div className="min-h-0 overflow-y-auto px-6 pb-6">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
