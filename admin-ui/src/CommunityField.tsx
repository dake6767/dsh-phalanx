import type { Ref } from 'react'
import { TextField } from '@heroui/react/textfield'
import { Label } from '@heroui/react/label'
import { Input } from '@heroui/react/input'
import { Description } from '@heroui/react/description'
// Fields use HeroUI's primary variant; the theme draws it as a bordered field on every surface.
export default function CommunityField({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  disabled = false,
  readOnly = false,
  required = false,
  autoComplete = 'off',
  autoFocus = false,
  inputRef,
  pattern,
  description,
  variant = 'primary',
}: {
  label: string
  value: string
  placeholder?: string
  onChange?: (value: string) => void
  type?: 'text' | 'email' | 'password' | 'url'
  disabled?: boolean
  readOnly?: boolean
  required?: boolean
  autoComplete?: string
  autoFocus?: boolean
  inputRef?: Ref<HTMLInputElement>
  pattern?: string
  description?: string
  variant?: 'primary' | 'secondary'
}) {
  return (
    <TextField
      value={value}
      onChange={onChange}
      type={type}
      isDisabled={disabled}
      isReadOnly={readOnly}
      isRequired={required}
      validationBehavior="native"
      variant={variant}
      fullWidth
      className="platform-field"
    >
      <Label>{label}</Label>
      <Input placeholder={placeholder} ref={inputRef} autoComplete={autoComplete} autoFocus={autoFocus} pattern={pattern} />
      {description ? <Description>{description}</Description> : null}
    </TextField>
  )
}
