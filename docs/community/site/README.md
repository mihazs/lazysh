# Local static landing artifact

This buildless HTML page uses the existing brand assets and links to GitHub.
It adds no frontend dependency, analytics, account or paid hosting. The Sites
local-artifact workflow is used; no hosted Site or domain has been registered.

Serve the repository root with `python3 -m http.server 8080 --bind 127.0.0.1`,
then open `/docs/community/site/`. Keep `brand/lazysh/` in the same repository-root
layout: relative logo/favicon paths deliberately reuse the authoritative assets.
Do not publish the checkout's Git metadata or dependency directories. A deployer
must copy only this HTML and the referenced brand files into the matching layout,
or rewrite those asset paths in a reviewed deployment package.

Hosting is unconfigured, not proven inaccessible. Before public deployment choose
an authorized static host, set canonical and `og:url` metadata to its verified URL,
review social image cropping, check local/release links and test the installed
APK route. Update the repository homepage only after deployment is verified.
The remote Open Graph icon is metadata; the page itself uses local brand assets.

The “capture pending” section is intentional. Replace it with a captioned real
demonstration only after the [capture procedure](../demonstrations.md) passes.
Do not add a dead Watch Demo button or advertise Apple application downloads.
