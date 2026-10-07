import type { Key } from 'react';
import { Select } from '@heroui/react/select';
import { Label } from '@heroui/react/label';
import { ListBox } from '@heroui/react/list-box';
import { Description } from '@heroui/react/description';
interface CommunitySelectOption { readonly id: string; readonly label: string }
export default function CommunitySelect({ label, value, options, onChange, placeholder, disabled = false, description, hideLabel = false, variant = 'secondary', className }: {
  label: string; value: string | null; options: readonly CommunitySelectOption[]; onChange: (value: string) => void; placeholder?: string; disabled?: boolean; description?: string; hideLabel?: boolean; variant?: 'primary' | 'secondary'; className?: string;
}) {
  return <Select aria-label={hideLabel ? label : undefined} value={value || null} placeholder={placeholder} isDisabled={disabled} variant={variant} className={className}
    onChange={(key: Key | Key[] | null) => { if (typeof key === 'string' && key !== value) onChange(key); }}>
    {hideLabel ? null : <Label>{label}</Label>}
    <Select.Trigger><Select.Value/><Select.Indicator/></Select.Trigger>
    {description ? <Description>{description}</Description> : null}
    <Select.Popover>
      <ListBox>{options.map(option => <ListBox.Item key={option.id} id={option.id} textValue={option.label}>{option.label}<ListBox.ItemIndicator/></ListBox.Item>)}</ListBox>
    </Select.Popover>
  </Select>;
}
