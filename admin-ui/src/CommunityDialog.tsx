import type { ReactNode } from 'react';
import { Modal } from '@heroui/react/modal';
export default function CommunityDialog({ title, children, busy = false, drawer = false, onClose }: {
  title: string; children: ReactNode; busy?: boolean; drawer?: boolean; onClose: () => void;
}) {
  return <Modal><Modal.Backdrop isOpen onOpenChange={open => { if (!open && !busy) onClose(); }} isDismissable={!busy} isKeyboardDismissDisabled={busy}>
    <Modal.Container className={drawer ? 'drawer-container' : undefined} scroll="inside" size={drawer ? 'lg' : 'md'}>
      <Modal.Dialog className={drawer ? 'account-drawer' : 'platform-dialog'} aria-label={title}>
        <Modal.Header><Modal.Heading>{title}</Modal.Heading></Modal.Header>
        <Modal.Body>{children}</Modal.Body>
      </Modal.Dialog>
    </Modal.Container>
  </Modal.Backdrop></Modal>;
}
