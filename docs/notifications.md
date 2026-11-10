# Agent inbox and local notifications

Open **Inbox** and enable **Monitor connected hosts** after installing the host companion's lifecycle hooks. Monitoring reads normalized status snapshots over existing, host-key-verified SSH connections. It does not open a listener or upload transcripts. The first snapshot establishes a baseline without producing a burst of old alerts.

**Enable system notifications** explicitly checks or requests the OS notification permission. **Test notification** submits a local test. New `needs_attention` events produce one alert containing the agent name and project directory. Permission denial leaves the inbox usable. **Pause system notifications** stops alerts while collection continues; uncheck monitoring to stop collection too.

The [inbox reference](reference/inbox.md) describes polling, retention and deduplication limits. To remove deduplication history and notification preferences too, clear the application data.

Select an inbox row or supported notification action to return to its still-connected SSH session, then inspect or answer the agent through its session controls. See the [inbox reference](reference/inbox.md) for action and platform limits.

## Background push remains separate

Local monitoring requires the app to be running and able to poll. For the boundary between local notifications and background delivery, see [notification delivery](explanation/notification-delivery.md).
