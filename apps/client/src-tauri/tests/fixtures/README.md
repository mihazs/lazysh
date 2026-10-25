# Forwarding test identity

`agent_rsa` is an unencrypted RSA key generated solely for agent-protocol signature tests. It has never been used to access a real host and must never be authorized outside test fixtures. Keeping a fixed test identity avoids generating RSA primes on every test run.
