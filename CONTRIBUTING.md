# Contributing

Keep changes focused on deterministic Claude Code plugin diagnostics. Avoid
adding broad file-management or arbitrary command-execution tools.

Before submitting a change:

```powershell
node --check .\plugins\plugin-doctor\mcp-server.js
node .\plugins\plugin-doctor\mcp-server.js --self-test
claude plugin validate .\plugins\plugin-doctor
claude plugin validate .
```

Run `plugin_release_audit` against the repository and remove generated files,
private paths, credentials, and local configuration before committing.
