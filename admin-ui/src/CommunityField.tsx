import { TextField } from '@heroui/react/textfield';
import { Label } from '@heroui/react/label';
import { Input } from '@heroui/react/input';
import { Description } from '@heroui/react/description';
// Fields render inside panels, drawers and dialogs, so HeroUI's surface variant is the default.
export default function CommunityField({ label, value, onChange, type = 'text', disabled = false, readOnly = false, required = false, autoComplete = 'off', autoFocus = false, pattern, description, variant = 'secondary' }: {
  label: string; value: string; onChange?: (value: string) => void; type?: 'text' | 'email' | 'password' | 'url'; disabled?: boolean; readOnly?: boolean; required?: boolean; autoComplete?: string; autoFocus?: boolean; pattern?: string; description?: string; variant?: 'primary' | 'secondary';
}) {
  return <TextField value={value} onChange={onChange} type={type} isDisabled={disabled} isReadOnly={readOnly} isRequired={required} validationBehavior="native" variant={variant} fullWidth className="platform-field">
    <Label>{label}</Label><Input autoComplete={autoComplete} autoFocus={autoFocus} pattern={pattern}/>
    {description ? <Description>{description}</Description> : null}
  </TextField>;
}
