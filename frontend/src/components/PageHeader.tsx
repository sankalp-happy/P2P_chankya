import type { ReactNode } from 'react';
import DecryptedText from './rb/DecryptedText';

export function PageHeader({ index, title, sub, right }: { index: number; title: string; sub?: string; right?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div>
        <div className="eyebrow mb-2">
          {String(index).padStart(2, '0')} / 07
        </div>
        <h1 className="title text-[34px]">
          <DecryptedText key={title} text={title} animateOn="view" speed={35} maxIterations={12} sequential revealDirection="start" characters="▪▫░▒▓█01" />
        </h1>
        {sub && <p className="mt-2 max-w-[70ch] text-[13.5px] text-dim">{sub}</p>}
      </div>
      {right}
    </div>
  );
}
