# plugin-doctor

Local Claude Code diagnostics for plugin development and release preparation.

It keeps four focused tools:

- `plugin_check`: validate a plugin with Claude Code, inspect JSON/BOM issues, check optional MCP servers, probe `initialize` and `tools/list`, and optionally compare the installed cache and marketplace metadata.
- `plugin_install_local`: copy a validated plugin into the `local-tools` directory marketplace, refresh that marketplace, and call Claude Code's official `plugin install` or `plugin update` command. It never edits `installed_plugins.json` directly.
- `plugin_release_audit`: check validation, README/license presence, marketplace metadata, suspicious local paths, secret-like values, symlinks, and Git cleanliness without printing matched secret values.
- `plugin_context_audit`: summarize installed plugin manifests, Skill sizes, MCP counts, and `alwaysLoad` usage to find avoidable startup context pressure.

## Design

`plugin-doctor` treats `.mcp.json` as optional because Claude Code plugins may contain only Skills, agents, commands, hooks, or other supported components. When MCP servers are present, the doctor accepts JSONL or `Content-Length` framing and tests both when necessary.

Plugin installation is cache-aware. Marketplace plugins are copied into Claude Code's versioned cache, so the plugin manifest version must change before an installed release can update. `plugin-doctor` delegates cache and installation records to the Claude Code CLI.

## Requirements

- Node.js 18 or newer.
- A Claude Code version that supports `claude plugin validate`, marketplace updates, and plugin install/update commands.

## Safety

- Plugin and repository paths are restricted to the current project or Claude plugin data/cache directories.
- MCP stderr and CLI failures are redacted before they are returned.
- Release audits report only the affected relative file and rule, not the suspected secret value.
- Local installation creates a temporary rollback copy and restores the marketplace/plugin directory if the official CLI step fails before installation commits. A post-install probe failure is reported as a warning without undoing a successful official installation.

Run `node mcp-server.js --self-test` for the built-in checks.
