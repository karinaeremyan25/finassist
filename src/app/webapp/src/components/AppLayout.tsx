/** Каркас: контейнер max-width, контент со скроллом, нижняя навигация. */

import type { ReactNode } from 'react';
import { BottomNav } from './BottomNav';

export function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto min-h-full max-w-app bg-bg-deep">
      <main className="pb-[calc(64px+env(safe-area-inset-bottom,0px))]">{children}</main>
      <BottomNav />
    </div>
  );
}

/** Заголовок секции + опциональная ссылка справа. */
export function SectionHeader({
  title,
  right,
}: {
  title: string;
  right?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-baseline justify-between">
      <h2 className="text-[17px] font-semibold text-ink">{title}</h2>
      {right ? <div className="text-[13px] text-ink-muted">{right}</div> : null}
    </div>
  );
}
