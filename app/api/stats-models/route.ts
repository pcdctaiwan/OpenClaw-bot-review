import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(process.env.HOME || "", ".openclaw");

interface ModelStat {
  modelId: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  messageCount: number;
  avgResponseMs: number;
}

interface InternalModelStat extends ModelStat {
  responseTimes: number[];
}

export async function GET() {
  try {
    const agentsDir = path.join(OPENCLAW_HOME, "agents");
    let agentIds: string[];
    try {
      agentIds = fs.readdirSync(agentsDir).filter(f => fs.statSync(path.join(agentsDir, f)).isDirectory());
    } catch { agentIds = []; }

    const modelMap: Record<string, InternalModelStat> = {};

    for (const agentId of agentIds) {
      const sessionsDir = path.join(agentsDir, agentId, "sessions");
      let files: string[];
      try {
        files = fs.readdirSync(sessionsDir).filter(f => f.endsWith(".jsonl") && !f.includes(".deleted."));
      } catch { continue; }

      for (const file of files) {
        let content: string;
        try { content = fs.readFileSync(path.join(sessionsDir, file), "utf-8"); } catch { continue; }

        const lines = content.trim().split("\n");
        const messages: { role: string; ts: string; stopReason?: string; model?: string; provider?: string }[] = [];

        for (const line of lines) {
          let entry: any;
          try { entry = JSON.parse(line); } catch { continue; }
          if (entry.type !== "message") continue;
          const msg = entry.message;
          if (!msg || !entry.timestamp) continue;

          messages.push({
            role: msg.role,
            ts: entry.timestamp,
            stopReason: msg.stopReason,
            model: msg.model,
            provider: msg.provider,
          });

          if (msg.role === "assistant" && msg.usage && msg.model) {
            const key = `${msg.provider || "unknown"}/${msg.model}`;
            if (!modelMap[key]) {
              modelMap[key] = {
                modelId: msg.model,
                provider: msg.provider || "unknown",
                inputTokens: 0, outputTokens: 0, totalTokens: 0,
                messageCount: 0, avgResponseMs: 0, responseTimes: [],
              };
            }
            const m = modelMap[key];
            m.inputTokens += msg.usage.input || 0;
            m.outputTokens += msg.usage.output || 0;
            m.totalTokens += msg.usage.totalTokens || 0;
            m.messageCount += 1;
          }
        }

        // Response times per model
        for (let i = 0; i < messages.length; i++) {
          if (messages[i].role !== "user") continue;
          for (let j = i + 1; j < messages.length; j++) {
            if (messages[j].role === "assistant" && messages[j].stopReason === "stop") {
              const diffMs = new Date(messages[j].ts).getTime() - new Date(messages[i].ts).getTime();
              if (diffMs > 0 && diffMs < 600000 && messages[j].model) {
                const key = `${messages[j].provider || "unknown"}/${messages[j].model}`;
                if (modelMap[key]) {
                  modelMap[key].responseTimes.push(diffMs);
                }
              }
              break;
            }
          }
        }
      }
    }

    const models: ModelStat[] = Object.values(modelMap).map(({ responseTimes, ...rest }) => {
      if (responseTimes.length > 0) {
        rest.avgResponseMs = Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length);
      }
      return rest;
    });

    // Sort by total tokens descending
    models.sort((a, b) => b.totalTokens - a.totalTokens);

    return NextResponse.json({ models });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
