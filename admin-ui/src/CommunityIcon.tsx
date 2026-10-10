type IconName = 'skills' | 'plugins' | 'groups' | 'accounts' | 'models' | 'settings' | 'arrow' | 'plus' | 'edit' | 'more' | 'logout' | 'close' | 'shield' | 'chevron' | 'check' | 'activity' | 'alert' | 'downright';
const paths: Record<IconName, string> = {
  chevron: 'm9 5 7 7-7 7', check: 'M22 12a10 10 0 1 1-6-9M8 11l4 4L22 5', activity: 'M2 12h4l3-9 6 18 3-9h4', alert: 'M12 8v5M12 16h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0', downright: 'm7 7 10 10M7 17h10V7',
  skills: 'M5 3h11l3 3v15H5zM15 3v4h4M8 11h8M8 15h6',
  plugins: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  groups: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  accounts: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  models: 'm12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5',
  settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
  arrow: 'M7 17 17 7M7 7h10v10', plus: 'M12 5v14M5 12h14',
  edit: 'm15 5 4 4M4 20l4-1L20 7a2.83 2.83 0 0 0-4-4L4 15v5Z',
  more: 'M5 12h.01M12 12h.01M19 12h.01', logout: 'M9 4H4v16h5M9 12h12m-4-4 4 4-4 4',
  close: 'm6 6 12 12M6 18 18 6', shield: 'm12 3 8 3v6c0 4-8 9-8 9s-8-5-8-9V6l8-3Zm-4 9 3 3 5-6',
};
export default function CommunityIcon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={name === 'more' ? 3 : 1.65} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/></svg>;
}
