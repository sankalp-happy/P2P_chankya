import clsx from 'clsx';
import { useState, type ReactNode } from 'react';
import type { LiveStatus } from '../lib/dataset';

// Sprites are generated separately (Gemini) and dropped into public/sprites/<name>.png.
// Until a file exists we render a dotted placeholder so layout never shifts.
const missing = new Set<string>();

export function Sprite({
  name,
  size = 48,
  className,
  grey,
  alt = '',
}: {
  name: string;
  size?: number;
  className?: string;
  grey?: boolean;
  alt?: string;
}) {
  const [failed, setFailed] = useState(missing.has(name));
  const style = { width: size, height: size };
  if (failed) {
    return (
      <span
        role="img"
        aria-label={alt || name}
        style={style}
        className={clsx(
          'inline-grid shrink-0 place-items-center border border-dashed border-line-strong text-faint',
          className,
        )}
      >
        <span className="mono" style={{ fontSize: Math.max(8, size / 5) }}>
          {name.replace(/^(bld_|item_)/, '').slice(0, 3).toUpperCase()}
        </span>
      </span>
    );
  }
  return (
    <img
      src={`/sprites/${name}.png`}
      alt={alt}
      width={size}
      height={size}
      draggable={false}
      onError={() => {
        missing.add(name);
        setFailed(true);
      }}
      className={clsx('pixelated shrink-0 select-none object-contain transition-[filter,opacity] duration-500', grey && 'opacity-40 grayscale', className)}
      style={style}
    />
  );
}

export function Panel({
  title,
  right,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={clsx('panel flex min-w-0 flex-col', className)}>
      {(title || right) && (
        <header className="flex min-h-[52px] items-center justify-between gap-3 px-5 pt-4 pb-2">
          {typeof title === 'string' ? <Eyebrow>{title}</Eyebrow> : title}
          {right}
        </header>
      )}
      <div className={clsx('min-h-0 flex-1 px-5 pb-5', bodyClassName)}>{children}</div>
    </section>
  );
}

export function Eyebrow({ children, dot, className }: { children: ReactNode; dot?: 'red' | 'white'; className?: string }) {
  return (
    <span className={clsx('eyebrow inline-flex items-center gap-2', className)}>
      {dot && <span className={clsx('size-1.5', dot === 'red' ? 'bg-alert' : 'bg-fg')} />}
      {children}
    </span>
  );
}

const STATUS_COPY: Record<LiveStatus, string> = { live: 'Live', filled: 'Filled in', offline: 'Offline' };

export function StatusPill({ status }: { status: LiveStatus }) {
  return (
    <span
      className={clsx(
        'chip h-[22px] px-2',
        status === 'offline' && 'text-alert [--pb:var(--color-alert)]',
        status === 'filled' && 'text-dim',
      )}
    >
      <span
        className={clsx(
          'size-1.5',
          status === 'live' && 'animate-pulse-dot bg-good',
          status === 'filled' && 'border border-dim',
          status === 'offline' && 'bg-alert',
        )}
      />
      {STATUS_COPY[status]}
    </span>
  );
}

export function Delta({ value, invert, className }: { value: number; invert?: boolean; className?: string }) {
  if (!Number.isFinite(value)) return <span className={clsx('mono text-[11px] text-faint', className)}>—</span>;
  const good = invert ? value > 0 : value < 0;
  return (
    <span className={clsx('mono text-[11px]', good ? 'text-good' : value === 0 ? 'text-dim' : 'text-bad', className)}>
      {value > 0 ? '▲' : value < 0 ? '▼' : '•'} {Math.abs(value).toFixed(1)}%
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('animate-pulse bg-raised', className)} />;
}

export function Empty({ sprite = 'ghast', title, detail }: { sprite?: string; title: string; detail?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
      <Sprite name={sprite} size={56} className="animate-bob" />
      <div className="text-sm text-soft">{title}</div>
      {detail && <div className="max-w-[28ch] text-xs text-dim">{detail}</div>}
    </div>
  );
}

/** Tiny inline sparkline: SVG polyline, no axes. */
export function Spark({ values, width = 120, height = 28, className }: { values: number[]; width?: number; height?: number; className?: string }) {
  const pts = values.map((v, i) => [i, v] as const).filter(([, v]) => Number.isFinite(v));
  if (pts.length < 2) return <svg width={width} height={height} className={className} />;
  const max = Math.max(...pts.map(([, v]) => v));
  const min = Math.min(...pts.map(([, v]) => v));
  const span = max - min || 1;
  const n = values.length - 1 || 1;
  const d = pts.map(([i, v], k) => `${k ? 'L' : 'M'}${((i / n) * width).toFixed(1)},${(height - 2 - ((v - min) / span) * (height - 4)).toFixed(1)}`).join('');
  return (
    <svg width={width} height={height} className={className} aria-hidden>
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinejoin="round" />
    </svg>
  );
}
