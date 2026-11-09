import { useId, type ReactNode } from 'react'

/** Drawer settings sections share the plugin drawer's bordered layout: heading, optional action, one muted note, content. */
export default function CommunityGrantSection({
  title,
  description,
  action,
  children,
}: {
  title: string
  description?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  // Named by its heading so a field with the same label stays the only match for that label.
  const id = useId()
  return (
    <section className="plugin-detail-section" aria-labelledby={id}>
      <div className="plugin-section-heading">
        <h2 id={id}>{title}</h2>
        {action}
      </div>
      {description ? <div className="section-note">{description}</div> : null}
      {children}
    </section>
  )
}
