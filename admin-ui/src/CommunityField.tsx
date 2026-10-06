import { TextField } from '@heroui/react/textfield';
import { Label } from '@heroui/react/label';
import { Input } from '@heroui/react/input';
export default function CommunityField({ label, value, onChange, type = 'text', disabled = false, readOnly = false, required = false, autoComplete = 'off', autoFocus = false, pattern }: {
  label: string; value: string; onChange?: (value: string) => void; type?: 'text' | 'email' | 'password' | 'url'; disabled?: boolean; readOnly?: boolean; required?: boolean; autoComplete?: string; autoFocus?: boolean; pattern?: string;
}) {
  return <TextField value={value} onChange={onChange} type={type} isDisabled={disabled} isReadOnly={readOnly} isRequired={required} validationBehavior="native" className="platform-field">
    <Label>{label}</Label><Input autoComplete={autoComplete} autoFocus={autoFocus} pattern={pattern}/>
  </TextField>;
}
