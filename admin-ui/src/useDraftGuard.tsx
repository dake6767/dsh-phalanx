import { useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react/button';
import CommunityDialog from './CommunityDialog';
/** Guard shared by in-app actions and ordinary links; browser unloading uses its native prompt. */
export function useDraftGuard(dirty: boolean, save: () => Promise<boolean>, discard: () => void, busy = false) {
  const [pending, setPending] = useState<(() => void)>();
  const latest = useRef({ dirty, save, discard, busy });
  latest.current = { dirty, save, discard, busy };
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => { if (latest.current.dirty) { event.preventDefault(); event.returnValue = ''; } };
    const link = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!target || target.target === '_blank' || target.hasAttribute('download') || !latest.current.dirty) return;
      event.preventDefault();
      if (!latest.current.busy) setPending(() => () => location.assign(target.href));
    };
    window.addEventListener('beforeunload', unload); document.addEventListener('click', link, true);
    return () => { window.removeEventListener('beforeunload', unload); document.removeEventListener('click', link, true); };
  }, []);
  const proceed = (action: () => void) => {
    setPending(undefined);
    // Clear the native unload guard only once the explicitly chosen disposition succeeded.
    latest.current.dirty = false;
    action();
  };
  return {
    request: (action: () => void) => { if (busy) return; if (dirty) setPending(() => action); else action(); },
    dialog: pending ? <CommunityDialog title="Unsaved changes" busy={busy} onClose={() => setPending(undefined)}>
      <p>Save your changes before continuing, discard them, or keep editing.</p>
      <div className="dialog-actions"><Button variant="tertiary" isDisabled={busy} onPress={() => setPending(undefined)}>Continue editing</Button>
        <Button variant="secondary" isDisabled={busy} onPress={() => { discard(); proceed(pending); }}>Discard changes</Button>
        <Button isDisabled={busy} onPress={() => { void latest.current.save().then(saved => { if (saved) proceed(pending); }); }}>Save changes</Button></div>
    </CommunityDialog> : null,
  };
}
