/** Subscribes to a device-local setting: the event the setting announces its own change with, and other windows' storage events. */
export function deviceSettingSubscriber(changed: string) {
  return (callback: () => void) => {
    window.addEventListener(changed, callback);
    window.addEventListener('storage', callback);
    return () => { window.removeEventListener(changed, callback); window.removeEventListener('storage', callback); };
  };
}
