# Changelog

## 0.3.0

- Add `plugin_fleet_audit` for one-call consistency checks across every plugin
  in a local marketplace.
- Compare source, marketplace, installed-record, and installed-manifest
  versions.
- Report stale caches and orphan installed records without deleting them.

## 0.2.0

- Add official Claude Code plugin validation to diagnostics.
- Treat `.mcp.json` as optional for Skill-only and other non-MCP plugins.
- Add Windows command resolution for npm-installed `claude` and `npx` tools.
- Replace direct installed-record editing with official CLI install/update.
- Add transactional rollback for local marketplace installation failures.
- Keep successful official installations committed when only post-install probing fails.
- Add release privacy, secret, metadata, version, and Git auditing.
- Add installed cache and manifest consistency checks.
- Redact CLI and MCP stderr before returning diagnostics.

## 0.1.1

- Diagnose plugin manifests, MCP configuration, Node syntax, and MCP startup.
- Add local installation helpers and a compact context audit.
