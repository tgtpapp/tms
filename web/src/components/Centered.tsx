import type { ReactNode } from 'react';
import { config } from '../config';

export function Centered({ children }: { children: ReactNode }) {
  return (
    <main className="centered">
      <h1 className="brand">{config.appName}</h1>
      {children}
    </main>
  );
}
