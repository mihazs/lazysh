# Sign-in output fixtures

Terminal output of sign-in commands, byte for byte as a pseudo-terminal delivered it (carriage returns, colours and
hyperlink sequences included), for the scanner's tests. The `.raw` files were recorded on 2026-11-13 on one Linux host
by running each command with an empty `HOME`, no credentials and a recording stand-in for the browser launcher (see
`docs/reference/sso-login-flows.md`). `aws sso login` and `aws login` talked to a local fake OIDC endpoint, the others to the real service without signing
in. Versions: aws-cli 2.37.9, gcloud 592.0.0, az 2.90.0, gh 2.103.3, claude 2.1.322, codex-cli 0.167.0.

`state`, `nonce` and `code_challenge` values were replaced by `STATE`, `NONCE` and `CHALLENGE`, and one-time user codes
by `USERCODE`. The OAuth `client_id` values are the public ones the tools ship with.

The `.doc` files were NOT recorded: wrangler, firebase, terraform, vault and kubelogin were not installed, so their
text is written from each tool's documentation and source. They check that the scanner reads that shape, not that the
tool prints exactly this.
