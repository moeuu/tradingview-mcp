# Security Policy

## Supported versions

Security fixes are applied to the latest release and the `main` branch.

## Reporting a vulnerability

Please use GitHub's private security advisory form:

https://github.com/moeuu/tradingview-mcp/security/advisories/new

Do not open a public issue for a suspected vulnerability. Include the affected
version, a minimal reproduction, impact, and any proposed mitigation. Remove
cookies, tokens, local paths, private market data, and browser storage from all
attachments.

## Security model

TradingView MCP is local-first:

- the HTTP API binds to loopback by default;
- authenticated TradingView access is opt-in;
- browser state is loaded from exactly one user-provided file outside this repository;
- authentication files must be owner-only on POSIX systems and smaller than 1 MiB;
- only allowlisted TradingView cookie names are imported, and local storage is excluded by default;
- generated screenshots, traces, and imported market data are ignored by Git;
- remote chart navigation is restricted to an explicit HTTPS origin allowlist.

MCP and REST request schemas do not accept authentication values or file paths.
Capabilities expose the active allowlist names but never credential values or
authentication file locations.

The server is not designed to be exposed directly to an untrusted network.
Treat any authenticated browser state as a secret and apply the least privilege
available to the account used with it.
