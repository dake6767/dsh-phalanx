import type { ReactNode } from 'react';
import { Alert } from '@heroui/react/alert';
// role stays explicit: alerts are announced immediately, status messages politely.
export default function CommunityMessage({ status, title, children, role }: {
  status: 'default' | 'accent' | 'success' | 'warning' | 'danger'; title?: ReactNode; children?: ReactNode; role?: 'alert' | 'status';
}) {
  return <Alert status={status} role={role} className="community-message">
    <Alert.Indicator/>
    <Alert.Content>{title ? <Alert.Title>{title}</Alert.Title> : null}{children ? <Alert.Description>{children}</Alert.Description> : null}</Alert.Content>
  </Alert>;
}
