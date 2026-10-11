import { useEffect, useState } from 'react';

/** Existing feature dialogs retain focus priority, including their exit transitions. */
export function useOtherDialog(): boolean {
  const [hasOtherDialog, setOtherDialog] = useState(true);
  useEffect(() => {
    function readOtherDialog(): void {
      setOtherDialog(
        Boolean(
          document.querySelector(
            '[role="dialog"]:not(.onboarding-dialog), [role="alertdialog"], [role="menu"]',
          ),
        ),
      );
    }

    readOtherDialog();
    const observer = new MutationObserver(readOtherDialog);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['role', 'class'],
    });
    return () => {
      observer.disconnect();
    };
  }, []);
  return hasOtherDialog;
}
