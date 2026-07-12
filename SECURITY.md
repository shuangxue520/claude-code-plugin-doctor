# Security

## Trust Boundary

Claude Code plugins and MCP servers can execute code with the user's
permissions. Only diagnose, probe, or install plugins you trust.

`plugin_check` may start every MCP command declared in the target `.mcp.json`.
Use `probeMcp: false` for an untrusted plugin and inspect its source first.

`plugin_install_local` can replace a plugin folder in the local marketplace and
invoke Claude Code's plugin manager. It creates a temporary rollback copy and
does not write `installed_plugins.json` itself.

## Reporting A Vulnerability

Open a GitHub issue with a minimal reproduction that contains no credentials,
private source, personal paths, or private plugin configuration. For a report
that cannot be safely public, contact the repository owner through GitHub.
