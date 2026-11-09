type IconName =
  | 'skills'
  | 'plugins'
  | 'suites'
  | 'groups'
  | 'accounts'
  | 'models'
  | 'settings'
  | 'arrow'
  | 'switch'
  | 'external'
  | 'plus'
  | 'edit'
  | 'more'
  | 'logout'
  | 'close'
  | 'shield'
  | 'chevron'
  | 'check'
  | 'activity'
  | 'alert'
  | 'downright'
  | 'user'
  | 'mcp'
  | 'experts'
  | 'package'
  | 'usage'
  | 'brand'
const paths: Record<IconName, string> = {
  chevron: 'm9 5 7 7-7 7',
  check: 'M22 12a10 10 0 1 1-6-9M8 11l4 4L22 5',
  activity: 'M2 12h4l3-9 6 18 3-9h4',
  alert: 'M12 8v5M12 16h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  downright: 'm7 7 10 10M7 17h10V7',
  // Skill library: an open book.
  skills: 'M12 6.5C10.5 5 8 4.5 4 4.5v14c4 0 6.5.5 8 2 1.5-1.5 4-2 8-2v-14c-4 0-6.5.5-8 2ZM12 6.5v14',
  // Plugin library: a puzzle piece.
  plugins: 'M9 4h3.5a1.5 1.5 0 0 1 3 0H19v4a1.5 1.5 0 0 1 0 3v4h-3.5a1.5 1.5 0 0 0-3 0H9v-3.5a1.5 1.5 0 0 0 0-3V4ZM5 9.5h4M5 9.5v8h4',
  suites: 'M4 4h16l1.5 5a3 3 0 0 1-5.5 1.5A3 3 0 0 1 10.5 10.5 3 3 0 0 1 5 9zM5 12v8h14v-8M10 20v-5h4v5',
  // Group management: people sharing one setting.
  groups: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3 20v-1a5 5 0 0 1 10 0v1M16 11a2.5 2.5 0 1 0 0-5M17.5 20v-1a4.5 4.5 0 0 0-2.5-4',
  accounts: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  // Model management: a processor chip.
  models: 'M7 7h10v10H7zM10 10h4v4h-4zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
  // System settings: a gear.
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z',
  // Account management: a single person.
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1',
  // MCP library: a plug.
  mcp: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0V8ZM12 17v4',
  // Expert library: sparkles.
  experts: 'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3ZM18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z',
  // Runtime dependencies: a package box.
  package: 'M21 8 12 3 3 8v8l9 5 9-5V8ZM3 8l9 5 9-5M12 13v8M7.5 5.5l9 5',
  // Usage records: a bar chart.
  usage: 'M4 20h16M7 16v-5M12 16V6M17 16v-8',
  // Brand: stacked shields of a phalanx.
  brand: 'm12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5',
  arrow: 'M7 17 17 7M7 7h10v10',
  switch: 'M16 3l4 4-4 4M20 7H4M8 21l-4-4 4-4M4 17h16',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  plus: 'M12 5v14M5 12h14',
  edit: 'm15 5 4 4M4 20l4-1L20 7a2.83 2.83 0 0 0-4-4L4 15v5Z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  logout: 'M9 4H4v16h5M9 12h12m-4-4 4 4-4 4',
  close: 'm6 6 12 12M6 18 18 6',
  shield: 'm12 3 8 3v6c0 4-8 9-8 9s-8-5-8-9V6l8-3Zm-4 9 3 3 5-6',
}
export default function CommunityIcon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === 'more' ? 3 : 1.65}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  )
}
