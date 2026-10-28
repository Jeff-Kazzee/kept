// Small inline SVG icons, drawn with strokes in the current text color. No
// icon font and no image requests.
const PATHS = {
  chat: "M4 5h16v11H8l-4 4z",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  calendarPlus: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4M12 13v5M9.5 15.5h5",
  checklist: "M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  key: "M14 10a4 4 0 1 1-1.2-2.8M14 10l7 7M18 14l2 2M16 16l1.5 1.5",
  settings: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z",
  send: "M12 19V5M5 12l7-7 7 7",
  close: "M6 6l12 12M18 6L6 18",
  check: "M5 12l5 5 9-10",
  alert: "M12 3l10 18H2zM12 10v5M12 18v.5",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5v.5",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z",
  shield: "M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z",
  message: "M4 4h16v12H7l-3 3zM8 9h8M8 12h5",
  question: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 1-1 1.7v.5M12 17v.5",
  reply: "M10 8L4 13l6 5M4 13h11a5 5 0 0 1 5 5v1",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  moon: "M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z",
  monitor: "M3 5h18v11H3zM8 20h8M12 16v4",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
  panel: "M3 5h18v14H3zM14 5v14",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  robot: "M5 9h14v10H5zM12 5v4M9 13v1M15 13v1M9 16.5h6M3 13v2M21 13v2",
  archive: "M3 5h18v4H3zM5 9v10h14V9M10 13h4",
  undo: "M9 7L4 12l5 5M4 12h10a6 6 0 0 1 0 12h-2",
  copy: "M8 8h12v12H8zM4 16V4h12",
  pin: "M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11zM12 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size }: { name: IconName; size?: "sm" }) {
  return (
    <svg className={size === "sm" ? "icon icon-sm" : "icon"} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}
