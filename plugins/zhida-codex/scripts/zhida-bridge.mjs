#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const VERSION = "1.0.0";
const PROTOCOL_VERSION = "2025-06-18";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_API_BASE = "https://api.zhida.bot";
const DEFAULT_SCOPES = [
  "project:read",
  "conversation:read",
  "retrieval:read",
  "knowledge:read",
  "knowledge:write",
  "keyword:read",
  "keyword:write",
];

class OAuthError extends Error {
  constructor(code, description, status = 400) {
    super(description || code);
    this.name = "OAuthError";
    this.code = code;
    this.status = status;
  }
}

class AuthorizationRequiredError extends Error {
  constructor(message = "Zhida authorization is required") {
    super(message);
    this.name = "AuthorizationRequiredError";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowMs() {
  return Date.now();
}

function trimBaseURL(value) {
  return String(value || DEFAULT_API_BASE).trim().replace(/\/+$/, "");
}

function stateDirectory(env = process.env) {
  if (env.ZHIDA_STATE_DIR) return env.ZHIDA_STATE_DIR;
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "Zhida Codex");
  if (platform() === "win32") return join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "Zhida Codex");
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "zhida-codex");
}

function credentialsPath(env = process.env) {
  return env.ZHIDA_CREDENTIALS_FILE || join(stateDirectory(env), "credentials.json");
}

async function readJSONFile(path) {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return {};
    throw error;
  }
}

async function writeJSONFile(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporary, 0o600).catch(() => {});
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => {});
}

async function withFileLock(path, operation) {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      try {
        return await operation();
      } finally {
        await rm(lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const info = await stat(lockPath);
        if (nowMs() - info.mtimeMs > 30_000) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError;
      }
      await sleep(50);
    }
  }
  throw new Error("timed out waiting for Zhida credential lock");
}

async function updateState(path, updater) {
  return withFileLock(path, async () => {
    const current = await readJSONFile(path);
    const next = await updater({ ...current });
    await writeJSONFile(path, next);
    return next;
  });
}

function commandExists(command, env = process.env) {
  const pathValue = env.PATH || "";
  const extensions = platform() === "win32" ? (env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const directory of pathValue.split(platform() === "win32" ? ";" : ":")) {
    if (!directory) continue;
    for (const extension of extensions) {
      if (existsSync(join(directory, `${command}${extension}`))) return true;
    }
  }
  return false;
}

function launchDetached(command, args) {
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function openBrowserChromeFirst(url, env = process.env) {
  if (String(env.ZHIDA_NO_BROWSER || "").toLowerCase() === "1" || String(env.ZHIDA_BROWSER || "").toLowerCase() === "none") {
    return { opened: false, browser: "none" };
  }
  const os = platform();
  if (os === "darwin") {
    const chrome = spawnSync("/usr/bin/open", ["-a", "Google Chrome", url], { stdio: "ignore" });
    if (chrome.status === 0) return { opened: true, browser: "chrome" };
    const safari = spawnSync("/usr/bin/open", ["-a", "Safari", url], { stdio: "ignore" });
    if (safari.status === 0) return { opened: true, browser: "safari" };
    const fallback = spawnSync("/usr/bin/open", [url], { stdio: "ignore" });
    return { opened: fallback.status === 0, browser: fallback.status === 0 ? "default" : "none" };
  }
  if (os === "win32") {
    const localAppData = env.LOCALAPPDATA || "";
    const programFiles = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], localAppData].filter(Boolean);
    for (const root of programFiles) {
      const candidate = join(root, "Google", "Chrome", "Application", "chrome.exe");
      if (existsSync(candidate) && launchDetached(candidate, [url])) return { opened: true, browser: "chrome" };
    }
    return { opened: launchDetached("cmd.exe", ["/d", "/s", "/c", "start", "", url]), browser: "default" };
  }
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return { opened: false, browser: "none" };
  for (const command of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    if (commandExists(command, env) && launchDetached(command, [url])) return { opened: true, browser: "chrome" };
  }
  if (commandExists("xdg-open", env) && launchDetached("xdg-open", [url])) return { opened: true, browser: "default" };
  return { opened: false, browser: "none" };
}

async function fetchJSON(url, options = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body = {};
    if (text.trim()) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`invalid JSON response from ${new URL(url).origin}`);
      }
    }
    if (!response.ok) {
      throw new OAuthError(body.error || `http_${response.status}`, body.error_description || `HTTP ${response.status}`, response.status);
    }
    return { body, response };
  } finally {
    clearTimeout(timeout);
  }
}

function formBody(values) {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && String(value) !== "") form.set(key, String(value));
  }
  return form.toString();
}

function tokenState(body, previous = {}) {
  const expiresIn = Number(body.expires_in || 0);
  return {
    ...previous,
    access_token: body.access_token,
    refresh_token: body.refresh_token || previous.refresh_token || "",
    token_type: body.token_type || "Bearer",
    scope: body.scope || previous.scope || "",
    access_expires_at: nowMs() + Math.max(0, expiresIn) * 1000,
    pending: null,
  };
}

function parseSSE(text) {
  const messages = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    messages.push(JSON.parse(data));
  }
  return messages;
}

function localToolResult(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError,
  };
}

function localTools() {
  return [
    {
      name: "zhida_auth_login",
      title: "Connect Zhida account",
      description: "Start or resume Zhida device authorization. Returns a verification link and one-time code without exposing OAuth tokens.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "zhida_auth_status",
      title: "Check Zhida authorization",
      description: "Check whether the current Zhida device authorization has completed.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "zhida_auth_logout",
      title: "Disconnect Zhida account",
      description: "Revoke the active Zhida OAuth token and clear the local bridge credential cache. Browser cookies are not changed.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  ];
}

class ZhidaBridge {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.apiBase = trimBaseURL(options.apiBase || this.env.ZHIDA_API_BASE);
    this.resource = `${this.apiBase}/mcp`;
    this.credentialsFile = options.credentialsFile || credentialsPath(this.env);
    this.output = options.output || ((message) => process.stdout.write(`${JSON.stringify(message)}\n`));
    this.log = options.log || ((message) => process.stderr.write(`[zhida-bridge] ${message}\n`));
    this.browserOpener = options.browserOpener || ((url) => openBrowserChromeFirst(url, this.env));
    this.remoteSessionID = "";
    this.remoteInitialized = false;
    this.remoteInitializePromise = null;
    this.initializeParams = null;
    this.backgroundTimer = null;
    this.closed = false;
  }

  async readState() {
    return readJSONFile(this.credentialsFile);
  }

  async ensureClient() {
    const existing = await this.readState();
    if (existing.client_id) return existing.client_id;
    const next = await withFileLock(this.credentialsFile, async () => {
      const current = await readJSONFile(this.credentialsFile);
      if (current.client_id) return current;
      const { body } = await fetchJSON(`${this.apiBase}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_name: "Zhida Codex Bridge",
          redirect_uris: [],
          grant_types: [DEVICE_GRANT_TYPE, "refresh_token"],
          response_types: [],
          scope: DEFAULT_SCOPES.join(" "),
          token_endpoint_auth_method: "none",
        }),
      });
      const value = { ...current, client_id: body.client_id, api_base: this.apiBase };
      await writeJSONFile(this.credentialsFile, value);
      return value;
    });
    return next.client_id;
  }

  async clearClient() {
    await updateState(this.credentialsFile, () => ({ api_base: this.apiBase }));
  }

  async revokeRawToken(token, clientID) {
    if (!token) return false;
    try {
      await fetchJSON(`${this.apiBase}/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: formBody({ token, client_id: clientID }),
      });
      return true;
    } catch (error) {
      this.log(`remote token revocation failed: ${error.message}`);
      return false;
    }
  }

  async storeToken(body, clientID, guard = {}) {
    let accepted = false;
    const next = await updateState(this.credentialsFile, (current) => {
      if (guard.refreshToken !== undefined && current.refresh_token !== guard.refreshToken) return current;
      if (guard.deviceCode !== undefined && current.pending?.device_code !== guard.deviceCode) return current;
      accepted = true;
      return tokenState(body, {
        ...current,
        client_id: clientID || current.client_id,
        api_base: this.apiBase,
        resource: this.resource,
      });
    });
    if (!accepted) {
      await this.revokeRawToken(body.access_token, clientID);
      return { state: next, accepted: false };
    }
    this.remoteSessionID = "";
    this.remoteInitialized = false;
    return { state: next, accepted: true };
  }

  async clearTokens({ keepClient = true } = {}) {
    await updateState(this.credentialsFile, (current) => ({
      api_base: this.apiBase,
      client_id: keepClient ? current.client_id || "" : "",
    }));
    this.remoteSessionID = "";
    this.remoteInitialized = false;
  }

  async registerAgain() {
    await this.clearClient();
    return this.ensureClient();
  }

  async refreshToken(force = false) {
    const state = await this.readState();
    if (!state.access_token && !state.refresh_token) return null;
    if (!force && state.access_token && Number(state.access_expires_at || 0) > nowMs() + 60_000) return state;
    if (!state.refresh_token || !state.client_id) {
      await this.clearTokens();
      return null;
    }
    try {
      const { body } = await fetchJSON(`${this.apiBase}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: formBody({ grant_type: "refresh_token", refresh_token: state.refresh_token, client_id: state.client_id }),
      });
      const stored = await this.storeToken(body, state.client_id, { refreshToken: state.refresh_token });
      return stored.state?.access_token ? stored.state : null;
    } catch (error) {
      if (error instanceof OAuthError && ["invalid_client", "invalid_grant"].includes(error.code)) {
        const latest = await this.readState();
        if (
          error.code === "invalid_grant"
          && latest.access_token
          && latest.refresh_token
          && latest.refresh_token !== state.refresh_token
          && Number(latest.access_expires_at || 0) > nowMs() + 1_000
        ) {
          return latest;
        }
        await this.clearTokens({ keepClient: error.code !== "invalid_client" });
        return null;
      }
      throw error;
    }
  }

  async ensureAuthorized() {
    return this.refreshToken(false);
  }

  async beginLogin({ openBrowser = true } = {}) {
    const authorized = await this.ensureAuthorized();
    if (authorized?.access_token) return { status: "authorized", message: "Zhida is connected." };

    let state = await this.readState();
    const pending = state.pending;
    if (pending?.device_code && Number(pending.expires_at || 0) > nowMs() + 5_000) {
      const browser = openBrowser ? this.browserOpener(pending.verification_uri_complete || pending.verification_uri) : { opened: false, browser: "none" };
      this.scheduleBackgroundPoll();
      return this.publicPendingState(pending, browser);
    }

    let clientID = await this.ensureClient();
    let body;
    try {
      ({ body } = await fetchJSON(`${this.apiBase}/oauth/device/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: formBody({ client_id: clientID, scope: DEFAULT_SCOPES.join(" "), resource: this.resource }),
      }));
    } catch (error) {
      if (!(error instanceof OAuthError) || error.code !== "invalid_client") throw error;
      clientID = await this.registerAgain();
      ({ body } = await fetchJSON(`${this.apiBase}/oauth/device/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: formBody({ client_id: clientID, scope: DEFAULT_SCOPES.join(" "), resource: this.resource }),
      }));
    }

    const interval = Math.max(5, Number(body.interval || 5));
    const createdPending = {
      device_code: body.device_code,
      user_code: body.user_code,
      verification_uri: body.verification_uri,
      verification_uri_complete: body.verification_uri_complete || body.verification_uri,
      expires_at: nowMs() + Number(body.expires_in || 900) * 1000,
      interval,
      next_poll_at: nowMs() + interval * 1000,
    };
    await updateState(this.credentialsFile, (current) => ({
      ...current,
      api_base: this.apiBase,
      client_id: clientID,
      pending: createdPending,
    }));
    const browser = openBrowser ? this.browserOpener(createdPending.verification_uri_complete) : { opened: false, browser: "none" };
    this.scheduleBackgroundPoll();
    return this.publicPendingState(createdPending, browser);
  }

  publicPendingState(pending, browser = { opened: false, browser: "none" }) {
    return {
      status: "authorization_pending",
      verification_uri: pending.verification_uri,
      verification_uri_complete: pending.verification_uri_complete,
      user_code: pending.user_code,
      expires_at: new Date(Number(pending.expires_at)).toISOString(),
      browser_opened: Boolean(browser.opened),
      browser: browser.browser || "none",
      message: browser.opened
        ? "Complete authorization in the opened browser. The bridge will receive the result automatically."
        : "Open the verification link on any computer or phone. The bridge will receive the result automatically.",
    };
  }

  async pollDeviceAuthorization() {
    const state = await this.readState();
    if (state.access_token && Number(state.access_expires_at || 0) > nowMs() + 1_000) {
      return { status: "authorized", message: "Zhida is connected." };
    }
    const pending = state.pending;
    if (!pending?.device_code || !state.client_id) return { status: "not_connected", message: "Call zhida_auth_login to connect Zhida." };
    if (Number(pending.expires_at || 0) <= nowMs()) {
      await updateState(this.credentialsFile, (current) => ({ ...current, pending: null }));
      return { status: "expired", message: "The device code expired. Start a new login." };
    }
    if (Number(pending.next_poll_at || 0) > nowMs()) return this.publicPendingState(pending);

    try {
      const { body } = await fetchJSON(`${this.apiBase}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: formBody({ grant_type: DEVICE_GRANT_TYPE, device_code: pending.device_code, client_id: state.client_id }),
      });
      const stored = await this.storeToken(body, state.client_id, { deviceCode: pending.device_code });
      if (!stored.accepted) {
        return stored.state?.access_token
          ? { status: "authorized", message: "Zhida is connected." }
          : { status: "not_connected", message: "The local authorization was cancelled." };
      }
      await this.ensureRemoteInitialized().catch((error) => this.log(`remote initialization after login failed: ${error.message}`));
      this.notifyToolsChanged();
      return { status: "authorized", message: "Zhida is connected." };
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error;
      if (error.code === "authorization_pending" || error.code === "slow_down") {
        const interval = Math.min(60, Number(pending.interval || 5) + (error.code === "slow_down" ? 5 : 0));
        const nextPending = { ...pending, interval, next_poll_at: nowMs() + interval * 1000 };
        await updateState(this.credentialsFile, (current) => ({ ...current, pending: nextPending }));
        return this.publicPendingState(nextPending);
      }
      if (["access_denied", "expired_token"].includes(error.code)) {
        await updateState(this.credentialsFile, (current) => ({ ...current, pending: null }));
        return { status: error.code === "access_denied" ? "denied" : "expired", message: error.message };
      }
      if (error.code === "invalid_client") {
        await this.clearTokens({ keepClient: false });
        return { status: "not_connected", message: "The local client registration expired. Start a new login." };
      }
      if (error.code === "invalid_grant") {
        const latest = await this.readState();
        if (latest.access_token) return { status: "authorized", message: "Zhida is connected." };
        await updateState(this.credentialsFile, (current) => ({ ...current, pending: null }));
        return { status: "not_connected", message: "The device authorization is no longer valid. Start a new login." };
      }
      throw error;
    }
  }

  scheduleBackgroundPoll() {
    if (this.backgroundTimer || this.closed) return;
    const run = async () => {
      this.backgroundTimer = null;
      if (this.closed) return;
      try {
        const status = await this.pollDeviceAuthorization();
        if (status.status === "authorization_pending") {
          const state = await this.readState();
          const delay = Math.max(500, Number(state.pending?.next_poll_at || nowMs() + 5_000) - nowMs());
          this.backgroundTimer = setTimeout(run, delay);
          this.backgroundTimer.unref?.();
        }
      } catch (error) {
        this.log(`device authorization poll failed: ${error.message}`);
        this.backgroundTimer = setTimeout(run, 5_000);
        this.backgroundTimer.unref?.();
      }
    };
    this.backgroundTimer = setTimeout(run, 250);
    this.backgroundTimer.unref?.();
  }

  notifyToolsChanged() {
    this.output({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  }

  async revokeAndClear() {
    const state = await this.readState();
    const remoteRevoked = state.access_token ? await this.revokeRawToken(state.access_token, state.client_id) : true;
    await this.clearTokens();
    this.notifyToolsChanged();
    return {
      status: remoteRevoked ? "logged_out" : "local_credentials_cleared",
      remote_revoked: remoteRevoked,
      message: remoteRevoked
        ? "Remote token revoked and local Zhida credentials cleared. Browser cookies were not changed."
        : "Local Zhida credentials were cleared, but remote revocation could not be confirmed. Browser cookies were not changed.",
    };
  }

  async postRemote(message, allowRefresh = true) {
    let state = await this.ensureAuthorized();
    if (!state?.access_token) throw new AuthorizationRequiredError();
    const headers = {
      Authorization: `Bearer ${state.access_token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
    };
    if (this.remoteSessionID) headers["MCP-Session-Id"] = this.remoteSessionID;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    let response;
    try {
      response = await fetch(this.resource, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (response.status === 401 && allowRefresh) {
      state = await this.refreshToken(true);
      if (state?.access_token) return this.postRemote(message, false);
    }
    if (response.status === 401) {
      await this.clearTokens();
      throw new AuthorizationRequiredError("Zhida authorization expired");
    }
    if (!response.ok && response.status !== 202) throw new Error(`Zhida MCP returned HTTP ${response.status}`);
    const sessionID = response.headers.get("mcp-session-id");
    if (sessionID) this.remoteSessionID = sessionID;
    const text = await response.text();
    if (!text.trim()) return null;
    const contentType = response.headers.get("content-type") || "";
    const messages = contentType.includes("text/event-stream") ? parseSSE(text) : [JSON.parse(text)];
    let responseMessage = null;
    for (const item of messages) {
      if (Object.prototype.hasOwnProperty.call(item, "id") && item.id === message.id) responseMessage = item;
      else if (!Object.prototype.hasOwnProperty.call(item, "id")) this.output(item);
    }
    return responseMessage || messages.find((item) => Object.prototype.hasOwnProperty.call(item, "id")) || null;
  }

  async ensureRemoteInitialized() {
    if (this.remoteInitialized) return;
    if (!this.initializeParams) return;
    if (this.remoteInitializePromise) return this.remoteInitializePromise;
    this.remoteInitializePromise = (async () => {
      const response = await this.postRemote({
        jsonrpc: "2.0",
        id: `zhida-bridge-init-${process.pid}`,
        method: "initialize",
        params: this.initializeParams,
      });
      if (!response || response.error) throw new Error(response?.error?.message || "remote MCP initialization failed");
      this.remoteInitialized = true;
      await this.postRemote({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    })();
    try {
      await this.remoteInitializePromise;
    } finally {
      this.remoteInitializePromise = null;
    }
  }

  localInitializeResult() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "zhida-codex-bridge", title: "Zhida Codex", version: VERSION },
      instructions: "Use zhida_auth_login when Zhida is not connected. It returns a verification link and code; OAuth tokens remain local to the bridge.",
    };
  }

  async handleInitialize(message) {
    this.initializeParams = message.params || {};
    const state = await this.ensureAuthorized();
    if (!state?.access_token) return { jsonrpc: "2.0", id: message.id, result: this.localInitializeResult() };
    try {
      const response = await this.postRemote(message);
      if (!response?.result) return { jsonrpc: "2.0", id: message.id, result: this.localInitializeResult() };
      this.remoteInitialized = true;
      response.result.capabilities = response.result.capabilities || {};
      response.result.capabilities.tools = { ...(response.result.capabilities.tools || {}), listChanged: true };
      return response;
    } catch (error) {
      this.log(`remote initialize failed: ${error.message}`);
      return { jsonrpc: "2.0", id: message.id, result: this.localInitializeResult() };
    }
  }

  async handleToolsList(message) {
    const tools = message.params?.cursor ? [] : localTools();
    const state = await this.ensureAuthorized();
    if (state?.access_token) {
      try {
        await this.ensureRemoteInitialized();
        const remote = await this.postRemote(message);
        if (Array.isArray(remote?.result?.tools)) tools.push(...remote.result.tools.filter((tool) => !tools.some((local) => local.name === tool.name)));
      } catch (error) {
        this.log(`remote tools/list failed: ${error.message}`);
      }
    }
    return { jsonrpc: "2.0", id: message.id, result: { tools } };
  }

  async handleLocalTool(name) {
    if (name === "zhida_auth_login") return localToolResult(await this.beginLogin({ openBrowser: true }));
    if (name === "zhida_auth_status") return localToolResult(await this.pollDeviceAuthorization());
    if (name === "zhida_auth_logout") return localToolResult(await this.revokeAndClear());
    return null;
  }

  async handleToolsCall(message) {
    const name = String(message.params?.name || "");
    const local = await this.handleLocalTool(name);
    if (local) return { jsonrpc: "2.0", id: message.id, result: local };

    const state = await this.ensureAuthorized();
    if (!state?.access_token) {
      const login = await this.beginLogin({ openBrowser: true });
      return { jsonrpc: "2.0", id: message.id, result: localToolResult({ ...login, error: "authorization_required" }, true) };
    }
    await this.ensureRemoteInitialized();
    const response = await this.postRemote(message);
    if (name === "logout_current_session" && response?.result && !response.result.isError) {
      await this.clearTokens();
      this.notifyToolsChanged();
    }
    return response || { jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Empty response from Zhida MCP" } };
  }

  async handleMessage(message) {
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return Object.prototype.hasOwnProperty.call(message || {}, "id")
        ? { jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32600, message: "Invalid Request" } }
        : null;
    }
    try {
      if (message.method === "initialize") return this.handleInitialize(message);
      if (message.method === "tools/list") return this.handleToolsList(message);
      if (message.method === "tools/call") return this.handleToolsCall(message);
      if (message.method === "notifications/initialized") {
        if (this.remoteInitialized) await this.postRemote(message);
        return null;
      }
      const state = await this.ensureAuthorized();
      if (!state?.access_token) {
        if (!Object.prototype.hasOwnProperty.call(message, "id")) return null;
        return { jsonrpc: "2.0", id: message.id, error: { code: -32001, message: "Zhida authorization required" } };
      }
      await this.ensureRemoteInitialized();
      return this.postRemote(message);
    } catch (error) {
      this.log(`${message.method} failed: ${error.message}`);
      if (!Object.prototype.hasOwnProperty.call(message, "id")) return null;
      const code = error instanceof AuthorizationRequiredError ? -32001 : -32603;
      return { jsonrpc: "2.0", id: message.id, error: { code, message: error.message } };
    }
  }

  close() {
    this.closed = true;
    if (this.backgroundTimer) clearTimeout(this.backgroundTimer);
    this.backgroundTimer = null;
  }
}

async function main() {
  const bridge = new ZhidaBridge();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let queue = Promise.resolve();
  input.on("line", (line) => {
    queue = queue.then(async () => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        bridge.output({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        return;
      }
      const response = await bridge.handleMessage(message);
      if (response) bridge.output(response);
    }).catch((error) => bridge.log(`request processing failed: ${error.message}`));
  });
  input.on("close", async () => {
    await queue;
    bridge.close();
  });
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) main().catch((error) => {
  process.stderr.write(`[zhida-bridge] fatal: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});

export {
  AuthorizationRequiredError,
  DEVICE_GRANT_TYPE,
  OAuthError,
  PROTOCOL_VERSION,
  VERSION,
  ZhidaBridge,
  credentialsPath,
  localTools,
  openBrowserChromeFirst,
  parseSSE,
  stateDirectory,
};
