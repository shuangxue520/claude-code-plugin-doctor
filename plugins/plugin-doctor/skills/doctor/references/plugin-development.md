# Local Claude Code Plugin Development

Use this reference when creating, installing, repairing, or preparing Claude Code plugins for release.

## Minimal Shape

```text
my-plugin-local-tools/
  .claude-plugin/plugin.json
  .mcp.json
  mcp-server.js
  skills/<skill-name>/SKILL.md
```

Use `.claude-plugin/plugin.json`, not `.codex-plugin/plugin.json`.

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "Short useful description.",
  "author": { "name": "local-tools" }
}
```

```json
{
  "mcpServers": {
    "my_plugin": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/mcp-server.js"],
      "env": {
        "MY_PLUGIN_ROOT": "${CLAUDE_PROJECT_DIR}"
      },
      "alwaysLoad": true
    }
  }
}
```

Use stable snake_case MCP server names; tool names become `mcp__my_plugin__tool_name`.

## MCP Stdio Rules

Claude Code plugin MCP servers may use line-delimited JSON or `Content-Length` framing. Do not rely on a framing mode until it has been tested with the target Claude Code version.

Never print banners, logs, warnings, or debug text to stdout. stdout is MCP JSON only. Use stderr for temporary debugging and remove noisy logs before installing.

Minimal JSONL output:

```js
function write(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}
```

Minimal JSONL input:

```js
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(JSON.parse(line));
    index = buffer.indexOf("\n");
  }
});
```

## JSON Encoding

All JSON files should be UTF-8 without BOM. PowerShell `Set-Content -Encoding UTF8` may write BOM on old versions. Prefer:

```powershell
$encoding = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($path, $text, $encoding)
```

## Local Development And Installation

For a one-session development test, load the plugin directly:

```powershell
claude --plugin-dir <plugin-dir>
```

For persistent installation from a local marketplace, use Claude Code's plugin commands:

```powershell
claude plugin marketplace update local-tools
claude plugin install my-plugin@local-tools --scope user
claude plugin update my-plugin@local-tools --scope user
```

The local plugin data directory is under `%USERPROFILE%\.claude\plugins\data` on Windows and `~/.claude/plugins/data` on Unix-like systems. Do not edit `installed_plugins.json` directly. Claude Code owns installed records and versioned cache paths.

`mcp__plugin_doctor__plugin_install_local` updates the `local-tools` directory marketplace and then delegates installation or update to these official CLI commands.

If Claude shows the plugin as disabled, enable it explicitly:

```powershell
claude plugin enable my-plugin@local-tools
```

## Verification

Run these before claiming the plugin is fixed:

```powershell
node --check <plugin-dir>\mcp-server.js
claude plugin validate <plugin-dir>
claude plugin list
claude mcp list
```

Expected MCP health line:

```text
plugin:<plugin-name>:<server_name> ... Connected
```

## Secret Rules

Do not hardcode API keys in source files, README, or files intended for GitHub. Use environment variables such as `TAVILY_API_KEY` or `.local/` ignored files. If a private key is temporarily placed in `.mcp.json`, never publish or screenshot it.

Avoid committing personal absolute paths. Use placeholders such as `<plugin-dir>`, `%USERPROFILE%`, `$HOME`, or documented environment variables.

## Release Checklist

1. Bump the version in `.claude-plugin/plugin.json` for each pinned release.
2. Prefer one version source. If a marketplace entry also declares a version, it must match the plugin manifest.
3. Run `claude plugin validate <plugin-dir>` and validate the marketplace root when one exists.
4. Run `plugin_release_audit` and resolve every privacy finding.
5. Run the plugin self-test and probe MCP `initialize` plus `tools/list`.
6. Confirm README, license, changelog, privacy, and security guidance are current.
7. Commit intentionally, inspect the final diff, and only then publish.

## Failed Plugin Checklist

1. Run `plugin_check` with `probeMcp: true`.
2. Fix the first failing check.
3. Check JSON validity and BOM.
4. Check `node --check`.
5. Confirm initialize/tools-list returns MCP JSON.
6. When installation is part of the failure, use `checkInstallation: true` to compare the manifest, marketplace source, installed record, and active cache.
7. Confirm runtime command exists in Claude Code's environment.
8. Re-run `claude mcp list`.
