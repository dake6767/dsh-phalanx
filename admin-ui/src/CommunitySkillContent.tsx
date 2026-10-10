import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { usePlatformLanguage } from './CommunityLanguage';
import './community-skill.css';

export default function CommunitySkillContent({ markdown, files }: { markdown: string; files: readonly string[] }) {
  const { t } = usePlatformLanguage();
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, '');
  return <div className="skill-content">
    <section aria-label={t('Skill files')}><h3>{t('Skill files')}</h3><ul className="skill-file-tree">{files.map(path => <li key={path} style={{ paddingInlineStart: `${Math.min(path.split('/').length - 1, 8)}rem` }}><code>{path}</code></li>)}</ul></section>
    <section aria-label="SKILL.md"><h3>SKILL.md</h3><div className="skill-markdown"><Markdown skipHtml remarkPlugins={[remarkGfm]} components={{ img: ({ alt }) => <span>{alt}</span>, a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}>{body}</Markdown></div></section>
  </div>;
}
