import { useId } from 'react'
import { Description } from '@heroui/react/description'
import { Input } from '@heroui/react/input'
import { Label } from '@heroui/react/label'

export default function CommunityFileField({
  label,
  description,
  accept,
  disabled,
  onChange,
}: {
  label: string
  description: string
  accept: string
  disabled: boolean
  onChange: (file: File | undefined) => void
}) {
  const id = useId()
  const hint = id + '-hint'
  return (
    <div className="platform-file-field">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="file" accept={accept} disabled={disabled} aria-describedby={hint} onChange={event => onChange(event.target.files?.[0])} />
      <Description id={hint}>{description}</Description>
    </div>
  )
}
