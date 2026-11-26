import { useState } from 'react'
import CommunityIcon from './CommunityIcon'

export default function CommunityPluginIcon({ icon }: { readonly icon?: string | undefined }) {
  const [failed, setFailed] = useState<string>()
  return (
    <span className="plugin-card-icon" aria-hidden="true">
      {icon && icon !== failed ? <img src={icon} alt="" width={36} height={36} onError={() => setFailed(icon)} /> : <CommunityIcon name="plugins" size={22} />}
    </span>
  )
}
