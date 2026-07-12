# Privacy

`plugin-doctor` runs locally and does not upload plugin source or diagnostic
results.

- `plugin_check` reads files inside the requested plugin directory and may
  start MCP commands declared by that plugin.
- `plugin_release_audit` reads text files in the requested repository. It
  reports relative filenames and rule names, never matched secret values.
- `plugin_context_audit` reads local Claude plugin metadata and file sizes.
- `plugin_install_local` copies local plugin files and invokes Claude Code's
  marketplace/install commands. Those commands may contact the source already
  configured for that marketplace.

Paths are restricted to the active project and Claude plugin data/cache directories.
Do not include private source files in a repository merely to audit them.
