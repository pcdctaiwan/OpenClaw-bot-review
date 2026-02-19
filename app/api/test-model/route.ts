import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(process.env.HOME || "", ".openclaw");
const CONFIG_PATH = path.join(OPENCLAW_HOME, "openclaw.json");

export async function POST(req: Request) {
  try {
    const { provider: providerId, modelId } = await req.json();
    if (!providerId || !modelId) {
      return NextResponse.json({ error: "Missing provider or modelId" }, { status: 400 });
    }

    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const config = JSON.parse(raw);
    const provider = config.models?.providers?.[providerId];
    if (!provider) {
      return NextResponse.json({ error: `Provider "${providerId}" not found` }, { status: 404 });
    }

    const baseUrl = provider.baseUrl;
    const apiKey = provider.apiKey || "";
    const api = provider.api;
    const headers: Record<string, string> = { "Content-Type": "application/json" };

    const startTime = Date.now();

    if (api === "anthropic-messages") {
      // Check for custom auth header
      const authHeader = provider.authHeader || "x-api-key";
      headers[authHeader] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      if (provider.headers) Object.assign(headers, provider.headers);

      const body = {
        model: modelId,
        max_tokens: 32,
        messages: [{ role: "user", content: "Say hi in 3 words." }],
      };

      const resp = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(100000),
      });

      const elapsed = Date.now() - startTime;
      const data = await resp.json();

      if (!resp.ok) {
        return NextResponse.json({
          ok: false,
          status: resp.status,
          error: data.error?.message || JSON.stringify(data),
          elapsed,
        });
      }

      const text = data.content?.[0]?.text || "";
      return NextResponse.json({ ok: true, text, elapsed, model: data.model });

    } else if (api === "openai-completions") {
      headers["Authorization"] = `Bearer ${apiKey}`;

      const body = {
        model: modelId,
        max_tokens: 32,
        messages: [{ role: "user", content: "Say hi in 3 words." }],
      };

      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(100000),
      });

      const elapsed = Date.now() - startTime;
      const data = await resp.json();

      if (!resp.ok) {
        return NextResponse.json({
          ok: false,
          status: resp.status,
          error: data.error?.message || JSON.stringify(data),
          elapsed,
        });
      }

      const text = data.choices?.[0]?.message?.content || "";
      return NextResponse.json({ ok: true, text, elapsed, model: data.model });

    } else {
      return NextResponse.json({ error: `Unknown API type: ${api}` }, { status: 400 });
    }
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message, elapsed: 0 }, { status: 500 });
  }
}
