// The app's mark and its quiet line drawings, inline SVG in the current
// text color, so they follow the theme and need no image request. Each one
// is decoration: hidden from screen readers.

// A mountain ridge over a river line. Also the favicon (public/icon.svg).
export function Mark({ size = 20 }: { size?: number }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M2.5 15.5 8 8.5l3.2 4 2.8-4.5 7.5 7.5" />
      <path d="M3 19.5c2.6-1.4 5 1.1 9 0s6.4-1.4 9 0" />
    </svg>
  );
}

// A fox at rest, for the empty Activity tab.
export function Fox() {
  return (
    <svg className="critter" viewBox="0 0 64 40" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M8 30c0-9 8-15 19-15h10c7 0 12 5 12 11" />
      <path d="M49 26l5-9 2 7 4 1-5 4" />
      <path d="M8 30c-4 2-6 6-2 7 6 2 18 0 30 0s16-1 18-5" />
      <path d="M24 15c-6-4-10-3-12 1" opacity="0.7" />
      <path d="M55 22h.5" />
    </svg>
  );
}
