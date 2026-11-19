// Biểu tượng ô trong sơ đồ xe: ghế, giường, tài xế (vô lăng), cửa lên xuống.
export type CellKind = 'ghe' | 'giuong' | 'tai_xe' | 'cua';

export function SeatIcon({ kind, size = 18 }: { kind: CellKind; size?: number }) {
  const p = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
    strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  if (kind === 'tai_xe') {
    return (
      <svg {...p}>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="2.4" />
        <path d="M3.4 10.2c2.9-.9 5.7-1.3 8.6-1.3s5.7.4 8.6 1.3M10 14l-3.2 6M14 14l3.2 6" />
      </svg>
    );
  }
  if (kind === 'cua') {
    return (
      <svg {...p}>
        <path d="M5 21V4.5A1.5 1.5 0 0 1 6.5 3h8A1.5 1.5 0 0 1 16 4.5V21" />
        <path d="M3 21h18" />
        <circle cx="13" cy="12" r=".9" fill="currentColor" />
        <path d="M18.5 9.5 21 12l-2.5 2.5M21 12h-4.5" />
      </svg>
    );
  }
  if (kind === 'giuong') {
    return (
      <svg {...p}>
        <path d="M3 18V7M3 14h18v4M21 14v-2a3 3 0 0 0-3-3h-7v5" />
        <circle cx="7" cy="11" r="2" />
      </svg>
    );
  }
  return (
    <svg {...p}>
      <path d="M7 12V5.5A2.5 2.5 0 0 1 9.5 3h5A2.5 2.5 0 0 1 17 5.5V12" />
      <path d="M5 12.5A1.5 1.5 0 0 1 6.5 11h11a1.5 1.5 0 0 1 1.5 1.5V16H5z" />
      <path d="M7 16v4M17 16v4" />
    </svg>
  );
}
