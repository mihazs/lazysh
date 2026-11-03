# Focused workspace navigation

This checkpoint follows the renewed visual feedback in #921, within the #668 redesign work. It changes the actual application hierarchy rather than adding a second interface or replacing terminal internals.

The connected phone terminal retains its compact header and existing keyboard controls. On desktop, the permanent session-tool catalogue is replaced by Workspace tools. Every existing destination remains available there, with platform restrictions, connection actions and destructive confirmation boundaries preserved.

Workspaces and Agents have a single destination heading and contextual return. One current app session appears as a compact return row; multiple sessions retain their existing disclosure and ownership checks. Workspace groups use a light tree rather than three nested card backgrounds. The shared-focus warning remains available through its labeled Info disclosure beside the relevant controls.

Live Herdr state and reported Activity remain different sources. Live rows group the existing needs-attention, working, done, idle and unknown states; selection reflects the observed focused target. Group labels carry the visible status, while each row retains its accessible status and fully wrapped host-readback context. Reported Activity retains its own filters, setup, freshness and approval handling. This presentation does not invent hook events, account availability, approvals or a new send capability.

Glass is limited to navigation and temporary controls. The floating mobile navigator lets scrolling content pass behind it, while agent contents remain fully opaque. The existing custom-theme opacity floor is retained. The scrolling region reserves the floating navigator’s height when bringing controls into view, so setup actions remain directly touchable. Reduced transparency and forced colors use solid surfaces; reduced motion retains the existing transition fallback. These browser observations do not establish Android rendering performance or physical-device acceptance.

## Review evidence

Fresh before/after synthetic captures use the same app state at 393×852 and 1280×850: terminal, Workspaces, Live agents and reported Activity. The public 1.10.2 source is the before baseline. Scrolled, reduced-transparency and forced-colors captures accompany the after state. Screenshot and source hashes are retained in the PR's private review packet; all accepted images are inspected.

Fresh publisher media informs hierarchy only: Moshi's agent feed and shortcut palette, and Termish's explicitly labeled iOS host/terminal/conversation images. Their visuals do not qualify Lazysh or comparator Android keyboard behavior. Brand assets, colors, icons and application behavior remain Lazysh's.

Existing App/session components and workspace/browser owners check tool reachability, context return, retained terminal identity and drafts, pending approvals, input silence, layouts and accessibility fallbacks. Native SSH, Android Back, vendor keyboards, physical targets and blur performance require their separate runtime gates; a passing frontend build is not that proof.
