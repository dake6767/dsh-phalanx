import type { ReactNode } from 'react';
import { Drawer } from '@heroui/react/drawer';
import { Modal } from '@heroui/react/modal';
export default function CommunityDialog({ title, children, footer, eyebrow, busy = false, drawer = false, onClose }: {
  title: string; children: ReactNode; footer?: ReactNode; eyebrow?: string; busy?: boolean; drawer?: boolean; onClose: () => void;
}) {
  const onOpenChange = (open: boolean) => { if (!open && !busy) onClose(); };
  if (drawer) return <Drawer><Drawer.Backdrop isOpen onOpenChange={onOpenChange} isDismissable={!busy} isKeyboardDismissDisabled={busy}>
    <Drawer.Content placement="right">
      {/* Keep close requests behind the draft guard; drag dismissal moves the panel before confirmation. */}
      <Drawer.Dialog className="account-drawer" aria-label={title} onPointerDown={() => {}} style={{ touchAction: 'auto' }}>
        {busy ? null : <Drawer.CloseTrigger aria-label="Close account details"/>}
        <Drawer.Header>{eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}<Drawer.Heading>{title}</Drawer.Heading></Drawer.Header>
        <Drawer.Body>{children}</Drawer.Body>
        {footer ? <Drawer.Footer>{footer}</Drawer.Footer> : null}
      </Drawer.Dialog>
    </Drawer.Content>
  </Drawer.Backdrop></Drawer>;
  return <Modal><Modal.Backdrop isOpen onOpenChange={onOpenChange} isDismissable={!busy} isKeyboardDismissDisabled={busy}>
    <Modal.Container scroll="inside" size="md">
      <Modal.Dialog className="platform-dialog" aria-label={title}>
        <Modal.Header><Modal.Heading>{title}</Modal.Heading></Modal.Header>
        <Modal.Body>{children}</Modal.Body>
        {footer ? <Modal.Footer>{footer}</Modal.Footer> : null}
      </Modal.Dialog>
    </Modal.Container>
  </Modal.Backdrop></Modal>;
}
