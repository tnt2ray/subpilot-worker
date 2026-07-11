import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { createSession, sessionCookie } from "../src/auth";
import { loadConfig, saveConfig } from "../src/config-store";
import { DEFAULT_CONFIG } from "../src/default-config";
import { recordConfigFetch } from "../src/fetch-stats";
import { sha256Hex } from "../src/util";
import { restoreMocksAfterEach } from "./helpers/fetch";
import { ctx, makeEnv, makeExecutionContext } from "./helpers/worker";

restoreMocksAfterEach();

describe("telegram api", () => {
  it("sends Telegram notifications when a Telegram bot token is configured", async () => {
    const kv = new Map<string, string>();
    const sourceKey = `cache:source:${await sha256Hex("https://example.com/sub|Surge iOS/3727")}`;
    kv.set(sourceKey, "previous-content");
    kv.set(`cache:sourceMeta:${sourceKey.slice("cache:source:".length)}`, JSON.stringify({
      key: sourceKey,
      fetchedAt: "2026-06-20T01:00:00.000Z",
      sourceId: "src1",
      sourceName: "Primary"
    }));
    kv.set("cache:sourceMeta:index", JSON.stringify([{
      key: sourceKey,
      fetchedAt: "2026-06-20T01:00:00.000Z",
      sourceId: "src1",
      sourceName: "Primary"
    }]));
    const env = makeEnv(kv);
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationChannel: "telegram",
        notificationTelegramChatId: "123456",
        notificationTelegramBotToken: "telegram-token"
      },
      sources: [{
        id: "src1",
        name: "Primary",
        url: "https://example.com/sub",
        fetchUserAgent: "surge",
        enabled: true
      }]
    });
    const session = await createSession(env);
    const headers = { cookie: sessionCookie(session, true) };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("upstream error", { status: 500 }))
      .mockResolvedValueOnce(new Response("upstream error", { status: 500 }))
      .mockResolvedValueOnce(new Response("upstream error", { status: 500 }))
      .mockResolvedValueOnce(new Response("upstream error", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));

    const refreshResponse = await worker.fetch(new Request("https://subpilot.example.com/api/cache/source/refresh", {
      method: "POST",
      headers
    }), env, ctx);
    const refreshed = await refreshResponse.json<{
      failed: number;
      notification: { telegram: string; warnings: string[] };
    }>();

    expect(refreshResponse.status).toBe(200);
    expect(refreshed.failed).toBe(1);
    expect(refreshed.notification).toMatchObject({ telegram: "sent", warnings: [] });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(String(fetchMock.mock.calls[4]?.[0])).toContain("https://api.telegram.org/bottelegram-token/sendMessage");
    const telegramBody = JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body ?? "{}")) as { text?: string };
    expect(telegramBody.text).toContain("失败订阅源：");
    expect(telegramBody.text).toContain("上游缓存：1 / 1 个启用源已缓存，全部就绪");
    expect(telegramBody.text).toContain("缓存更新时间：2026-06-20 09:00:00");
    expect(telegramBody.text).toContain("协议节点：未解析到节点");
    expect(telegramBody.text).toContain("订阅源缓存：");
    expect(telegramBody.text).toContain("Primary：已缓存，0 个节点；协议 未解析到节点；2026-06-20 09:00:00");
    expect(telegramBody.text).toContain("名称：Primary");
    expect(telegramBody.text).toContain("ID：src1");
    expect(telegramBody.text).toContain("原因：HTTP 500");
    expect(telegramBody.text).toContain("处理：已沿用旧缓存");
    expect(String(telegramBody.text).indexOf("失败订阅源：")).toBeLessThan(String(telegramBody.text).indexOf("订阅源缓存："));
    expect(telegramBody.text).not.toContain("2026-06-20T01:00:00.000Z");
    expect(telegramBody.text).not.toContain("UTC+8");
  });

  it("keeps rule source URLs unchanged and reports HTML fallback through Telegram", async () => {
    const env = makeEnv();
    const sourceUrl = "https://github.com/example/rules/blob/main/surge.list";
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationChannel: "telegram",
        notificationTelegramChatId: "123456",
        notificationTelegramBotToken: "telegram-token"
      },
      ruleSets: {
        mode: "compiled",
        aggregateByPolicy: false,
        sources: [{
          id: "html-source",
          name: "HTML Source",
          url: sourceUrl,
          enabled: true,
          format: "auto",
          order: 0
        }],
        outputs: [{
          name: "HTML Output",
          enabled: true,
          policy: "Proxy",
          sourceIds: ["html-source"],
          inlineRules: [],
          order: 0,
          surgeOptions: []
        }],
        directRules: []
      }
    });
    const session = await createSession(env);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("DOMAIN-SUFFIX,example.com"))
      .mockResolvedValueOnce(new Response("<!doctype html><html><body>GitHub</body></html>"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));

    const request = new Request("https://subpilot.example.com/api/rule-sets/refresh", {
      method: "POST",
      headers: { cookie: sessionCookie(session, true) }
    });
    const initialResponse = await worker.fetch(request, env, ctx);
    expect(initialResponse.status).toBe(200);

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/rule-sets/refresh", {
      method: "POST",
      headers: { cookie: sessionCookie(session, true) }
    }), env, ctx);
    const result = await response.json<{
      failed: number;
      failures: Array<{ reason: string }>;
      notification: { telegram: string; warnings: string[] };
    }>();

    expect(response.status).toBe(200);
    expect(result.failed).toBe(0);
    expect(result.failures[0]?.reason).toBe("规则来源返回了 HTML 页面，请改用原始规则文件 URL");
    expect(result.notification).toEqual({ telegram: "sent", warnings: [] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(sourceUrl);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(sourceUrl);
    expect(String(fetchMock.mock.calls[2]?.[0])).toBe("https://api.telegram.org/bottelegram-token/sendMessage");
    const telegramBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body ?? "{}")) as { text?: string };
    expect(telegramBody.text).toContain("SubPilot 上游规则集刷新存在失败");
    expect(telegramBody.text).toContain("名称：HTML Source");
    expect(telegramBody.text).toContain("规则来源返回了 HTML 页面，请改用原始规则文件 URL");
    expect(telegramBody.text).toContain("处理：已沿用旧缓存");
  });

  it("generates a one-time Telegram bind command and registers the webhook", async () => {
    const kv = new Map<string, string>();
    const env = makeEnv(kv);
    const session = await createSession(env);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/telegram/bind-code", {
      method: "POST",
      headers: { cookie: sessionCookie(session, true) },
      body: JSON.stringify({ token: "telegram-token" })
    }), env, ctx);
    const result = await response.json<{
      code: string;
      command: string;
      expiresAt: string;
      config: typeof DEFAULT_CONFIG;
    }>();

    expect(response.status).toBe(200);
    expect(result.code).toMatch(/^[A-Z0-9]{10}$/);
    expect(result.command).toBe(`/bind ${result.code}`);
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());
    expect(kv.get("auth:telegram_bind")).not.toContain(result.code);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.telegram.org/bottelegram-token/setWebhook");
    const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get("url")).toBe("https://subpilot.example.com/api/telegram/webhook");
    expect(body.get("drop_pending_updates")).toBe("true");
    expect(result.config.settings.notificationChannel).toBe("telegram");
    expect(result.config.settings.notificationTelegramBotToken).toBe("telegram-token");
    expect(result.config.settings.notificationTelegramWebhookSecret).toBe(body.get("secret_token"));
  });

  it("blocks Telegram bind command generation and chat unbinding without an admin session", async () => {
    const env = makeEnv();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    const bindResponse = await worker.fetch(new Request("https://subpilot.example.com/api/telegram/bind-code", {
      method: "POST",
      body: JSON.stringify({ token: "telegram-token" })
    }), env, ctx);

    const unbindResponse = await worker.fetch(new Request("https://subpilot.example.com/api/telegram/unbind", {
      method: "POST"
    }), env, ctx);

    expect(bindResponse.status).toBe(401);
    expect(unbindResponse.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("registers a Telegram webhook when saving Telegram notification settings", async () => {
    const env = makeEnv();
    const session = await createSession(env);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/config", {
      method: "PATCH",
      headers: { cookie: sessionCookie(session, true) },
      body: JSON.stringify({
        settings: {
          notificationChannel: "telegram",
          notificationTelegramBotToken: "telegram-token"
        }
      })
    }), env, ctx);
    const saved = await response.json<typeof DEFAULT_CONFIG>();

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.telegram.org/bottelegram-token/setWebhook");
    const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get("url")).toBe("https://subpilot.example.com/api/telegram/webhook");
    expect(body.get("drop_pending_updates")).toBe("true");
    expect(body.get("allowed_updates")).toBe(JSON.stringify(["message", "edited_message", "channel_post", "edited_channel_post"]));
    expect(body.get("secret_token")).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(saved.settings.notificationTelegramWebhookSecret).toBe(body.get("secret_token"));
  });

  it("does not re-register an unchanged Telegram webhook for unrelated config saves", async () => {
    const env = makeEnv();
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationChannel: "telegram",
        notificationTelegramBotToken: "telegram-token",
        notificationTelegramWebhookSecret: "webhook-secret"
      }
    });
    const session = await createSession(env);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/config", {
      method: "PATCH",
      headers: { cookie: sessionCookie(session, true) },
      body: JSON.stringify({ settings: { updateCheckEnabled: true } })
    }), env, ctx);

    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-registers Telegram when the persisted webhook origin changes", async () => {
    const env = makeEnv();
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        managedBaseUrl: "https://subpilot.example.com/sync",
        notificationChannel: "telegram",
        notificationTelegramBotToken: "telegram-token",
        notificationTelegramWebhookSecret: "webhook-secret"
      }
    });
    const session = await createSession(env);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/config", {
      method: "PATCH",
      headers: { cookie: sessionCookie(session, true) },
      body: JSON.stringify({ settings: { managedBaseUrl: "https://links.example.com/subscriptions" } })
    }), env, ctx);
    const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body.get("url")).toBe("https://links.example.com/api/telegram/webhook");
  });

  it("does not mutate Telegram remotely when KV persistence fails", async () => {
    const env = makeEnv();
    const session = await createSession(env);
    vi.spyOn(env.SUBPILOT_CONFIG, "put").mockRejectedValue(new Error("KV unavailable"));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/config", {
      method: "PATCH",
      headers: { cookie: sessionCookie(session, true) },
      body: JSON.stringify({ settings: { notificationTelegramBotToken: "telegram-token" } })
    }), env, ctx);

    expect(response.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rolls back persisted Telegram settings when remote webhook registration fails", async () => {
    const env = makeEnv();
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationChannel: "telegram",
        notificationTelegramBotToken: "old-token",
        notificationTelegramWebhookSecret: "old-secret"
      }
    });
    const session = await createSession(env);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, description: "set failed" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/config", {
      method: "PATCH",
      headers: { cookie: sessionCookie(session, true) },
      body: JSON.stringify({ settings: { notificationTelegramBotToken: "new-token" } })
    }), env, ctx);
    const rolledBack = await loadConfig(env);

    expect(response.status).toBe(500);
    expect(rolledBack.settings.notificationTelegramBotToken).toBe("old-token");
    expect(rolledBack.settings.notificationTelegramWebhookSecret).toBe("old-secret");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.telegram.org/botnew-token/setWebhook");
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://api.telegram.org/botnew-token/deleteWebhook");
  });

  it("clears Telegram chat binding without removing webhook settings", async () => {
    const env = makeEnv();
    const session = await createSession(env);
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationChannel: "telegram",
        notificationTelegramBotToken: "telegram-token",
        notificationTelegramChatId: "-1001234567890",
        notificationTelegramWebhookSecret: "webhook-secret"
      }
    });
    await env.SUBPILOT_CONFIG.put("auth:telegram_bind", JSON.stringify({
      codeHash: await sha256Hex("ABC123XYZ9"),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }));

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/telegram/unbind", {
      method: "POST",
      headers: { cookie: sessionCookie(session, true) }
    }), env, ctx);
    const saved = await response.json<typeof DEFAULT_CONFIG>();

    expect(response.status).toBe(200);
    expect(saved.settings.notificationChannel).toBe("telegram");
    expect(saved.settings.notificationTelegramChatId).toBe("");
    expect(saved.settings.notificationTelegramBotToken).toBe("telegram-token");
    expect(saved.settings.notificationTelegramWebhookSecret).toBe("webhook-secret");
    await expect(env.SUBPILOT_CONFIG.get("auth:telegram_bind")).resolves.toBeNull();
  });

  it("records Telegram chat id from a valid one-time bind command", async () => {
    const env = makeEnv();
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationChannel: "telegram",
        notificationTelegramBotToken: "telegram-token",
        notificationTelegramWebhookSecret: "webhook-secret"
      }
    });
    const code = "ABC123XYZ9";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    await env.SUBPILOT_CONFIG.put("auth:telegram_bind", JSON.stringify({
      codeHash: await sha256Hex(code),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }));

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "webhook-secret"
      },
      body: JSON.stringify({
        update_id: 1,
        message: {
          text: `/bind ${code}`,
          chat: {
            id: -1001234567890,
            type: "supergroup",
            title: "Ops Group"
          }
        }
      })
    }), env, ctx);
    const saved = await loadConfig(env);

    expect(response.status).toBe(200);
    expect(saved.settings.notificationTelegramChatId).toBe("-1001234567890");
    expect(saved.settings.notificationTelegramBotToken).toBe("telegram-token");
    expect(saved.settings.notificationTelegramWebhookSecret).toBe("webhook-secret");
    await expect(env.SUBPILOT_CONFIG.get("auth:telegram_bind")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.telegram.org/bottelegram-token/sendMessage");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"))).toMatchObject({
      chat_id: "-1001234567890",
      text: "SubPilot Telegram 通知已绑定成功。"
    });
  });

  it("ignores Telegram bind commands after a chat is already bound", async () => {
    const env = makeEnv();
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationChannel: "telegram",
        notificationTelegramBotToken: "telegram-token",
        notificationTelegramChatId: "123456",
        notificationTelegramWebhookSecret: "webhook-secret"
      }
    });
    const code = "ABC123XYZ9";
    await env.SUBPILOT_CONFIG.put("auth:telegram_bind", JSON.stringify({
      codeHash: await sha256Hex(code),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "webhook-secret"
      },
      body: JSON.stringify({
        update_id: 2,
        message: {
          text: `/bind ${code}`,
          chat: { id: 999999, type: "private", first_name: "Other" }
        }
      })
    }), env, ctx);
    const saved = await loadConfig(env);

    expect(response.status).toBe(200);
    expect(saved.settings.notificationTelegramChatId).toBe("123456");
    await expect(env.SUBPILOT_CONFIG.get("auth:telegram_bind")).resolves.not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("responds to Telegram status commands from the bound chat", async () => {
    const kv = new Map<string, string>();
    const sourceKey = `cache:source:${await sha256Hex("https://example.com/sub|Surge iOS/3727")}`;
    const fetchedAt = "2026-06-20T01:00:00.000Z";
    kv.set(sourceKey, "Proxy = trojan, proxy.example.com, 443, password=p\nVMess = vmess, vmess.example.com, 443, username=00000000-0000-0000-0000-000000000001");
    kv.set(`cache:sourceMeta:${sourceKey.slice("cache:source:".length)}`, JSON.stringify({
      key: sourceKey,
      fetchedAt,
      sourceId: "src1",
      sourceName: "Primary"
    }));
    kv.set("cache:sourceMeta:index", JSON.stringify([{
      key: sourceKey,
      fetchedAt,
      sourceId: "src1",
      sourceName: "Primary"
    }]));
    const env = makeEnv(kv);
    const exec = makeExecutionContext();
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationChannel: "telegram",
        notificationTelegramBotToken: "telegram-token",
        notificationTelegramChatId: "123456",
        notificationTelegramWebhookSecret: "webhook-secret"
      },
      sources: [{
        id: "src1",
        name: "Primary",
        url: "https://example.com/sub",
        fetchUserAgent: "surge",
        enabled: true
      }]
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "webhook-secret"
      },
      body: JSON.stringify({
        update_id: 3,
        message: {
          text: "/status",
          chat: { id: 123456, type: "private", first_name: "Sub" }
        }
      })
    }), env, exec.ctx);
    await Promise.all(exec.waitUntil);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.telegram.org/bottelegram-token/sendMessage");
    const telegramBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}")) as { chat_id?: string; text?: string };
    expect(telegramBody.chat_id).toBe("123456");
    expect(telegramBody.text).toContain("SubPilot 状态");
    expect(telegramBody.text).toContain("订阅源：启用 1 / 停用 0");
    expect(telegramBody.text).toContain("上游缓存：1 / 1 个启用源已缓存，全部就绪");
    expect(telegramBody.text).toContain("缓存更新时间：2026-06-20 09:00:00");
    expect(telegramBody.text).toContain("协议节点：trojan 1，vmess 1，总计 2");
    expect(telegramBody.text).toContain("Primary：已缓存，2 个节点；协议 trojan 1，vmess 1；2026-06-20 09:00:00");
    expect(telegramBody.text).toContain("最近 Surge 配置获取：");
    expect(telegramBody.text).toContain("最近 Clash 配置获取：");
    expect(telegramBody.text).toContain("最近 Stash 配置获取：");
    expect(telegramBody.text).toContain("最近 Shadowrocket Clash YAML 获取：");
    expect(telegramBody.text).not.toContain("2026-06-20T01:00:00.000Z");
    expect(telegramBody.text).not.toContain("UTC+8");
    expect(telegramBody.text).not.toContain("Chat ID");
  });

  it("limits Telegram recent fetch output to five configured-time-zone rows", async () => {
    const env = makeEnv();
    const exec = makeExecutionContext();
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationChannel: "telegram",
        notificationTelegramBotToken: "telegram-token",
        notificationTelegramChatId: "123456",
        notificationTelegramWebhookSecret: "webhook-secret",
        displayTimeZone: "UTC"
      }
    });

    vi.useFakeTimers();
    try {
      const targets = ["surge", "clash", "stash", "shadowrocket", "surge", "shadowrocket"] as const;
      for (let index = 0; index < 6; index += 1) {
        vi.setSystemTime(new Date(Date.UTC(2026, 5, 20, 0, 0, index)));
        const target = targets[index]!;
        await recordConfigFetch(env, target, new Request("https://subpilot.example.com/sync/read-token/", {
          headers: {
            "cf-connecting-ip": "198.51.100.7",
            "user-agent": `Recent Client/${index}`
          }
        }));
      }
    } finally {
      vi.useRealTimers();
    }

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    const response = await worker.fetch(new Request("https://subpilot.example.com/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "webhook-secret"
      },
      body: JSON.stringify({
        update_id: 4,
        message: {
          text: "/recent",
          chat: { id: 123456, type: "private", first_name: "Sub" }
        }
      })
    }), env, exec.ctx);
    await Promise.all(exec.waitUntil);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const telegramBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}")) as { text?: string };
    expect(telegramBody.text).toContain("最近配置拉取：");
    expect(telegramBody.text).toContain("1. Shadowrocket Clash YAML，2026-06-20 00:00:05，UA：Recent Client/5");
    expect(telegramBody.text).toContain("5. Clash 配置，2026-06-20 00:00:01，UA：Recent Client/1");
    expect(telegramBody.text).not.toContain("Recent Client/0");
    expect(telegramBody.text).not.toContain("2026-06-20T00:00:05.000Z");
    expect(telegramBody.text).not.toContain("UTC+8");
  });

  it("ignores Telegram commands from chats that are not bound", async () => {
    const env = makeEnv();
    const exec = makeExecutionContext();
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationChannel: "telegram",
        notificationTelegramBotToken: "telegram-token",
        notificationTelegramChatId: "123456",
        notificationTelegramWebhookSecret: "webhook-secret"
      }
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "webhook-secret"
      },
      body: JSON.stringify({
        update_id: 4,
        message: {
          text: "/status",
          chat: { id: 999999, type: "private", first_name: "Other" }
        }
      })
    }), env, exec.ctx);
    await Promise.all(exec.waitUntil);

    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(exec.waitUntil).toHaveLength(0);
  });

  it("silently ignores Telegram commands before a chat is bound", async () => {
    const env = makeEnv();
    const exec = makeExecutionContext();
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationChannel: "telegram",
        notificationTelegramBotToken: "telegram-token",
        notificationTelegramWebhookSecret: "webhook-secret"
      }
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "webhook-secret"
      },
      body: JSON.stringify({
        update_id: 5,
        message: {
          text: "/status",
          chat: { id: 123456, type: "private", first_name: "Sub" }
        }
      })
    }), env, exec.ctx);
    await Promise.all(exec.waitUntil);

    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(exec.waitUntil).toHaveLength(0);
  });

  it("refreshes upstream source cache from the bound Telegram chat", async () => {
    const env = makeEnv();
    const exec = makeExecutionContext();
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationChannel: "telegram",
        notificationTelegramBotToken: "telegram-token",
        notificationTelegramChatId: "123456",
        notificationTelegramWebhookSecret: "webhook-secret"
      },
      sources: [{
        id: "src1",
        name: "Primary",
        url: "https://example.com/sub",
        fetchUserAgent: "surge",
        enabled: true
      }]
    });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })))
      .mockResolvedValueOnce(new Response("Proxy = trojan, proxy.example.com, 443, password=p"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "webhook-secret"
      },
      body: JSON.stringify({
        update_id: 5,
        message: {
          text: "/refresh",
          chat: { id: 123456, type: "private", first_name: "Sub" }
        }
      })
    }), env, exec.ctx);
    await Promise.all(exec.waitUntil);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://example.com/sub");
    const doneBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body ?? "{}")) as { text?: string };
    expect(doneBody.text).toContain("上游订阅源强制获取完成");
    expect(doneBody.text).toContain("刷新成功：1");
    expect(doneBody.text).toContain("刷新失败：0");
    expect(doneBody.text).toContain("上游缓存：1 / 1 个启用源已缓存，全部就绪");
    expect(doneBody.text).toContain("协议节点：trojan 1，总计 1");
    expect(doneBody.text).toContain("Primary：已缓存，1 个节点；协议 trojan 1");
  });

  it("continues Telegram refresh when the start message fails", async () => {
    const env = makeEnv();
    const exec = makeExecutionContext();
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationChannel: "telegram",
        notificationTelegramBotToken: "telegram-token",
        notificationTelegramChatId: "123456",
        notificationTelegramWebhookSecret: "webhook-secret"
      },
      sources: [{
        id: "src1",
        name: "Primary",
        url: "https://example.com/sub",
        fetchUserAgent: "surge",
        enabled: true
      }]
    });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, description: "message failed" })))
      .mockResolvedValueOnce(new Response("Proxy = trojan, proxy.example.com, 443, password=p"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "webhook-secret"
      },
      body: JSON.stringify({
        update_id: 6,
        message: {
          text: "/refresh",
          chat: { id: 123456, type: "private", first_name: "Sub" }
        }
      })
    }), env, exec.ctx);
    await Promise.all(exec.waitUntil);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://example.com/sub");
    const doneBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body ?? "{}")) as { text?: string };
    expect(doneBody.text).toContain("上游订阅源强制获取完成");
    expect(doneBody.text).toContain("刷新成功：1");
  });

  it("refreshes compiled rule sets asynchronously from the Telegram refresh command", async () => {
    const env = makeEnv();
    const exec = makeExecutionContext();
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationChannel: "telegram",
        notificationTelegramBotToken: "telegram-token",
        notificationTelegramChatId: "123456",
        notificationTelegramWebhookSecret: "webhook-secret"
      },
      sources: [{
        id: "src1",
        name: "Primary",
        url: "https://example.com/sub",
        fetchUserAgent: "surge",
        enabled: true
      }],
      ruleSets: {
        mode: "compiled",
        aggregateByPolicy: false,
        sources: [{
          id: "rules1",
          name: "Primary Rules",
          url: "https://example.com/rules.list",
          enabled: true,
          format: "auto",
          order: 0
        }],
        outputs: [{
          name: "Proxy",
          enabled: true,
          policy: "Proxy",
          sourceIds: ["rules1"],
          inlineRules: [],
          order: 0,
          surgeOptions: []
        }],
        directRules: []
      }
    });
    const telegramMessages: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "https://example.com/sub") {
        return new Response("Proxy = trojan, proxy.example.com, 443, password=p");
      }
      if (url === "https://example.com/rules.list") {
        return new Response("DOMAIN-SUFFIX,example.com");
      }
      if (url.includes("api.telegram.org")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
        telegramMessages.push(body.text || "");
        return new Response(JSON.stringify({ ok: true }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "webhook-secret"
      },
      body: JSON.stringify({
        update_id: 7,
        message: {
          text: "/refresh",
          chat: { id: 123456, type: "private", first_name: "Sub" }
        }
      })
    }), env, exec.ctx);
    await Promise.all(exec.waitUntil);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith("https://example.com/rules.list", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(telegramMessages.some((message) => message.includes("规则集将在后台异步刷新"))).toBe(true);
    expect(telegramMessages.some((message) => message.includes("上游订阅源强制获取完成"))).toBe(true);
    expect(telegramMessages.some((message) => message.includes("规则集异步刷新完成"))).toBe(true);
    expect(telegramMessages.some((message) => message.includes("缓存覆盖：1 / 1"))).toBe(true);
    expect(telegramMessages.some((message) => message.includes("规则总数：1"))).toBe(true);
  });

  it("does not record Telegram chat id from read tokens or invalid bind codes", async () => {
    const env = makeEnv();
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationChannel: "telegram",
        notificationTelegramBotToken: "telegram-token",
        notificationTelegramWebhookSecret: "webhook-secret"
      }
    });
    await env.SUBPILOT_CONFIG.put("auth:telegram_bind", JSON.stringify({
      codeHash: await sha256Hex("ABC123XYZ9"),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    const readTokenResponse = await worker.fetch(new Request("https://subpilot.example.com/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "webhook-secret"
      },
      body: JSON.stringify({
        update_id: 1,
        message: {
          text: "read-token",
          chat: { id: 123456, type: "private", first_name: "Sub" }
        }
      })
    }), env, ctx);
    const wrongCodeResponse = await worker.fetch(new Request("https://subpilot.example.com/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "webhook-secret"
      },
      body: JSON.stringify({
        update_id: 2,
        message: {
          text: "/bind WRONG1",
          chat: { id: 123456, type: "private", first_name: "Sub" }
        }
      })
    }), env, ctx);
    const saved = await loadConfig(env);

    expect(readTokenResponse.status).toBe(200);
    expect(wrongCodeResponse.status).toBe(200);
    expect(saved.settings.notificationTelegramChatId).toBe("");
    await expect(env.SUBPILOT_CONFIG.get("auth:telegram_bind")).resolves.not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.telegram.org/bottelegram-token/sendMessage");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"))).toMatchObject({
      chat_id: "123456",
      text: "绑定失败：请在 SubPilot 后台重新生成绑定命令，并在 10 分钟内发送完整的 /bind 命令。"
    });
  });

  it("does not record Telegram chat id from expired bind codes", async () => {
    const env = makeEnv();
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationChannel: "telegram",
        notificationTelegramBotToken: "telegram-token",
        notificationTelegramWebhookSecret: "webhook-secret"
      }
    });
    const code = "ABC123XYZ9";
    await env.SUBPILOT_CONFIG.put("auth:telegram_bind", JSON.stringify({
      codeHash: await sha256Hex(code),
      expiresAt: new Date(Date.now() - 60_000).toISOString()
    }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "webhook-secret"
      },
      body: JSON.stringify({
        update_id: 1,
        message: {
          text: `/bind ${code}`,
          chat: { id: 123456, type: "private", first_name: "Sub" }
        }
      })
    }), env, ctx);
    const saved = await loadConfig(env);

    expect(response.status).toBe(200);
    expect(saved.settings.notificationTelegramChatId).toBe("");
    await expect(env.SUBPILOT_CONFIG.get("auth:telegram_bind")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"))).toMatchObject({
      chat_id: "123456",
      text: "绑定失败：请在 SubPilot 后台重新生成绑定命令，并在 10 分钟内发送完整的 /bind 命令。"
    });
  });

  it("rejects Telegram webhook requests with an invalid secret", async () => {
    const env = makeEnv();
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationTelegramWebhookSecret: "webhook-secret"
      }
    });

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "wrong-secret"
      },
      body: JSON.stringify({ update_id: 1 })
    }), env, ctx);

    expect(response.status).toBe(403);
  });

  it("deletes the Telegram webhook when the Telegram bot token is cleared", async () => {
    const env = makeEnv();
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationChannel: "telegram",
        notificationTelegramBotToken: "telegram-token",
        notificationTelegramWebhookSecret: "webhook-secret"
      }
    });
    const session = await createSession(env);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    const response = await worker.fetch(new Request("https://subpilot.example.com/api/config", {
      method: "PATCH",
      headers: { cookie: sessionCookie(session, true) },
      body: JSON.stringify({
        settings: {
          notificationTelegramBotToken: ""
        }
      })
    }), env, ctx);
    const saved = await loadConfig(env);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.telegram.org/bottelegram-token/deleteWebhook");
    expect(saved.settings.notificationChannel).toBe("off");
    expect(saved.settings.notificationTelegramChatId).toBe("");
    expect(saved.settings.notificationTelegramWebhookSecret).toBe("");
  });

  it("does not send channel notifications when no Telegram bot token is configured", async () => {
    const kv = new Map<string, string>();
    const sourceKey = `cache:source:${await sha256Hex("https://example.com/sub|Surge iOS/3727")}`;
    kv.set(sourceKey, "previous-content");
    kv.set(`cache:sourceMeta:${sourceKey.slice("cache:source:".length)}`, JSON.stringify({
      key: sourceKey,
      fetchedAt: "2026-06-20T01:00:00.000Z",
      sourceId: "src1",
      sourceName: "Primary"
    }));
    kv.set("cache:sourceMeta:index", JSON.stringify([{
      key: sourceKey,
      fetchedAt: "2026-06-20T01:00:00.000Z",
      sourceId: "src1",
      sourceName: "Primary"
    }]));
    const env = makeEnv(kv);
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationChannel: "off",
        notificationTelegramChatId: "123456",
        notificationTelegramBotToken: ""
      },
      sources: [{
        id: "src1",
        name: "Primary",
        url: "https://example.com/sub",
        fetchUserAgent: "surge",
        enabled: true
      }]
    });
    const session = await createSession(env);
    const headers = { cookie: sessionCookie(session, true) };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("upstream error", { status: 500 }));

    const refreshResponse = await worker.fetch(new Request("https://subpilot.example.com/api/cache/source/refresh", {
      method: "POST",
      headers
    }), env, ctx);
    const refreshed = await refreshResponse.json<{
      failed: number;
      notification: { telegram: string; warnings: string[] };
    }>();

    expect(refreshResponse.status).toBe(200);
    expect(refreshed.failed).toBe(1);
    expect(refreshed.notification).toMatchObject({ telegram: "disabled", warnings: [] });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

});
