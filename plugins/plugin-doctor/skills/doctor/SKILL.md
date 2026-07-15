---
description: Diagnose, fleet-audit, repair, install, release-audit, and verify local Claude Code plugins. Use when a plugin fails to load, `/mcp` shows failed, versions disagree, a plugin needs safe local installation, MCP stdio framing may be wrong, JSON/BOM may be broken, or a plugin is being prepared for publication.
disable-model-invocation: true
argument-hint: "[plugin path or failure]"
---

# Plugin Doctor

Task: `$ARGUMENTS`

Use this skill before guessing about a failed local plugin.

## Workflow

1. Run `mcp__plugin_doctor__plugin_check` with the plugin directory.
   - When several plugins may be stale or inconsistent, run `mcp__plugin_doctor__plugin_fleet_audit` first.
2. Fix the first concrete failed check. Common fixes are invalid JSON, UTF-8 BOM, noisy stdout, missing runtime commands, bad `.mcp.json`, stale cache versions, or missing marketplace entries.
3. Run `plugin_check` again with `probeMcp: true`.
4. If the plugin is ready but not installed, run `mcp__plugin_doctor__plugin_install_local`.
5. Use `checkInstallation: true` only when diagnosing the installed `local-tools` copy or cache/version mismatch.
6. Before publication, run `mcp__plugin_doctor__plugin_release_audit` with the plugin directory and repository root.
7. Run `claude plugin enable <plugin-name>@local-tools` if `claude plugin list` shows the plugin disabled, then use `/reload-plugins`.

For creating or deeply repairing a plugin, read `references/plugin-development.md`.

## Rules

- Do not hardcode API keys in publishable files.
- Do not edit `installed_plugins.json` by hand; use the official Claude Code plugin CLI.
- Keep stdout reserved for MCP JSON only.
- Accept either line-delimited JSON or Content-Length MCP framing when it probes correctly.
- Use UTF-8 without BOM for JSON files.
- Use stable snake_case MCP server names; they become `mcp__server__tool` prefixes.
