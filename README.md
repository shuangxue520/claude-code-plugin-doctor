# claude-code-plugin-doctor

[![Version](https://img.shields.io/badge/version-0.3.0-blue)]()
[![License](https://img.shields.io/badge/license-MIT-green)]()

`plugin-doctor` is a local Claude Code plugin for diagnosing plugin load
failures, testing MCP startup, checking installed cache consistency, and
auditing a plugin before publication.

It is deliberately small: five high-level tools cover diagnosis, fleet
consistency, safe local installation, release readiness, and context-cost
auditing.

## What It Checks

- Claude Code's official plugin validator, including Skill frontmatter.
- Plugin manifest and JSON encoding problems such as UTF-8 BOMs.
- Optional MCP commands, Node syntax, `initialize`, and `tools/list`.
- JSONL and `Content-Length` MCP framing.
- Manifest, marketplace, installed-record, and active-cache version agreement.
- Full local marketplace audits, including stale cache versions and orphaned
  installed records.
- Release metadata, README/license presence, suspicious local paths,
  secret-like values, symlinks, and Git worktree state.
- Installed Skill sizes, manifest sizes, MCP counts, and `alwaysLoad` usage.

Release audits never print a suspected secret. Findings contain only the
relative filename and the rule that matched.

## Install

In Claude Code:

```text
/plugin marketplace add shuangxue520/claude-code-plugin-doctor
/plugin install plugin-doctor@plugin-doctor-marketplace
/reload-plugins
```

For local development:

```powershell
git clone https://github.com/shuangxue520/claude-code-plugin-doctor.git
cd claude-code-plugin-doctor
claude --plugin-dir .\plugins\plugin-doctor
```

## Requirements

- Node.js 18 or newer.
- Claude Code with the `claude plugin` CLI commands.

There are no npm dependencies.

## Tools

### `plugin_check`

Checks a source or installed plugin. MCP probing is enabled by default. Pass
`checkInstallation: true` only when diagnosing a `local-tools` installation or
cache/version mismatch.

### `plugin_install_local`

Copies a validated source plugin into the registered `local-tools` directory
marketplace, refreshes the marketplace, and calls Claude Code's official
`plugin install` or `plugin update` command. It does not edit
`installed_plugins.json` directly and restores its file changes if the CLI
step fails.

### `plugin_release_audit`

Checks a plugin and optional marketplace repository before publication. Use
`requireCleanGit: true` for the final pre-push gate.

### `plugin_context_audit`

Returns a compact inventory of installed plugin context pressure. It is an
estimate, not an exact token bill.

### `plugin_fleet_audit`

Compares every plugin in the registered `local-tools` marketplace across its
source manifest, marketplace entry, installed record, and installed manifest.
It also reports stale cache directories without deleting them.

## Safety Model

Plugin paths are restricted to the active Claude project or Claude's plugin
data/cache directories. MCP probes execute commands declared by the plugin being
checked, so only probe plugins you trust. Local installation can modify the
registered `local-tools` marketplace and invoke Claude Code's plugin manager.

See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md) before use.

## Development

```powershell
node --check .\plugins\plugin-doctor\mcp-server.js
node .\plugins\plugin-doctor\mcp-server.js --self-test
claude plugin validate .\plugins\plugin-doctor
claude plugin validate .
```
