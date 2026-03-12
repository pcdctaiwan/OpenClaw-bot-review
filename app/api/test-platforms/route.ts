import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { OPENCLAW_CONFIG_PATH, OPENCLAW_HOME } from "@/lib/openclaw-paths";
const CONFIG_PATH = OPENCLAW_CONFIG_PATH;

function resolveSecretRef(value: any): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  try {
    // env: read from environment variable
    if (value.source === "env" && value.id) {
      return process.env[value.id] || null;
    }
    // file: read from file path
    if (value.source === "file" && value.id) {
      return fs.readFileSync(value.id, "utf-8").trim() || null;
    }
    // exec + keychain: macOS Keychain (security command)
    if (value.source === "exec" && value.provider === "keychain" && value.id) {
      if (process.platform !== "darwin") return null;
      const result = execSync(`security find-generic-password -a ${JSON.stringify(value.id)} -w`, { encoding: "utf8" }).trim();
      return result || null;
    }
    // exec + 1password: op CLI
    if (value.source === "exec" && value.provider === "1password" && value.id) {
      const result = execSync(`op read ${JSON.stringify(value.id)}`, { encoding: "utf8" }).trim();
      return result || null;
    }
    // exec + pass: Unix pass store
    if (value.source === "exec" && value.provider === "pass" && value.id) {
      const result = execSync(`pass show ${JSON.stringify(value.id)}`, { encoding: "utf8" }).split("\n")[0].trim();
      return result || null;
    }
  } catch {}
  return null;
}
const QQBOT_TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const QQBOT_API_BASE = "https://api.sgroup.qq.com";

interface PlatformTestResult {
  agentId: string;
  platform: string;
  accountId?: string;
  ok: boolean;
  detail?: string;
  error?: string;
  elapsed: number;
}

// Find the most recent feishu DM user open_id for a given agent
// Each feishu app has its own open_id namespace, so we must use per-agent open_ids
function getFeishuDmUser(agentId: string): string | null {
  try {
    const sessionsPath = path.join(OPENCLAW_HOME, `agents/${agentId}/sessions/sessions.json`);
    const raw = fs.readFileSync(sessionsPath, "utf-8");
    const sessions = JSON.parse(raw);
    let bestId: string | null = null;
    let bestTime = 0;
    for (const [key, val] of Object.entries(sessions)) {
      const m = key.match(/^agent:[^:]+:feishu:direct:(ou_[a-f0-9]+)$/);
      if (m) {
        const updatedAt = (val as any).updatedAt || 0;
        if (updatedAt > bestTime) {
          bestTime = updatedAt;
          bestId = m[1];
        }
      }
    }
    return bestId;
  } catch {
    return null;
  }
}

// Feishu: get token → verify bot info → send a real DM
async function testFeishu(
  agentId: string,
  accountId: string,
  appId: string,
  appSecret: string,
  domain: string,
  testUserId: string | null
): Promise<PlatformTestResult> {
  const baseUrl = domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
  const startTime = Date.now();

  try {
    // Step 1: get tenant_access_token
    const tokenResp = await fetch(
      `${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        signal: AbortSignal.timeout(15000),
      }
    );

    const tokenData = await tokenResp.json();
    if (tokenData.code !== 0 || !tokenData.tenant_access_token) {
      return {
        agentId, platform: "feishu", accountId, ok: false,
        error: `Token failed: ${tokenData.msg || JSON.stringify(tokenData)}`,
        elapsed: Date.now() - startTime,
      };
    }

    const token = tokenData.tenant_access_token;

    // Step 2: verify bot info
    const botResp = await fetch(`${baseUrl}/open-apis/bot/v3/info/`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });

    const botData = await botResp.json();
    if (botData.code !== 0 || !botData.bot) {
      return {
        agentId, platform: "feishu", accountId, ok: false,
        error: `Bot API error: ${botData.msg || JSON.stringify(botData)}`,
        elapsed: Date.now() - startTime,
      };
    }

    const botName = botData.bot.bot_name || accountId;

    // Step 3: send a real DM to test user
    if (!testUserId) {
      return {
        agentId, platform: "feishu", accountId, ok: true,
        detail: `${botName} (bot reachable, no DM session found)`,
        elapsed: Date.now() - startTime,
      };
    }

    const now = new Date().toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai" });
    const msgResp = await fetch(
      `${baseUrl}/open-apis/im/v1/messages?receive_id_type=open_id`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          receive_id: testUserId,
          msg_type: "text",
          content: JSON.stringify({ text: `[Platform Test] ${botName} 联通测试 ✅ (${now})` }),
        }),
        signal: AbortSignal.timeout(15000),
      }
    );

    const msgData = await msgResp.json();
    const elapsed = Date.now() - startTime;

    if (msgData.code === 0) {
      return {
        agentId, platform: "feishu", accountId, ok: true,
        detail: `${botName} → DM sent (${elapsed}ms)`,
        elapsed,
      };
    } else {
      return {
        agentId, platform: "feishu", accountId, ok: false,
        error: `Send DM failed: ${msgData.msg || JSON.stringify(msgData)}`,
        elapsed,
      };
    }
  } catch (err: any) {
    return {
      agentId, platform: "feishu", accountId, ok: false,
      error: err.message,
      elapsed: Date.now() - startTime,
    };
  }
}

// Discord: call /users/@me then send a DM to test user
async function testDiscord(
  agentId: string,
  botToken: string,
  testUserId: string | null
): Promise<PlatformTestResult> {
  const startTime = Date.now();

  try {
    const meResp = await fetch("https://discord.com/api/v10/users/@me", {
      method: "GET",
      headers: { Authorization: `Bot ${botToken}` },
      signal: AbortSignal.timeout(15000),
    });

    const meData = await meResp.json();
    if (!meResp.ok || !meData.id) {
      return {
        agentId, platform: "discord", ok: false,
        error: `Discord API error: ${meData.message || JSON.stringify(meData)}`,
        elapsed: Date.now() - startTime,
      };
    }

    const botName = `${meData.username}#${meData.discriminator || "0"}`;

    if (!testUserId) {
      return {
        agentId, platform: "discord", ok: true,
        detail: `${botName} (bot reachable, no test user for DM)`,
        elapsed: Date.now() - startTime,
      };
    }

    // Create DM channel
    const dmChanResp = await fetch("https://discord.com/api/v10/users/@me/channels", {
      method: "POST",
      headers: {
        Authorization: `Bot ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ recipient_id: testUserId }),
      signal: AbortSignal.timeout(15000),
    });

    const dmChan = await dmChanResp.json();
    if (!dmChanResp.ok || !dmChan.id) {
      return {
        agentId, platform: "discord", ok: false,
        error: `Create DM channel failed: ${dmChan.message || JSON.stringify(dmChan)}`,
        elapsed: Date.now() - startTime,
      };
    }

    const now = new Date().toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai" });
    const msgResp = await fetch(
      `https://discord.com/api/v10/channels/${dmChan.id}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: `[Platform Test] ${botName} connectivity test ✅ (${now})`,
        }),
        signal: AbortSignal.timeout(15000),
      }
    );

    const msgData = await msgResp.json();
    const elapsed = Date.now() - startTime;

    if (msgResp.ok && msgData.id) {
      return {
        agentId, platform: "discord", ok: true,
        detail: `${botName} → DM sent (${elapsed}ms)`,
        elapsed,
      };
    } else {
      return {
        agentId, platform: "discord", ok: false,
        error: `Send DM failed: ${msgData.message || JSON.stringify(msgData)}`,
        elapsed,
      };
    }
  } catch (err: any) {
    return {
      agentId, platform: "discord", ok: false,
      error: err.message,
      elapsed: Date.now() - startTime,
    };
  }
}

// Find the most recent telegram DM chat_id for a given agent
function getTelegramDmUser(agentId: string): string | null {
  try {
    const sessionsPath = path.join(OPENCLAW_HOME, `agents/${agentId}/sessions/sessions.json`);
    const raw = fs.readFileSync(sessionsPath, "utf-8");
    const sessions = JSON.parse(raw);
    let bestId: string | null = null;
    let bestTime = 0;
    for (const [key, val] of Object.entries(sessions)) {
      const m = key.match(/^agent:[^:]+:telegram:direct:(.+)$/);
      if (m) {
        const updatedAt = (val as any).updatedAt || 0;
        if (updatedAt > bestTime) {
          bestTime = updatedAt;
          bestId = m[1];
        }
      }
    }
    return bestId;
  } catch {
    return null;
  }
}

// Telegram: call /getMe to verify bot, then send test DM
async function testTelegram(
  agentId: string,
  botToken: string,
  testChatId: string | null
): Promise<PlatformTestResult> {
  const startTime = Date.now();

  try {
    const meResp = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
      method: "GET",
      signal: AbortSignal.timeout(15000),
    });

    const meData = await meResp.json();

    if (!meResp.ok || !meData.ok || !meData.result) {
      return {
        agentId, platform: "telegram", ok: false,
        error: `Telegram API error: ${meData.description || JSON.stringify(meData)}`,
        elapsed: Date.now() - startTime,
      };
    }

    const botName = meData.result.username ? `@${meData.result.username}` : meData.result.first_name;

    if (!testChatId) {
      return {
        agentId, platform: "telegram", ok: true,
        detail: `${botName} (bot reachable, no DM session found)`,
        elapsed: Date.now() - startTime,
      };
    }

    // Send test message
    const now = new Date().toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai" });
    const msgResp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: testChatId,
        text: `[Platform Test] ${botName} 联通测试 ✅ (${now})`,
      }),
      signal: AbortSignal.timeout(15000),
    });

    const msgData = await msgResp.json();
    const elapsed = Date.now() - startTime;

    if (msgData.ok) {
      return {
        agentId, platform: "telegram", ok: true,
        detail: `${botName} → DM sent (${elapsed}ms)`,
        elapsed,
      };
    } else {
      return {
        agentId, platform: "telegram", ok: false,
        error: `Send DM failed: ${msgData.description || JSON.stringify(msgData)}`,
        elapsed,
      };
    }
  } catch (err: any) {
    return {
      agentId, platform: "telegram", ok: false,
      error: err.message,
      elapsed: Date.now() - startTime,
    };
  }
}

// Find the most recent whatsapp DM user for a given agent
function getWhatsappDmUser(agentId: string): string | null {
  try {
    const sessionsPath = path.join(OPENCLAW_HOME, `agents/${agentId}/sessions/sessions.json`);
    const raw = fs.readFileSync(sessionsPath, "utf-8");
    const sessions = JSON.parse(raw);
    let bestId: string | null = null;
    let bestTime = 0;
    for (const [key, val] of Object.entries(sessions)) {
      const m = key.match(/^agent:[^:]+:whatsapp:direct:(.+)$/);
      if (m) {
        const updatedAt = (val as any).updatedAt || 0;
        if (updatedAt > bestTime) {
          bestTime = updatedAt;
          bestId = m[1];
        }
      }
    }
    return bestId;
  } catch {
    return null;
  }
}

function getWhatsappAllowlistUser(whatsappConfig: any): string | null {
  const list = Array.isArray(whatsappConfig?.allowFrom)
    ? whatsappConfig.allowFrom
    : Array.isArray(whatsappConfig?.dm?.allowFrom)
      ? whatsappConfig.dm.allowFrom
      : [];
  const first = list.find((v: any) => typeof v === "string" && v.trim().length > 0);
  return first ? first.trim() : null;
}

// Find the most recent qqbot DM user for a given agent
function getQqbotDmUser(agentId: string): string | null {
  try {
    const sessionsPath = path.join(OPENCLAW_HOME, `agents/${agentId}/sessions/sessions.json`);
    const raw = fs.readFileSync(sessionsPath, "utf-8");
    const sessions = JSON.parse(raw);
    let bestId: string | null = null;
    let bestTime = 0;
    for (const [key, val] of Object.entries(sessions)) {
      const m = key.match(/^agent:[^:]+:qqbot:direct:(.+)$/);
      if (m) {
        const updatedAt = (val as any).updatedAt || 0;
        if (updatedAt > bestTime) {
          bestTime = updatedAt;
          bestId = m[1];
        }
      }
    }
    return bestId;
  } catch {
    return null;
  }
}

function getQqbotAllowlistUser(qqbotConfig: any): string | null {
  const list = Array.isArray(qqbotConfig?.allowFrom)
    ? qqbotConfig.allowFrom
    : Array.isArray(qqbotConfig?.dm?.allowFrom)
      ? qqbotConfig.dm.allowFrom
      : [];
  const first = list.find((v: any) => typeof v === "string" && v.trim().length > 0);
  return first ? first.trim() : null;
}

function normalizeQqbotTarget(target: string | null): string | null {
  if (!target) return null;
  const raw = target.trim();
  if (!raw || raw === "*") return null;

  const full = raw.match(/^qqbot:(c2c|group|channel):(.+)$/i);
  if (full) {
    return `qqbot:${full[1].toLowerCase()}:${full[2].toUpperCase()}`;
  }

  const typed = raw.match(/^(c2c|group|channel):(.+)$/i);
  if (typed) {
    return `qqbot:${typed[1].toLowerCase()}:${typed[2].toUpperCase()}`;
  }

  return `qqbot:c2c:${raw.toUpperCase()}`;
}

function resolveQqbotCredentials(qqbotConfig: any): { accountId: string; appId: string; clientSecret: string } | null {
  if (!qqbotConfig || qqbotConfig.enabled === false) return null;

  if (
    typeof qqbotConfig.appId === "string" &&
    qqbotConfig.appId.trim() &&
    typeof qqbotConfig.clientSecret === "string" &&
    qqbotConfig.clientSecret.trim()
  ) {
    return {
      accountId: "default",
      appId: qqbotConfig.appId.trim(),
      clientSecret: qqbotConfig.clientSecret.trim(),
    };
  }

  const accounts = qqbotConfig.accounts;
  if (!accounts || typeof accounts !== "object") return null;

  const candidates = [
    qqbotConfig.defaultAccount,
    ...Object.keys(accounts),
  ].filter((v) => typeof v === "string" && v.trim().length > 0) as string[];

  for (const accountId of candidates) {
    const acc = accounts[accountId];
    if (
      acc &&
      typeof acc.appId === "string" &&
      acc.appId.trim() &&
      typeof acc.clientSecret === "string" &&
      acc.clientSecret.trim()
    ) {
      return {
        accountId,
        appId: acc.appId.trim(),
        clientSecret: acc.clientSecret.trim(),
      };
    }
  }

  return null;
}

async function getQqbotAccessToken(appId: string, clientSecret: string): Promise<{ ok: boolean; token?: string; error?: string }> {
  try {
    const resp = await fetch(QQBOT_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId, clientSecret }),
      signal: AbortSignal.timeout(15000),
    });
    const raw = await resp.text();
    let data: any = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }

    if (!resp.ok) {
      return { ok: false, error: `Token API HTTP ${resp.status}: ${(raw || "").slice(0, 180)}` };
    }
    if (!data?.access_token) {
      return { ok: false, error: `Token API invalid response: ${(raw || "").slice(0, 180)}` };
    }

    return { ok: true, token: data.access_token };
  } catch (err: any) {
    return { ok: false, error: err?.message || "Token API request failed" };
  }
}

async function testWhatsapp(
  agentId: string,
  gatewayPort: number,
  gatewayToken: string,
  testUserId: string | null,
  recipientSource: "session" | "allowFrom" | "none"
): Promise<PlatformTestResult> {
  const startTime = Date.now();

  if (!testUserId) {
    return {
      agentId, platform: "whatsapp", ok: false,
      error: "No WhatsApp recipient configured. Set channels.whatsapp.allowFrom or start one DM session first",
      elapsed: Date.now() - startTime,
    };
  }

  try {
    // WhatsApp has no public Bot API. Use `openclaw message send` CLI
    // to send a real message via the gateway's WhatsApp Web connection.
    const now = new Date().toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai" });
    const { execFileSync } = await import("child_process");

    const args = [
      "message", "send",
      "--channel", "whatsapp",
      "-t", testUserId,
      "--message", `[Platform Test] WhatsApp 联通测试 ✅ (${now})`,
    ];

    const result = execFileSync("openclaw", args, {
      timeout: 30000,
      encoding: "utf-8",
      env: { ...process.env },
    });

    const elapsed = Date.now() - startTime;
    const sourceLabel = recipientSource === "allowFrom" ? "allowFrom" : "session";
    const outputSummary = result.trim().slice(0, 120);
    return {
      agentId, platform: "whatsapp", ok: true,
      detail: `WhatsApp → DM sent to ${testUserId} (${elapsed}ms, via ${sourceLabel})${outputSummary ? ` · ${outputSummary}` : ""}`,
      elapsed,
    };
  } catch (err: any) {
    return {
      agentId, platform: "whatsapp", ok: false,
      error: (err.stderr || err.message || "Unknown error").slice(0, 300),
      elapsed: Date.now() - startTime,
    };
  }
}

async function testQqbot(
  agentId: string,
  qqbotConfig: any,
  testUserId: string | null,
  recipientSource: "session" | "allowFrom" | "none"
): Promise<PlatformTestResult> {
  const startTime = Date.now();
  const creds = resolveQqbotCredentials(qqbotConfig);
  if (!creds) {
    return {
      agentId, platform: "qqbot", ok: false,
      error: "QQBot credentials missing. Configure channels.qqbot.appId/clientSecret (or accounts)",
      elapsed: Date.now() - startTime,
    };
  }

  const tokenResult = await getQqbotAccessToken(creds.appId, creds.clientSecret);
  if (!tokenResult.ok || !tokenResult.token) {
    return {
      agentId, platform: "qqbot", ok: false,
      error: tokenResult.error || "QQBot token probe failed",
      elapsed: Date.now() - startTime,
    };
  }

  if (!testUserId) {
    return {
      agentId, platform: "qqbot", ok: true,
      detail: `QQBot token OK (account ${creds.accountId}, no DM session found)`,
      elapsed: Date.now() - startTime,
    };
  }

  try {
    const now = new Date().toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai" });
    const target = testUserId.replace(/^qqbot:/i, "");
    const [kindRaw, ...idParts] = target.split(":");
    const kind = kindRaw.toLowerCase();
    const targetId = idParts.join(":");
    if (!targetId) {
      return {
        agentId, platform: "qqbot", ok: false,
        error: `Invalid QQBot target: ${testUserId}`,
        elapsed: Date.now() - startTime,
      };
    }

    const url = kind === "group"
      ? `${QQBOT_API_BASE}/v2/groups/${targetId}/messages`
      : kind === "channel"
        ? `${QQBOT_API_BASE}/channels/${targetId}/messages`
        : `${QQBOT_API_BASE}/v2/users/${targetId}/messages`;

    const body = kind === "channel"
      ? { content: `[Platform Test] QQBot 联通测试 ✅ (${now})` }
      : { content: `[Platform Test] QQBot 联通测试 ✅ (${now})`, msg_type: 0 };

    const msgResp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `QQBot ${tokenResult.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const raw = await msgResp.text();

    const elapsed = Date.now() - startTime;
    const sourceLabel = recipientSource === "allowFrom" ? "allowFrom" : "session";
    if (!msgResp.ok) {
      return {
        agentId, platform: "qqbot", ok: false,
        error: `Send failed HTTP ${msgResp.status}: ${(raw || "").slice(0, 180)}`,
        elapsed,
      };
    }

    return {
      agentId, platform: "qqbot", ok: true,
      detail: `QQBot → DM sent to ${testUserId} (${elapsed}ms, via ${sourceLabel})`,
      elapsed,
    };
  } catch (err: any) {
    return {
      agentId, platform: "qqbot", ok: false,
      error: (err.stderr || err.message || "Unknown error").slice(0, 300),
      elapsed: Date.now() - startTime,
    };
  }
}

export async function POST() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const config = JSON.parse(raw);

    const bindings = config.bindings || [];
    const channels = config.channels || {};
    const feishuConfig = channels.feishu || {};
    const feishuAccounts = feishuConfig.accounts || {};
    const feishuDomain = feishuConfig.domain || "feishu";
    const discordConfig = channels.discord || {};
    const discordAllowFrom: string[] = discordConfig.dm?.allowFrom || [];
    const discordTestUser = discordAllowFrom[0] || null;
    const telegramConfig = channels.telegram || {};
    const whatsappConfig = channels.whatsapp || {};
    const qqbotConfig = channels.qqbot;

    // Read gateway config early (needed for WhatsApp test)
    const gatewayPort = config.gateway?.port || 18789;
    const gatewayToken = config.gateway?.auth?.token || "";

    let agentList = config.agents?.list || [];
    if (agentList.length === 0) {
      try {
        const agentsDir = path.join(OPENCLAW_HOME, "agents");
        const dirs = fs.readdirSync(agentsDir, { withFileTypes: true });
        agentList = dirs
          .filter((d: any) => d.isDirectory() && !d.name.startsWith("."))
          .map((d: any) => ({ id: d.name }));
      } catch {}
      if (agentList.length === 0) {
        agentList = [{ id: "main" }];
      }
    }

    // Phase 1: Platform API tests (parallel)
    const platformTests: Promise<PlatformTestResult>[] = [];
    const testedFeishuAccounts = new Set<string>();

    for (const agent of agentList) {
      const id = agent.id;

      // Feishu
      const feishuBinding = bindings.find(
        (b: any) => b.agentId === id && b.match?.channel === "feishu"
      );
      const accountId = feishuBinding?.match?.accountId || id;
      const account = feishuAccounts[accountId];

      if (account && account.appId && account.appSecret && !testedFeishuAccounts.has(accountId)) {
        testedFeishuAccounts.add(accountId);
        const testUserId = getFeishuDmUser(id);
        platformTests.push(testFeishu(id, accountId, account.appId, account.appSecret, feishuDomain, testUserId));
      } else if (!feishuBinding && !account) {
        if (id === "main" && feishuConfig.enabled && feishuConfig.appId && feishuConfig.appSecret && !testedFeishuAccounts.has("main")) {
          testedFeishuAccounts.add("main");
          const testUserId = getFeishuDmUser("main");
          platformTests.push(testFeishu(id, "main", feishuConfig.appId, feishuConfig.appSecret, feishuDomain, testUserId));
        }
      }

      // Discord: only test once
      if (id === "main" && discordConfig.enabled && discordConfig.token) {
        const resolvedDiscordToken = resolveSecretRef(discordConfig.token);
        if (resolvedDiscordToken) {
          platformTests.push(testDiscord(id, resolvedDiscordToken, discordTestUser));
        }
      }

      // Telegram: only test once
      if (id === "main" && telegramConfig.enabled && telegramConfig.botToken) {
        const resolvedToken = resolveSecretRef(telegramConfig.botToken);
        if (resolvedToken) {
          const telegramTestUser = getTelegramDmUser(id);
          platformTests.push(testTelegram(id, resolvedToken, telegramTestUser));
        }
      }

      // WhatsApp: only test once, via gateway
      if (id === "main" && whatsappConfig && whatsappConfig.enabled !== false) {
        const recentDmUser = getWhatsappDmUser(id);
        const allowFromUser = getWhatsappAllowlistUser(whatsappConfig);
        const whatsappTestUser = recentDmUser || allowFromUser || null;
        const source: "session" | "allowFrom" | "none" =
          recentDmUser ? "session" : (allowFromUser ? "allowFrom" : "none");
        platformTests.push(testWhatsapp(id, gatewayPort, gatewayToken, whatsappTestUser, source));
      }

      // QQBot: only test once, via `openclaw message send`
      if (id === "main" && qqbotConfig && qqbotConfig.enabled !== false) {
        const recentDmUser = normalizeQqbotTarget(getQqbotDmUser(id));
        const allowFromUser = normalizeQqbotTarget(getQqbotAllowlistUser(qqbotConfig));
        const qqbotTestUser = recentDmUser || allowFromUser || null;
        const source: "session" | "allowFrom" | "none" =
          recentDmUser ? "session" : (allowFromUser ? "allowFrom" : "none");
        platformTests.push(testQqbot(id, qqbotConfig, qqbotTestUser, source));
      }
    }

    const platformResults = await Promise.all(platformTests);

    return NextResponse.json({ results: platformResults });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function GET() {
  return POST();
}
