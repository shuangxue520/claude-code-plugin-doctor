#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const SERVER_NAME = "plugin_doctor";
const SERVER_VERSION = "0.3.0";
const ROOT = path.resolve(process.env.PLUGIN_DOCTOR_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd());
const CLAUDE_HOME = path.resolve(process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude"));
const PLUGIN_DATA = path.join(CLAUDE_HOME, "plugins", "data");
const PLUGIN_CACHE = path.join(CLAUDE_HOME, "plugins", "cache");
const INSTALLED_FILE = path.join(CLAUDE_HOME, "plugins", "installed_plugins.json");
const MARKETPLACE_FILE = path.join(PLUGIN_DATA, ".claude-plugin", "marketplace.json");

const tools = [
  {
    name: "plugin_check",
    description: "Diagnose a local Claude Code plugin: manifest, official validation, optional MCP startup/tools-list, and optional installation/cache consistency.",
    inputSchema: {
      type: "object",
      properties: {
        pluginPath: { type: "string", description: "Plugin directory. Relative paths resolve from the current project." },
        probeMcp: { type: "boolean", description: "Start MCP servers and call initialize/tools-list. Default true." },
        checkInstallation: { type: "boolean", description: "Check local-tools marketplace, installed record, cache path, and version consistency. Default false." },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 30000 }
      },
      required: ["pluginPath"],
      additionalProperties: false
    }
  },
  {
    name: "plugin_install_local",
    description: "Install or update a plugin through the local-tools marketplace using Claude Code's official CLI. Never edits installed_plugins.json directly.",
    inputSchema: {
      type: "object",
      properties: {
        pluginPath: { type: "string", description: "Source plugin directory." },
        folderName: { type: "string", description: "Optional destination folder name under Claude plugin data." },
        marketplaceName: { type: "string", description: "Registered local marketplace name. Default local-tools." },
        probeAfterInstall: { type: "boolean", description: "Run plugin_check after installing. Default true." }
      },
      required: ["pluginPath"],
      additionalProperties: false
    }
  },
  {
    name: "plugin_release_audit",
    description: "Audit a Claude Code plugin or single-plugin marketplace before publishing: validation, metadata, privacy, secrets, docs, version consistency, and Git state.",
    inputSchema: {
      type: "object",
      properties: {
        pluginPath: { type: "string", description: "Plugin directory." },
        repositoryPath: { type: "string", description: "Optional repository root. Auto-detected for plugins/<name> layouts." },
        requireCleanGit: { type: "boolean", description: "Fail when the repository has uncommitted changes. Default false." }
      },
      required: ["pluginPath"],
      additionalProperties: false
    }
  },
  {
    name: "plugin_context_audit",
    description: "Estimate Claude startup context pressure from CLAUDE.md, installed plugin manifests, skill files, and alwaysLoad MCPs.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "plugin_fleet_audit",
    description: "Audit every plugin in the local-tools marketplace for source, marketplace, installed-record, and cache version consistency, plus stale caches and orphan records.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  }
];

function write(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function ok(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function toolResult(id, text, isError = false) {
  ok(id, { content: [{ type: "text", text }], isError });
}

function intArg(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function redact(value) {
  return String(value || "")
    .replace(/\b(sk|tvly)-[A-Za-z0-9_-]{8,}\b/gi, "$1-[REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_TOKEN]")
    .replace(/((?:api[_-]?key|auth[_-]?token|access[_-]?token|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) return resolved;
  return fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
}

function resolveAllowedPath(value, fieldName = "path") {
  if (!value) throw new Error(`${fieldName} is required`);
  const raw = String(value);
  const resolved = canonicalPath(path.isAbsolute(raw) ? raw : path.join(ROOT, raw));
  const projectRoot = canonicalPath(ROOT);
  const pluginData = canonicalPath(PLUGIN_DATA);
  const pluginCache = canonicalPath(PLUGIN_CACHE);
  if (isInside(resolved, projectRoot) || isInside(resolved, pluginData) || isInside(resolved, pluginCache)) return resolved;
  throw new Error(`Refusing ${fieldName} outside project or Claude plugin directories: ${value}`);
}

function resolvePluginPath(value) {
  return resolveAllowedPath(value, "pluginPath");
}

function readFileInfo(file) {
  if (!fs.existsSync(file)) return { exists: false };
  const buffer = fs.readFileSync(file);
  return {
    exists: true,
    bytes: buffer.length,
    hasBom: buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf,
    text: buffer.toString("utf8")
  };
}

function readJson(file) {
  const info = readFileInfo(file);
  if (!info.exists) return { ok: false, error: "missing", info };
  try {
    return { ok: true, value: JSON.parse(info.text), info };
  } catch (error) {
    return { ok: false, error: error.message, info };
  }
}

function add(checks, ok, label, detail = "") {
  checks.push({ ok: Boolean(ok), label, detail });
}

function replaceVars(value, pluginPath) {
  return String(value)
    .replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginPath)
    .replaceAll("${CLAUDE_PROJECT_DIR}", ROOT)
    .replaceAll("${CLAUDE_HOME}", CLAUDE_HOME);
}

function resolveInvocation(command, args = []) {
  if (process.platform !== "win32") return { command, args };
  const hasPath = path.isAbsolute(command) || command.includes("\\") || command.includes("/");
  const candidates = [];
  if (hasPath) {
    candidates.push(command);
  } else {
    for (const directory of String(process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
      for (const extension of [".exe", ".com", ".ps1", ".cmd", ".bat", ""]) {
        candidates.push(path.join(directory.replace(/^"|"$/g, ""), command + extension));
      }
    }
  }
  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  if (!resolved) return { command, args };
  const extension = path.extname(resolved).toLowerCase();
  if (extension === ".ps1") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolved, ...args]
    };
  }
  if (extension === ".cmd" || extension === ".bat") {
    return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", resolved, ...args] };
  }
  return { command: resolved, args };
}

function runCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs || 8000;
  return new Promise((resolve) => {
    const invocation = resolveInvocation(command, args);
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd || ROOT,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        resolve({ ok: false, code: null, stdout, stderr, error: `timeout after ${timeoutMs}ms` });
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr, error: error.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr, error: code === 0 ? "" : `exit code ${code}` });
    });
    if (options.stdin) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

function frame(message, mode) {
  const json = JSON.stringify(message);
  if (mode === "framed") return `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
  return json + "\n";
}

function parseMessages(output) {
  const messages = [];
  let buffer = Buffer.from(output, "utf8");
  while (buffer.length) {
    const preview = buffer.toString("utf8", 0, Math.min(32, buffer.length));
    if (preview.startsWith("Content-Length:")) {
      const marker = buffer.indexOf("\r\n\r\n");
      if (marker === -1) break;
      const header = buffer.slice(0, marker).toString("utf8");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) break;
      const length = Number.parseInt(match[1], 10);
      const start = marker + 4;
      const end = start + length;
      if (buffer.length < end) break;
      messages.push(JSON.parse(buffer.slice(start, end).toString("utf8")));
      buffer = buffer.slice(end);
    } else {
      const index = buffer.indexOf(0x0a);
      if (index === -1) break;
      const line = buffer.slice(0, index).toString("utf8").trim();
      buffer = buffer.slice(index + 1);
      if (line) messages.push(JSON.parse(line));
    }
  }
  return messages;
}

async function probeMcpServer(serverName, config, pluginPath, timeoutMs, mode) {
  const command = replaceVars(config.command, pluginPath);
  const args = (config.args || []).map((item) => replaceVars(item, pluginPath));
  const invocation = resolveInvocation(command, args);
  const env = {};
  for (const [key, value] of Object.entries(config.env || {})) env[key] = replaceVars(value, pluginPath);
  env.CLAUDE_PLUGIN_ROOT = pluginPath;
  env.CLAUDE_PROJECT_DIR = ROOT;

  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "plugin-doctor", version: SERVER_VERSION } } };
  const initialized = { jsonrpc: "2.0", method: "notifications/initialized", params: {} };
  const list = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
  const stdin = frame(initialize, mode) + frame(initialized, mode) + frame(list, mode);
  return new Promise((resolve) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // Ignore already-closed child processes.
      }
      resolve(result);
    }

    function tryFinish() {
      if (!stdout.trim()) return;
      try {
        const messages = parseMessages(stdout);
        const init = messages.find((item) => item.id === 1);
        const listed = messages.find((item) => item.id === 2);
        if (!listed) return;
        const toolNames = listed && listed.result && Array.isArray(listed.result.tools)
          ? listed.result.tools.map((tool) => tool.name)
          : [];
        finish({
          ok: Boolean(init && !init.error && listed && !listed.error),
          mode,
          serverName,
          tools: toolNames,
          error: (init && init.error && init.error.message) || (listed && listed.error && listed.error.message) || "",
          stderr: stderr.trim()
        });
      } catch {
        // The frame may be incomplete; wait for more output or timeout.
      }
    }

    const timer = setTimeout(() => {
      if (!stdout.trim()) {
        finish({ ok: false, mode, serverName, error: `no MCP stdout before timeout after ${timeoutMs}ms`, stderr: stderr.trim() });
        return;
      }
      try {
        const messages = parseMessages(stdout);
        const listed = messages.find((item) => item.id === 2);
        finish({ ok: false, mode, serverName, error: listed ? "MCP tools/list failed" : "MCP tools/list did not respond", stderr: stderr.trim(), stdoutPreview: stdout.slice(0, 500) });
      } catch (error) {
        finish({ ok: false, mode, serverName, error: `could not parse MCP output: ${error.message}`, stderr: stderr.trim(), stdoutPreview: stdout.slice(0, 500) });
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      tryFinish();
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => finish({ ok: false, mode, serverName, error: error.message, stderr: stderr.trim() }));
    child.on("close", () => {
      if (!settled) tryFinish();
    });
    child.stdin.end(stdin);
  });
}

async function probeAuto(serverName, config, pluginPath, timeoutMs) {
  const jsonl = await probeMcpServer(serverName, config, pluginPath, Math.max(1000, Math.floor(timeoutMs / 2)), "jsonl");
  if (jsonl.ok) return jsonl;
  const framed = await probeMcpServer(serverName, config, pluginPath, Math.max(1000, Math.floor(timeoutMs / 2)), "framed");
  if (framed.ok) return framed;
  return { ...jsonl, framedError: framed.error };
}

function loadPluginMeta(pluginPath) {
  const manifestPath = path.join(pluginPath, ".claude-plugin", "plugin.json");
  const manifest = readJson(manifestPath);
  if (!manifest.ok) throw new Error(`Cannot read plugin manifest: ${manifest.error}`);
  return { manifestPath, manifest: manifest.value };
}

function localKey(name) {
  return `${name}@local-tools`;
}

function installedRecord(name) {
  const installed = readJson(INSTALLED_FILE);
  if (!installed.ok) return null;
  const entries = installed.value.plugins && installed.value.plugins[localKey(name)];
  return Array.isArray(entries) ? entries[0] : null;
}

function marketplaceEntry(name) {
  const market = readJson(MARKETPLACE_FILE);
  if (!market.ok || !Array.isArray(market.value.plugins)) return null;
  return market.value.plugins.find((entry) => entry.name === name) || null;
}

function installedEntries() {
  const installed = readJson(INSTALLED_FILE);
  if (!installed.ok) throw new Error(`Cannot read installed plugin records: ${installed.error}`);
  return installed.value.plugins || {};
}

function cacheVersions(name) {
  const directory = path.join(PLUGIN_CACHE, "local-tools", name);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function pluginFleetAudit() {
  const market = readJson(MARKETPLACE_FILE);
  if (!market.ok || !Array.isArray(market.value.plugins)) {
    throw new Error(`Cannot read local marketplace: ${market.error || "plugins must be an array"}`);
  }
  const installed = installedEntries();
  const rows = [];
  const problems = [];
  const warnings = [];
  const marketNames = new Set();

  for (const entry of market.value.plugins) {
    const name = String(entry.name || "").trim();
    if (!name) continue;
    marketNames.add(name);
    const sourcePath = entry.source ? canonicalPath(path.resolve(PLUGIN_DATA, entry.source)) : "";
    const sourceManifest = sourcePath ? readJson(path.join(sourcePath, ".claude-plugin", "plugin.json")) : { ok: false, error: "source missing" };
    const sourceVersion = sourceManifest.ok ? String(sourceManifest.value.version || "") : "";
    const marketVersion = String(entry.version || "");
    const records = installed[localKey(name)];
    const record = Array.isArray(records) ? records[0] : null;
    const installedVersion = record ? String(record.version || "") : "";
    const installedManifest = record && record.installPath
      ? readJson(path.join(record.installPath, ".claude-plugin", "plugin.json"))
      : { ok: false, error: "not installed" };
    const cacheVersion = installedManifest.ok ? String(installedManifest.value.version || "") : "";
    const expectedVersion = sourceVersion || marketVersion;
    const issues = [];

    if (!entry.source || !sourcePath || !fs.existsSync(sourcePath)) issues.push("marketplace source missing");
    if (!sourceManifest.ok) issues.push("source manifest missing or invalid");
    if (sourceManifest.ok && sourceManifest.value.name !== name) issues.push("source manifest name differs");
    if (marketVersion && sourceVersion && marketVersion !== sourceVersion) issues.push("marketplace version differs from source");
    if (!record) issues.push("not installed");
    if (record && (!record.installPath || !fs.existsSync(record.installPath))) issues.push("installed path missing");
    if (record && expectedVersion && installedVersion !== expectedVersion) issues.push("installed version is stale");
    if (record && installedManifest.ok && cacheVersion !== installedVersion) issues.push("installed manifest differs from record");
    if (record && !installedManifest.ok) issues.push("installed manifest missing or invalid");

    const versions = cacheVersions(name);
    const stale = installedVersion ? versions.filter((version) => version !== installedVersion) : versions;
    if (stale.length) warnings.push(`${name}: stale cache version(s) ${stale.join(", ")}`);
    if (issues.length) problems.push(`${name}: ${issues.join("; ")}`);
    rows.push({ name, sourceVersion, marketVersion, installedVersion, cacheVersion, issues });
  }

  for (const key of Object.keys(installed)) {
    if (!key.endsWith("@local-tools")) continue;
    const name = key.slice(0, -"@local-tools".length);
    if (!marketNames.has(name)) problems.push(`${name}: installed record is not present in local marketplace`);
  }

  const lines = [
    "Plugin fleet audit: local-tools",
    problems.length ? "Status: Needs attention" : "Status: OK",
    `Plugins: ${rows.length}; problems: ${problems.length}; cache warnings: ${warnings.length}`,
    "",
    "Versions (source | marketplace | installed | installed manifest):"
  ];
  for (const row of rows) {
    lines.push(`- ${row.name}: ${row.sourceVersion || "-"} | ${row.marketVersion || "(manifest)"} | ${row.installedVersion || "-"} | ${row.cacheVersion || "-"}${row.issues.length ? " [ATTENTION]" : ""}`);
  }
  if (problems.length) lines.push("", "Problems:", ...problems.map((item) => `- ${item}`));
  if (warnings.length) lines.push("", "Cache warnings:", ...warnings.map((item) => `- ${item}`));
  if (problems.some((item) => item.includes("installed version is stale"))) {
    lines.push("", "Use `claude plugin update <name>@local-tools --scope user` after fixing marketplace/source metadata.");
  }
  return lines.join("\n");
}

async function pluginCheck(args = {}) {
  const pluginPath = resolvePluginPath(args.pluginPath);
  const timeoutMs = intArg(args.timeoutMs, 10000, 1000, 30000);
  const checks = [];
  add(checks, fs.existsSync(pluginPath) && fs.statSync(pluginPath).isDirectory(), "plugin directory exists", pluginPath);

  const manifestPath = path.join(pluginPath, ".claude-plugin", "plugin.json");
  const manifest = readJson(manifestPath);
  add(checks, manifest.info.exists, "manifest exists", manifestPath);
  add(checks, manifest.info.exists && !manifest.info.hasBom, "manifest has no UTF-8 BOM");
  add(checks, manifest.ok, "manifest JSON parses", manifest.error || "");
  const meta = manifest.ok ? manifest.value : {};
  add(checks, Boolean(meta.name), "manifest has name", meta.name || "");
  add(checks, Boolean(meta.version), "manifest has version", meta.version || "");
  add(checks, Boolean(meta.description), "manifest has description", meta.description || "");

  const validation = await runCommand("claude", ["plugin", "validate", pluginPath], { timeoutMs });
  add(
    checks,
    validation.ok,
    "official claude plugin validate",
    validation.ok ? "passed" : redact((validation.stderr || validation.stdout || validation.error || "").trim()).slice(0, 500)
  );

  const mcpPath = path.join(pluginPath, ".mcp.json");
  const mcp = readJson(mcpPath);
  if (mcp.info.exists) {
    add(checks, !mcp.info.hasBom, ".mcp.json has no UTF-8 BOM");
    add(checks, mcp.ok, ".mcp.json parses", mcp.error || "");
  } else {
    const componentDirs = ["skills", "commands", "agents", "hooks"];
    const components = componentDirs.filter((name) => fs.existsSync(path.join(pluginPath, name)));
    add(checks, components.length > 0, ".mcp.json is optional when other plugin components exist", components.join(", ") || "no components found");
  }

  const probes = [];
  if (mcp.ok && mcp.value.mcpServers && typeof mcp.value.mcpServers === "object") {
    const servers = Object.entries(mcp.value.mcpServers);
    add(checks, servers.length > 0, "at least one MCP server is declared", String(servers.length));
    for (const [serverName, config] of servers) {
      add(checks, Boolean(config.command), `${serverName}: command present`, config.command || "");
      const scriptArg = (config.args || []).find((item) => String(item).includes(".js"));
      if (scriptArg) {
        const scriptPath = replaceVars(scriptArg, pluginPath);
        add(checks, fs.existsSync(scriptPath), `${serverName}: JS script exists`, scriptPath);
        if (fs.existsSync(scriptPath)) {
          const syntax = await runCommand("node", ["--check", scriptPath], { timeoutMs });
          add(checks, syntax.ok, `${serverName}: node --check`, redact((syntax.stderr || syntax.error || "").trim()));
        }
      }
      if (args.probeMcp !== false) {
        const probe = await probeAuto(serverName, config, pluginPath, timeoutMs);
        probes.push(probe);
        add(checks, probe.ok, `${serverName}: MCP initialize/tools-list`, probe.ok ? `${probe.tools.length} tools via ${probe.mode}` : `${probe.error || ""}${probe.framedError ? `; framed: ${probe.framedError}` : ""}`);
      }
    }
  }

  if (meta.name && args.checkInstallation) {
    const installed = installedRecord(meta.name);
    const market = marketplaceEntry(meta.name);
    add(checks, Boolean(installed), "installed_plugins has local-tools record", installed ? installed.installPath : "");
    add(checks, Boolean(market), "local marketplace has entry", market ? market.source : "");
    if (installed) {
      add(checks, fs.existsSync(installed.installPath), "installed cache/data path exists", installed.installPath);
      add(checks, !meta.version || installed.version === meta.version, "installed version matches manifest", `${installed.version || "(missing)"} vs ${meta.version || "(missing)"}`);
      if (fs.existsSync(installed.installPath)) {
        const installedManifest = readJson(path.join(installed.installPath, ".claude-plugin", "plugin.json"));
        add(checks, installedManifest.ok, "installed manifest parses", installedManifest.error || "");
        if (installedManifest.ok) {
          add(checks, installedManifest.value.version === installed.version, "installed cache manifest version matches record", `${installedManifest.value.version || "(missing)"} vs ${installed.version || "(missing)"}`);
        }
      }
    }
    if (market) {
      const marketSource = canonicalPath(path.resolve(PLUGIN_DATA, market.source || ""));
      add(checks, Boolean(market.source) && fs.existsSync(marketSource), "local marketplace source exists", market.source || "");
      if (market.version && meta.version) {
        add(checks, market.version === meta.version, "marketplace version matches manifest", `${market.version} vs ${meta.version}`);
      }
    }
  }

  const ok = checks.every((item) => item.ok);
  const lines = [
    `Plugin check: ${pluginPath}`,
    ok ? "Status: OK" : "Status: Needs attention",
    "",
    "Checks:",
    ...checks.map((item) => `${item.ok ? "[ok]" : "[fail]"} ${item.label}${item.detail ? ` - ${item.detail}` : ""}`)
  ];
  if (probes.length) {
    lines.push("", "MCP probes:");
    for (const probe of probes) {
      lines.push(`- ${probe.serverName}: ${probe.ok ? "OK" : "failed"} (${probe.mode || "auto"})${probe.tools ? ` tools=${probe.tools.join(", ")}` : ""}`);
      if (probe.stderr) lines.push(`  stderr: ${redact(probe.stderr).slice(0, 300)}`);
    }
  }
  return lines.join("\n");
}

function writeTextAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporary, text, { encoding: "utf8" });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function writeJsonAtomic(file, value) {
  writeTextAtomic(file, JSON.stringify(value, null, 2) + "\n");
}

function updateLocalMarketplace(pluginPath) {
  const { manifest } = loadPluginMeta(pluginPath);
  const market = readJson(MARKETPLACE_FILE);
  if (!market.ok) throw new Error(`Cannot read local marketplace: ${market.error}`);
  if (!Array.isArray(market.value.plugins)) throw new Error("Local marketplace plugins must be an array");
  const source = `./${path.basename(pluginPath)}`;
  const existing = market.value.plugins.find((entry) => entry.name === manifest.name);
  if (existing) {
    existing.source = source;
    existing.description = manifest.description || "";
    delete existing.version;
  } else {
    market.value.plugins.push({ name: manifest.name, source, description: manifest.description || "" });
  }
  writeJsonAtomic(MARKETPLACE_FILE, market.value);
  return { name: manifest.name, version: manifest.version, source };
}

function restoreDirectory(backupPath, destination, existed) {
  if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
  if (existed) fs.cpSync(backupPath, destination, { recursive: true, force: true });
}

async function pluginInstallLocal(args = {}) {
  const source = resolvePluginPath(args.pluginPath);
  const { manifest } = loadPluginMeta(source);
  const marketplaceName = String(args.marketplaceName || "local-tools").trim();
  if (marketplaceName !== "local-tools") {
    throw new Error("This local installer manages only the local-tools directory marketplace");
  }
  const validation = await runCommand("claude", ["plugin", "validate", source], { timeoutMs: 30000 });
  if (!validation.ok) throw new Error(`Plugin validation failed: ${redact(validation.stderr || validation.stdout || validation.error)}`);

  const safeFolder = String(args.folderName || path.basename(source)).replace(/[^a-zA-Z0-9._-]/g, "-");
  if (!safeFolder || safeFolder === "." || safeFolder === "..") throw new Error("folderName is invalid");
  const dest = canonicalPath(path.join(PLUGIN_DATA, safeFolder));
  if (!isInside(dest, canonicalPath(PLUGIN_DATA))) throw new Error("Destination escaped Claude plugin data");

  const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-doctor-install-"));
  const backupPlugin = path.join(backupRoot, "plugin");
  const destinationExisted = fs.existsSync(dest);
  const marketplaceText = fs.readFileSync(MARKETPLACE_FILE, "utf8");
  const sameDirectory = canonicalPath(source) === canonicalPath(dest);
  let installationCommitted = false;
  if (destinationExisted && !sameDirectory) fs.cpSync(dest, backupPlugin, { recursive: true, force: true });

  try {
    if (!sameDirectory) {
      if (destinationExisted) fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(source, dest, { recursive: true, force: true });
    }
    const local = updateLocalMarketplace(dest);
    const refreshed = await runCommand("claude", ["plugin", "marketplace", "update", marketplaceName], { timeoutMs: 30000 });
    if (!refreshed.ok) throw new Error(`Marketplace update failed: ${redact(refreshed.stderr || refreshed.stdout || refreshed.error)}`);

    const key = `${local.name}@${marketplaceName}`;
    const command = installedRecord(local.name) ? "update" : "install";
    const installed = await runCommand("claude", ["plugin", command, key, "--scope", "user"], { timeoutMs: 30000 });
    if (!installed.ok) throw new Error(`Claude plugin ${command} failed: ${redact(installed.stderr || installed.stdout || installed.error)}`);
    installationCommitted = true;

    const record = installedRecord(local.name);
    const lines = [
      `Plugin ${command} completed through Claude Code: ${key}`,
      `Version: ${record && record.version ? record.version : local.version || "(resolved by Claude Code)"}`,
      `Marketplace source: ${local.source}`,
      "Restart Claude Code or run /reload-plugins to activate the new cache."
    ];
    if (args.probeAfterInstall !== false && record && record.installPath) {
      try {
        lines.push("", await pluginCheck({ pluginPath: record.installPath, probeMcp: true, checkInstallation: true }));
      } catch (error) {
        lines.push("", `Warning: installation succeeded, but post-install probing failed: ${redact(error.message)}`);
      }
    }
    return lines.join("\n");
  } catch (error) {
    if (!installationCommitted) {
      writeTextAtomic(MARKETPLACE_FILE, marketplaceText);
      if (!sameDirectory) restoreDirectory(backupPlugin, dest, destinationExisted);
      await runCommand("claude", ["plugin", "marketplace", "update", marketplaceName], { timeoutMs: 30000 });
    }
    throw error;
  } finally {
    fs.rmSync(backupRoot, { recursive: true, force: true });
  }
}

const RELEASE_SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", "coverage"]);
const RELEASE_TEXT_EXTENSIONS = new Set([
  "", ".json", ".jsonl", ".md", ".txt", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
  ".py", ".ps1", ".sh", ".cmd", ".bat", ".toml", ".yaml", ".yml", ".ini", ".cfg", ".xml"
]);

function collectReleaseFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && RELEASE_SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        files.push({ path: fullPath, symlink: true, bytes: 0 });
      } else if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        const bytes = fs.statSync(fullPath).size;
        files.push({ path: fullPath, symlink: false, bytes });
      }
    }
  }
  return files;
}

function releasePrivacyFindings(repositoryPath) {
  const findings = [];
  const sensitiveNames = new Set([".env", ".env.local", "settings.json", "installed_plugins.json", "credentials.json"]);
  for (const file of collectReleaseFiles(repositoryPath)) {
    const relative = path.relative(repositoryPath, file.path).replaceAll("\\", "/");
    if (file.symlink) {
      findings.push({ file: relative, rule: "symlink requires manual review" });
      continue;
    }
    if (sensitiveNames.has(path.basename(file.path).toLowerCase())) {
      findings.push({ file: relative, rule: "sensitive local filename" });
    }
    if (file.bytes > 1024 * 1024 || !RELEASE_TEXT_EXTENSIONS.has(path.extname(file.path).toLowerCase())) continue;
    const text = fs.readFileSync(file.path, "utf8");
    const rules = [
      [/(?:[A-Z]:\\Users\\[^\\\s"'<>]+|\/Users\/[^/\s"'<>]+|\/home\/[^/\s"'<>]+)/, "personal home path"],
      [/[A-Z]:\\[A-Za-z0-9._ -](?:[^\r\n"'<>]|\\ )*/, "absolute Windows path"],
      [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i, "private key material"],
      [/\b(?:sk|tvly)-[A-Za-z0-9_-]{12,}\b/i, "API token-like value"],
      [/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{8,}\b/, "compound token-like value"],
      [/["']?(?:api[_-]?key|auth[_-]?token|access[_-]?token|secret)["']?\s*[:=]\s*["'][^"'\r\n]{8,}["']/i, "assigned secret-like value"]
    ];
    for (const [pattern, rule] of rules) {
      if (pattern.test(text)) findings.push({ file: relative, rule });
    }
  }
  return findings;
}

function detectRepositoryPath(pluginPath, explicitPath) {
  if (explicitPath) return resolveAllowedPath(explicitPath, "repositoryPath");
  const parent = path.dirname(pluginPath);
  if (path.basename(parent).toLowerCase() === "plugins") {
    const candidate = path.dirname(parent);
    if (fs.existsSync(path.join(candidate, ".claude-plugin", "marketplace.json"))) return candidate;
  }
  return pluginPath;
}

async function pluginReleaseAudit(args = {}) {
  const pluginPath = resolvePluginPath(args.pluginPath);
  const repositoryPath = detectRepositoryPath(pluginPath, args.repositoryPath);
  const checks = [];
  const warnings = [];
  const { manifest } = loadPluginMeta(pluginPath);

  const pluginValidation = await runCommand("claude", ["plugin", "validate", pluginPath], { timeoutMs: 30000 });
  add(checks, pluginValidation.ok, "plugin passes official validation", pluginValidation.ok ? "passed" : redact(pluginValidation.stderr || pluginValidation.stdout || pluginValidation.error).trim().slice(0, 500));
  add(checks, fs.existsSync(path.join(repositoryPath, "README.md")), "repository README exists", "README.md");
  const license = ["LICENSE", "LICENSE.md", "LICENSE.txt"].find((name) => fs.existsSync(path.join(repositoryPath, name)));
  add(checks, Boolean(license), "repository license exists", license || "");

  const marketplacePath = path.join(repositoryPath, ".claude-plugin", "marketplace.json");
  if (fs.existsSync(marketplacePath)) {
    const marketplaceValidation = await runCommand("claude", ["plugin", "validate", repositoryPath], { timeoutMs: 30000 });
    add(checks, marketplaceValidation.ok, "marketplace passes official validation", marketplaceValidation.ok ? "passed" : redact(marketplaceValidation.stderr || marketplaceValidation.stdout || marketplaceValidation.error).trim().slice(0, 500));
    const marketplace = readJson(marketplacePath);
    const entry = marketplace.ok && Array.isArray(marketplace.value.plugins)
      ? marketplace.value.plugins.find((item) => item.name === manifest.name)
      : null;
    add(checks, Boolean(entry), "marketplace lists this plugin", manifest.name || "");
    if (entry && entry.version && manifest.version) {
      add(checks, entry.version === manifest.version, "marketplace version matches plugin manifest", `${entry.version} vs ${manifest.version}`);
      if (entry.version === manifest.version) warnings.push("Version is declared in both plugin.json and marketplace.json; keep one source of truth when practical.");
    }
  } else {
    warnings.push("No repository marketplace manifest found; this is fine for a standalone plugin but users cannot install it as a marketplace repository.");
  }

  const privacyFindings = releasePrivacyFindings(repositoryPath);
  add(checks, privacyFindings.length === 0, "privacy and secret scan has no findings", privacyFindings.length ? `${privacyFindings.length} finding(s)` : "");

  const git = await runCommand("git", ["-C", repositoryPath, "status", "--short"], { timeoutMs: 10000 });
  if (git.ok) {
    const dirty = Boolean(git.stdout.trim());
    if (args.requireCleanGit) add(checks, !dirty, "Git worktree is clean", dirty ? "uncommitted changes" : "");
    else if (dirty) warnings.push("Git worktree has uncommitted changes; commit intentionally before publishing.");
  } else {
    warnings.push("Repository is not initialized as Git yet.");
  }

  const ready = checks.every((item) => item.ok);
  const lines = [
    `Plugin release audit: ${manifest.name || path.basename(pluginPath)}@${manifest.version || "(unversioned)"}`,
    ready ? "Status: Ready" : "Status: Needs attention",
    "",
    "Checks:",
    ...checks.map((item) => `${item.ok ? "[ok]" : "[fail]"} ${item.label}${item.detail ? ` - ${item.detail}` : ""}`)
  ];
  if (privacyFindings.length) {
    lines.push("", "Privacy findings:");
    for (const finding of privacyFindings.slice(0, 30)) lines.push(`- ${finding.file}: ${finding.rule}`);
    if (privacyFindings.length > 30) lines.push(`- ... ${privacyFindings.length - 30} more finding(s)`);
  }
  if (warnings.length) lines.push("", "Warnings:", ...warnings.map((warning) => `- ${warning}`));
  return lines.join("\n");
}

function fileStats(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8");
  return { file, bytes: Buffer.byteLength(text, "utf8"), lines: text.split(/\r?\n/).length };
}

function pluginContextAudit() {
  const rows = [];
  const claudeMd = fileStats(path.join(CLAUDE_HOME, "CLAUDE.md"));
  const installed = readJson(INSTALLED_FILE);
  const plugins = installed.ok && installed.value.plugins ? installed.value.plugins : {};
  for (const [key, entries] of Object.entries(plugins)) {
    const entry = Array.isArray(entries) ? entries[0] : null;
    if (!entry || !entry.installPath) continue;
    const pluginPath = entry.installPath;
    const manifest = readJson(path.join(pluginPath, ".claude-plugin", "plugin.json"));
    const mcp = readJson(path.join(pluginPath, ".mcp.json"));
    const skillFiles = fs.existsSync(path.join(pluginPath, "skills"))
      ? fs.readdirSync(path.join(pluginPath, "skills"), { recursive: true }).filter((name) => String(name).endsWith("SKILL.md"))
      : [];
    const skillBytes = skillFiles.reduce((sum, name) => {
      const stat = fs.statSync(path.join(pluginPath, "skills", name));
      return sum + stat.size;
    }, 0);
    const serverCount = mcp.ok && mcp.value.mcpServers ? Object.keys(mcp.value.mcpServers).length : 0;
    const alwaysLoad = mcp.ok && mcp.value.mcpServers
      ? Object.values(mcp.value.mcpServers).filter((server) => server.alwaysLoad).length
      : 0;
    rows.push({
      key,
      version: entry.version,
      manifestBytes: manifest.info && manifest.info.bytes ? manifest.info.bytes : 0,
      skillBytes,
      skillFiles: skillFiles.length,
      serverCount,
      alwaysLoad
    });
  }
  rows.sort((a, b) => (b.skillBytes + b.manifestBytes) - (a.skillBytes + a.manifestBytes));
  const lines = [
    "Context audit:",
    claudeMd ? `CLAUDE.md: ${claudeMd.bytes} bytes, ${claudeMd.lines} lines` : "CLAUDE.md: missing",
    "",
    "Installed plugins:",
    ...rows.map((row) => `- ${row.key} v${row.version}: skills=${row.skillFiles}/${row.skillBytes}B, manifest=${row.manifestBytes}B, MCP=${row.serverCount}, alwaysLoad=${row.alwaysLoad}`),
    "",
    "Notes:",
    "- Biggest startup wins usually come from shortening CLAUDE.md and disabling rarely-used alwaysLoad MCPs.",
    "- Skill body bytes matter when the skill triggers; skill descriptions and tool schemas matter earlier."
  ];
  return lines.join("\n");
}

async function callTool(name, args) {
  if (name === "plugin_check") return pluginCheck(args);
  if (name === "plugin_install_local") return pluginInstallLocal(args);
  if (name === "plugin_release_audit") return pluginReleaseAudit(args);
  if (name === "plugin_context_audit") return pluginContextAudit(args);
  if (name === "plugin_fleet_audit") return pluginFleetAudit(args);
  throw new Error(`Unknown tool: ${name}`);
}

async function handle(message) {
  const id = message.id;
  try {
    if (message.method === "initialize") {
      ok(id, {
        protocolVersion: message.params && message.params.protocolVersion ? message.params.protocolVersion : "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
      });
      return;
    }
    if (message.method === "notifications/initialized") return;
    if (message.method === "ping") {
      ok(id, {});
      return;
    }
    if (message.method === "tools/list") {
      ok(id, { tools });
      return;
    }
    if (message.method === "tools/call") {
      const name = message.params && message.params.name;
      const args = message.params && message.params.arguments ? message.params.arguments : {};
      toolResult(id, await callTool(name, args));
      return;
    }
    if (id !== undefined) write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  } catch (error) {
    if (id !== undefined) toolResult(id, `Error: ${error.message}`, true);
  }
}

function createParser(onMessage) {
  let buffer = Buffer.alloc(0);
  function parseLine() {
    const index = buffer.indexOf(0x0a);
    if (index === -1) return false;
    const line = buffer.slice(0, index).toString("utf8").trim();
    buffer = buffer.slice(index + 1);
    if (line) onMessage(JSON.parse(line));
    return true;
  }
  function parseFrame() {
    const marker = buffer.indexOf("\r\n\r\n");
    if (marker === -1) return false;
    const header = buffer.slice(0, marker).toString("utf8");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) throw new Error("Missing Content-Length header");
    const length = Number.parseInt(match[1], 10);
    const start = marker + 4;
    const end = start + length;
    if (buffer.length < end) return false;
    onMessage(JSON.parse(buffer.slice(start, end).toString("utf8")));
    buffer = buffer.slice(end);
    return true;
  }
  return (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    while (buffer.length) {
      const preview = buffer.toString("utf8", 0, Math.min(buffer.length, 32));
      const parsed = preview.startsWith("Content-Length:") ? parseFrame() : parseLine();
      if (!parsed) break;
    }
  };
}

async function selfTest() {
  const check = await pluginCheck({ pluginPath: __dirname, probeMcp: false });
  const audit = pluginContextAudit();
  const fleet = pluginFleetAudit();
  const temporary = fs.mkdtempSync(path.join(ROOT, ".plugin-doctor-self-test-"));
  try {
    fs.mkdirSync(path.join(temporary, ".claude-plugin"), { recursive: true });
    fs.mkdirSync(path.join(temporary, "skills", "sample"), { recursive: true });
    writeJsonAtomic(path.join(temporary, ".claude-plugin", "plugin.json"), {
      name: "plugin-doctor-skill-only-test",
      version: "0.0.0",
      description: "Temporary skill-only validation fixture."
    });
    writeTextAtomic(
      path.join(temporary, "skills", "sample", "SKILL.md"),
      "---\ndescription: Temporary self-test skill.\ndisable-model-invocation: true\n---\n\n# Sample\n"
    );
    const skillOnly = await pluginCheck({ pluginPath: temporary, probeMcp: true });
    const constructedHomePath = ["C:", "Users", "example", "private.txt"].join("\\");
    writeTextAtomic(path.join(temporary, "privacy-fixture.txt"), constructedHomePath);
    const privacy = releasePrivacyFindings(temporary);
    return {
      server: `${SERVER_NAME}@${SERVER_VERSION}`,
      root: ROOT,
      tools: tools.map((tool) => tool.name),
      checked: check.includes("Plugin check"),
      skillOnlyChecked: skillOnly.includes("Status: OK") && skillOnly.includes(".mcp.json is optional"),
      privacyScanChecked: privacy.some((item) => item.rule === "personal home path"),
      audited: audit.includes("Context audit"),
      fleetAudited: fleet.includes("Plugin fleet audit")
    };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv.includes("--self-test")) {
  selfTest()
    .then((result) => process.stdout.write(JSON.stringify(result, null, 2) + "\n"))
    .catch((error) => {
      process.stderr.write(error.stack || error.message);
      process.exitCode = 1;
    });
} else {
  let queue = Promise.resolve();
  const parse = createParser((message) => {
    queue = queue.then(() => handle(message)).catch((error) => {
      write({ jsonrpc: "2.0", id: message && message.id !== undefined ? message.id : null, error: { code: -32603, message: error.message } });
    });
  });
  process.stdin.on("data", parse);
  // Drain any in-flight request before exiting so a close mid-request keeps its reply.
  process.stdin.on("end", () => { Promise.resolve(queue).then(() => process.exit(0)); });
}
