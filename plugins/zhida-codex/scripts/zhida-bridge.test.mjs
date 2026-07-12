import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEVICE_GRANT_TYPE, ZhidaBridge, parseSSE } from "./zhida-bridge.mjs";

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function sendJSON(response, status, body, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

async function startMockServer() {
  const state = {
    approved: false,
    revoked: 0,
    bearerHeaders: [],
    registrations: 0,
  };
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    if (request.url === "/oauth/register") {
      state.registrations += 1;
      const registration = JSON.parse(body);
      assert.deepEqual(registration.redirect_uris, []);
      assert.ok(registration.grant_types.includes(DEVICE_GRANT_TYPE));
      sendJSON(response, 201, {
        client_id: "bridge-client",
        client_name: registration.client_name,
        redirect_uris: [],
        grant_types: registration.grant_types,
        response_types: [],
        scope: registration.scope,
        token_endpoint_auth_method: "none",
      });
      return;
    }
    if (request.url === "/oauth/device/authorize") {
      const form = new URLSearchParams(body);
      assert.equal(form.get("client_id"), "bridge-client");
      sendJSON(response, 200, {
        device_code: "device-secret",
        user_code: "BCDFG-HJKLM",
        verification_uri: `${state.baseURL}/oauth/device`,
        verification_uri_complete: `${state.baseURL}/oauth/device?user_code=BCDFG-HJKLM`,
        expires_in: 900,
        interval: 5,
      });
      return;
    }
    if (request.url === "/oauth/token") {
      const form = new URLSearchParams(body);
      if (form.get("grant_type") === DEVICE_GRANT_TYPE && !state.approved) {
        sendJSON(response, 400, { error: "authorization_pending", error_description: "pending" });
        return;
      }
      sendJSON(response, 200, {
        access_token: "access-secret",
        refresh_token: "refresh-secret",
        token_type: "Bearer",
        expires_in: 2_592_000,
        scope: "project:read knowledge:read",
      });
      return;
    }
    if (request.url === "/oauth/revoke") {
      state.revoked += 1;
      response.writeHead(200);
      response.end();
      return;
    }
    if (request.url === "/mcp") {
      state.bearerHeaders.push(request.headers.authorization || "");
      if (request.headers.authorization !== "Bearer access-secret") {
        sendJSON(response, 401, { error: "unauthorized" });
        return;
      }
      const message = JSON.parse(body);
      if (message.method === "notifications/initialized") {
        response.writeHead(202);
        response.end();
        return;
      }
      if (message.method === "initialize") {
        sendJSON(response, 200, {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "mock-zhida", version: "1" },
          },
        });
        return;
      }
      if (message.method === "tools/list") {
        sendJSON(response, 200, {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: [{
              name: "remote_echo",
              description: "Echo from Zhida",
              inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
            }],
          },
        });
        return;
      }
      if (message.method === "tools/call" && message.params?.name === "remote_echo") {
        sendJSON(response, 200, {
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: message.params.arguments.text }] },
        });
        return;
      }
      sendJSON(response, 200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not found" } });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  state.baseURL = `http://127.0.0.1:${address.port}`;
  return { server, state };
}

test("bridge completes device flow, proxies MCP, and clears local credentials", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zhida-bridge-test-"));
  const credentialsFile = join(directory, "credentials.json");
  const { server, state } = await startMockServer();
  const notifications = [];
  const bridge = new ZhidaBridge({
    apiBase: state.baseURL,
    credentialsFile,
    output: (message) => notifications.push(message),
    log: () => {},
    browserOpener: () => ({ opened: true, browser: "chrome" }),
  });
  t.after(async () => {
    bridge.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const initialized = await bridge.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });
  assert.equal(initialized.result.serverInfo.name, "zhida-codex-bridge");

  const login = await bridge.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "zhida_auth_login", arguments: {} } });
  assert.equal(login.result.structuredContent.status, "authorization_pending");
  assert.equal(login.result.structuredContent.user_code, "BCDFG-HJKLM");
  assert.equal(login.result.structuredContent.browser, "chrome");
  assert.ok(!JSON.stringify(login).includes("device-secret"));

  const fileMode = (await stat(credentialsFile)).mode & 0o777;
  if (process.platform !== "win32") assert.equal(fileMode, 0o600);
  const pendingState = JSON.parse(await readFile(credentialsFile, "utf8"));
  assert.equal(pendingState.pending.device_code, "device-secret");
  pendingState.pending.next_poll_at = 0;
  await writeFile(credentialsFile, `${JSON.stringify(pendingState, null, 2)}\n`, { mode: 0o600 });
  bridge.close();

  state.approved = true;
  const status = await bridge.handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "zhida_auth_status", arguments: {} } });
  assert.equal(status.result.structuredContent.status, "authorized");
  assert.ok(!JSON.stringify(status).includes("access-secret"));
  assert.ok(notifications.some((message) => message.method === "notifications/tools/list_changed"));

  const tools = await bridge.handleMessage({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} });
  const toolNames = tools.result.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes("zhida_auth_logout"));
  assert.ok(toolNames.includes("remote_echo"));

  const echoed = await bridge.handleMessage({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "remote_echo", arguments: { text: "hello" } },
  });
  assert.equal(echoed.result.content[0].text, "hello");
  assert.ok(state.bearerHeaders.every((header) => header === "Bearer access-secret"));

  const logout = await bridge.handleMessage({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "zhida_auth_logout", arguments: {} } });
  assert.equal(logout.result.structuredContent.status, "logged_out");
  assert.equal(state.revoked, 1);
  const cleared = JSON.parse(await readFile(credentialsFile, "utf8"));
  assert.equal(cleared.access_token, undefined);
  assert.equal(cleared.refresh_token, undefined);
  assert.equal(cleared.client_id, "bridge-client");

  const lateRefresh = await bridge.storeToken({
    access_token: "late-access-secret",
    refresh_token: "late-refresh-secret",
    token_type: "Bearer",
    expires_in: 2_592_000,
  }, "bridge-client", { refreshToken: "refresh-secret" });
  assert.equal(lateRefresh.accepted, false);
  assert.equal(state.revoked, 2);
  const afterLateRefresh = JSON.parse(await readFile(credentialsFile, "utf8"));
  assert.equal(afterLateRefresh.access_token, undefined);
  assert.equal(afterLateRefresh.refresh_token, undefined);
});

test("parseSSE returns JSON-RPC messages", () => {
  const messages = parseSSE("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n\n");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, 1);
});
