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

// A wide ridge line with contours and a heron at the water, for the empty
// chat. Drawn at very low contrast behind the welcome line.
export function RidgeScene() {
  return (
    <svg className="scene" viewBox="0 0 720 200" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" preserveAspectRatio="xMidYMax slice">
      <g strokeWidth="1.25">
        <path d="M0 132 70 92l46 30 62-58 58 44 44-26 70 50 58-40 64 36 52-30 72 46 50-24 74 38" />
        <path d="M0 150c60-8 120 10 190 2s140-18 210-6 150 14 320-2" opacity="0.7" />
        <path d="M0 164c80-6 150 8 230 2s160-14 230-4 140 12 260 0" opacity="0.5" />
        <path d="M120 78c20-10 38-10 58-14M300 72c18-6 34-4 50-10M470 86c14-6 30-6 44-12" opacity="0.5" />
      </g>
      <g strokeWidth="1.5">
        <path d="M0 184c40-8 80 6 120 0s80-10 120 0 80 8 120 0 80-10 120 0 80 8 120 0 80-6 120 0" />
      </g>
      {/* A heron standing in the shallows. */}
      <g strokeWidth="1.75" transform="translate(586 142) scale(0.62)">
        <path d="M14 0c-4 0-6 3-5 6l4 7" />
        <path d="M14 0l9 2" />
        <path d="M13 13c-6 2-9 8-7 14 2 5 9 6 15 3l6-5" />
        <path d="M14 30l-2 24M18 30l2 24" />
        <path d="M6 56h10M16 56h10" opacity="0.6" />
      </g>
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
