"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";

interface Platform {
  name: string;
  accountId?: string;
  appId?: string;
  botOpenId?: string;
  botUserId?: string;
}

interface Agent {
  id: string;
  name: string;
  emoji: string;
  model: string;
  platforms: Platform[];
  session?: {
    lastActive: number | null;
    totalTokens: number;
    contextTokens: number;
    sessionCount: number;
  };
}

interface GroupChat {
  groupId: string;
  channel: string;
  agents: { id: string; emoji: string; name: string }[];
}

interface ConfigData {
  agents: Agent[];
  defaults: { model: string; fallbacks: string[] };
  gateway?: { port: number; token?: string };
  groupChats?: GroupChat[];
}

interface DayStat {
  date: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  messageCount: number;
  avgResponseMs: number;
}

interface AllStats {
  daily: DayStat[];
  weekly: DayStat[];
  monthly: DayStat[];
}

type TimeRange = "daily" | "weekly" | "monthly";
const RANGE_LABELS: Record<TimeRange, string> = { daily: "按天", weekly: "按周", monthly: "按月" };

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function formatMs(ms: number): string {
  if (!ms) return "-";
  if (ms < 1000) return ms + "ms";
  return (ms / 1000).toFixed(1) + "s";
}

// 趋势折线图
function TrendChart({ data, lines, height = 180 }: { data: DayStat[]; lines: { key: keyof DayStat; color: string; label: string }[]; height?: number }) {
  if (data.length === 0) return <div className="flex items-center justify-center h-32 text-[var(--text-muted)] text-sm">暂无数据</div>;

  const pad = { top: 16, right: 16, bottom: 50, left: 56 };
  const width = Math.max(500, data.length * 56 + pad.left + pad.right);
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;

  let maxVal = 0;
  for (const d of data) for (const l of lines) { const v = d[l.key] as number; if (v > maxVal) maxVal = v; }
  if (maxVal === 0) maxVal = 1;

  const ticks = Array.from({ length: 5 }, (_, i) => Math.round((maxVal / 4) * i));

  function toX(i: number) { return pad.left + (i / (data.length - 1 || 1)) * chartW; }
  function toY(v: number) { return pad.top + chartH - (v / maxVal) * chartH; }

  return (
    <div className="overflow-x-auto">
      <svg width={width} height={height} className="text-[var(--text-muted)]">
        {ticks.map((tick, i) => (
          <g key={i}>
            <line x1={pad.left} y1={toY(tick)} x2={width - pad.right} y2={toY(tick)} stroke="currentColor" opacity={0.12} />
            <text x={pad.left - 8} y={toY(tick) + 4} textAnchor="end" fontSize={10} fill="currentColor">{formatTokens(tick)}</text>
          </g>
        ))}
        {lines.map((l) => {
          const points = data.map((d, i) => `${toX(i)},${toY(d[l.key] as number)}`).join(" ");
          return <polyline key={l.key} points={points} fill="none" stroke={l.color} strokeWidth={2} opacity={0.85} />;
        })}
        {lines.map((l) => data.map((d, i) => (
          <circle key={`${l.key}-${i}`} cx={toX(i)} cy={toY(d[l.key] as number)} r={3} fill={l.color} opacity={0.9}>
            <title>{`${d.date} ${l.label}: ${formatTokens(d[l.key] as number)}`}</title>
          </circle>
        )))}
        {data.map((d, i) => (
          <text key={i} x={toX(i)} y={height - pad.bottom + 16} textAnchor="middle" fontSize={9} fill="currentColor"
            transform={`rotate(-30, ${toX(i)}, ${height - pad.bottom + 16})`}>{d.date.slice(5)}</text>
        ))}
        <line x1={pad.left} y1={pad.top} x2={pad.left} y2={pad.top + chartH} stroke="currentColor" opacity={0.25} />
        <line x1={pad.left} y1={pad.top + chartH} x2={width - pad.right} y2={pad.top + chartH} stroke="currentColor" opacity={0.25} />
      </svg>
    </div>
  );
}

// 响应时间趋势图
function ResponseTrendChart({ data, height = 180 }: { data: DayStat[]; height?: number }) {
  const filtered = data.filter(d => d.avgResponseMs > 0);
  if (filtered.length === 0) return <div className="flex items-center justify-center h-32 text-[var(--text-muted)] text-sm">暂无响应时间数据</div>;

  const pad = { top: 16, right: 16, bottom: 50, left: 56 };
  const width = Math.max(500, filtered.length * 56 + pad.left + pad.right);
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;
  const maxVal = Math.max(...filtered.map(d => d.avgResponseMs));

  const ticks = Array.from({ length: 5 }, (_, i) => Math.round((maxVal / 4) * i));
  function toX(i: number) { return pad.left + (i / (filtered.length - 1 || 1)) * chartW; }
  function toY(v: number) { return pad.top + chartH - (v / maxVal) * chartH; }

  const points = filtered.map((d, i) => `${toX(i)},${toY(d.avgResponseMs)}`).join(" ");

  return (
    <div className="overflow-x-auto">
      <svg width={width} height={height} className="text-[var(--text-muted)]">
        {ticks.map((tick, i) => (
          <g key={i}>
            <line x1={pad.left} y1={toY(tick)} x2={width - pad.right} y2={toY(tick)} stroke="currentColor" opacity={0.12} />
            <text x={pad.left - 8} y={toY(tick) + 4} textAnchor="end" fontSize={10} fill="currentColor">{formatMs(tick)}</text>
          </g>
        ))}
        <polyline points={points} fill="none" stroke="#f59e0b" strokeWidth={2} opacity={0.85} />
        {filtered.map((d, i) => (
          <circle key={i} cx={toX(i)} cy={toY(d.avgResponseMs)} r={3} fill="#f59e0b" opacity={0.9}>
            <title>{`${d.date}: ${formatMs(d.avgResponseMs)}`}</title>
          </circle>
        ))}
        {filtered.map((d, i) => (
          <text key={`l-${i}`} x={toX(i)} y={height - pad.bottom + 16} textAnchor="middle" fontSize={9} fill="currentColor"
            transform={`rotate(-30, ${toX(i)}, ${height - pad.bottom + 16})`}>{d.date.slice(5)}</text>
        ))}
        <line x1={pad.left} y1={pad.top} x2={pad.left} y2={pad.top + chartH} stroke="currentColor" opacity={0.25} />
        <line x1={pad.left} y1={pad.top + chartH} x2={width - pad.right} y2={pad.top + chartH} stroke="currentColor" opacity={0.25} />
      </svg>
    </div>
  );
}

// 时间格式化
function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

// 平台标签颜色（可点击跳转到对应平台的 session chat 页面）
function PlatformBadge({ platform, agentId, gatewayPort, gatewayToken }: { platform: Platform; agentId: string; gatewayPort: number; gatewayToken?: string }) {
  const isFeishu = platform.name === "feishu";

  let sessionKey: string;
  if (isFeishu && platform.botOpenId) {
    sessionKey = `agent:${agentId}:feishu:direct:${platform.botOpenId}`;
  } else if (!isFeishu && platform.botUserId) {
    sessionKey = `agent:${agentId}:discord:direct:${platform.botUserId}`;
  } else {
    sessionKey = `agent:${agentId}:main`;
  }
  let sessionUrl = `http://localhost:${gatewayPort}/chat?session=${encodeURIComponent(sessionKey)}`;
  if (gatewayToken) sessionUrl += `&token=${encodeURIComponent(gatewayToken)}`;

  return (
    <a
      href={sessionUrl}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      title="点击打开聊天页面"
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium cursor-pointer transition-all hover:scale-105 hover:shadow-md ${
        isFeishu
          ? "bg-blue-500/20 text-blue-300 border border-blue-500/30 hover:bg-blue-500/40 hover:border-blue-400"
          : "bg-purple-500/20 text-purple-300 border border-purple-500/30 hover:bg-purple-500/40 hover:border-purple-400"
      }`}
    >
      {isFeishu ? "📱 飞书" : "🎮 Discord"}
      {platform.accountId && (
        <span className="opacity-60">({platform.accountId})</span>
      )}
      <span className="opacity-50 text-[10px]">↗</span>
    </a>
  );
}

// 模型标签
function ModelBadge({ model }: { model: string }) {
  const [provider, modelName] = model.includes("/")
    ? model.split("/", 2)
    : ["default", model];

  const colors: Record<string, string> = {
    "yunyi-claude": "bg-green-500/20 text-green-300 border-green-500/30",
    minimax: "bg-orange-500/20 text-orange-300 border-orange-500/30",
    volcengine: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
    bailian: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
  };

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${
        colors[provider] || "bg-gray-500/20 text-gray-300 border-gray-500/30"
      }`}
    >
      🧠 {modelName}
    </span>
  );
}

// Agent 卡片（点击跳转到 agent 的 main session chat 页面）
function AgentCard({ agent, gatewayPort, gatewayToken }: { agent: Agent; gatewayPort: number; gatewayToken?: string }) {
  const sessionKey = `agent:${agent.id}:main`;
  let sessionUrl = `http://localhost:${gatewayPort}/chat?session=${encodeURIComponent(sessionKey)}`;
  if (gatewayToken) sessionUrl += `&token=${encodeURIComponent(gatewayToken)}`;

  return (
    <div
      onClick={() => window.open(sessionUrl, "_blank")}
      className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-5 hover:border-[var(--accent)] transition-colors cursor-pointer"
    >
      <div className="flex items-center gap-3 mb-3">
        <span className="text-3xl">{agent.emoji}</span>
        <div>
          <h3 className="text-lg font-semibold text-[var(--text)]">{agent.name}</h3>
          {agent.name !== agent.id && (
            <span className="text-xs text-[var(--text-muted)]">agentId: {agent.id}</span>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <div>
          <span className="text-xs text-[var(--text-muted)] block mb-1">模型</span>
          <ModelBadge model={agent.model} />
        </div>

        <div>
          <span className="text-xs text-[var(--text-muted)] block mb-1">平台</span>
          <div className="flex flex-wrap gap-1">
            {agent.platforms.map((p, i) => (
              <PlatformBadge key={i} platform={p} agentId={agent.id} gatewayPort={gatewayPort} gatewayToken={gatewayToken} />
            ))}
          </div>
        </div>

        {agent.platforms.some((p) => p.appId) && (
          <div>
            <span className="text-xs text-[var(--text-muted)] block mb-1">飞书 App ID</span>
            <code className="text-xs text-[var(--accent)] bg-[var(--bg)] px-2 py-0.5 rounded">
              {agent.platforms.find((p) => p.appId)?.appId}
            </code>
          </div>
        )}

        {agent.session && (
          <div className="pt-2 mt-2 border-t border-[var(--border)]">
            <div className="flex items-center justify-between text-xs">
              <span className="text-[var(--text-muted)]">会话数</span>
              <div className="flex items-center gap-2">
                <a
                  href={`/sessions?agent=${agent.id}`}
                  onClick={(e) => e.stopPropagation()}
                  className="text-[var(--accent)] hover:underline cursor-pointer"
                >
                  {agent.session.sessionCount} →
                </a>
                <a
                  href={`/stats?agent=${agent.id}`}
                  onClick={(e) => e.stopPropagation()}
                  className="text-[var(--accent)] hover:underline cursor-pointer text-[10px]"
                >
                  📊 统计
                </a>
              </div>
            </div>
            <div className="flex items-center justify-between text-xs mt-1">
              <span className="text-[var(--text-muted)]">Token 用量</span>
              <span className="text-[var(--text)]">{(agent.session.totalTokens / 1000).toFixed(1)}k</span>
            </div>
            {agent.session.lastActive && (
              <div className="flex items-center justify-between text-xs mt-1">
                <span className="text-[var(--text-muted)]">最近活跃</span>
                <span className="text-[var(--text)]">{formatTimeAgo(agent.session.lastActive)}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// 刷新选项
const REFRESH_OPTIONS = [
  { label: "手动刷新", value: 0 },
  { label: "10 秒", value: 10 },
  { label: "30 秒", value: 30 },
  { label: "1 分钟", value: 60 },
  { label: "5 分钟", value: 300 },
  { label: "10 分钟", value: 600 },
];

export default function Home() {
  const [data, setData] = useState<ConfigData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshInterval, setRefreshInterval] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [allStats, setAllStats] = useState<AllStats | null>(null);
  const [statsRange, setStatsRange] = useState<TimeRange>("daily");
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const fetchData = useCallback(() => {
    setLoading(true);
    Promise.all([
      fetch("/api/config").then((r) => r.json()),
      fetch("/api/stats-all").then((r) => r.json()),
    ])
      .then(([configData, statsData]) => {
        if (configData.error) setError(configData.error);
        else { setData(configData); setError(null); }
        if (!statsData.error) setAllStats(statsData);
        setLastUpdated(new Date().toLocaleTimeString("zh-CN"));
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  // 首次加载
  useEffect(() => { fetchData(); }, [fetchData]);

  // 定时刷新
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (refreshInterval > 0) {
      timerRef.current = setInterval(fetchData, refreshInterval * 1000);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [refreshInterval, fetchData]);

  if (error && !data) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-red-400">加载失败: {error}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-[var(--text-muted)]">加载中...</p>
      </div>
    );
  }

  return (
    <main className="min-h-screen p-8 max-w-6xl mx-auto">
      {/* 头部 */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            🐾 OpenClaw Bot Dashboard
          </h1>
          <p className="text-[var(--text-muted)] text-sm mt-1">
            共 {data.agents.length} 个机器人 · 默认模型: {data.defaults.model}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* 刷新控件 */}
          <div className="flex items-center gap-2">
            <select
              value={refreshInterval}
              onChange={(e) => setRefreshInterval(Number(e.target.value))}
              className="px-3 py-2 rounded-lg bg-[var(--card)] border border-[var(--border)] text-sm text-[var(--text)] cursor-pointer hover:border-[var(--accent)] transition"
            >
              {REFRESH_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.value === 0 ? "🔄 手动刷新" : `⏱️ ${opt.label}`}
                </option>
              ))}
            </select>
            {refreshInterval === 0 && (
              <button
                onClick={fetchData}
                disabled={loading}
                className="px-3 py-2 rounded-lg bg-[var(--card)] border border-[var(--border)] text-sm hover:border-[var(--accent)] transition disabled:opacity-50"
              >
                {loading ? "⏳" : "🔄"}
              </button>
            )}
          </div>
          {lastUpdated && (
            <span className="text-xs text-[var(--text-muted)]">
              更新于 {lastUpdated}
            </span>
          )}
          <Link
            href="/models"
            className="px-4 py-2 rounded-lg bg-[var(--accent)] text-[var(--bg)] text-sm font-medium hover:opacity-90 transition"
          >
            查看模型列表 →
          </Link>
        </div>
      </div>

      {/* 卡片墙 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {data.agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} gatewayPort={data.gateway?.port || 18789} gatewayToken={data.gateway?.token} />
        ))}
      </div>

      {/* 汇总统计趋势 */}
      {allStats && (
        <div className="mt-8 p-5 rounded-xl border border-[var(--border)] bg-[var(--card)]">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-[var(--text)]">📊 全局统计趋势</h2>
            <div className="flex rounded-lg border border-[var(--border)] overflow-hidden">
              {(Object.keys(RANGE_LABELS) as TimeRange[]).map((r) => (
                <button key={r} onClick={() => setStatsRange(r)}
                  className={`px-3 py-1 text-xs transition ${statsRange === r ? "bg-[var(--accent)] text-[var(--bg)] font-medium" : "bg-[var(--bg)] text-[var(--text-muted)] hover:text-[var(--text)]"}`}
                >{RANGE_LABELS[r]}</button>
              ))}
            </div>
          </div>
          {(() => {
            const currentData = allStats[statsRange];
            const totalInput = currentData.reduce((s, d) => s + d.inputTokens, 0);
            const totalOutput = currentData.reduce((s, d) => s + d.outputTokens, 0);
            const totalMsgs = currentData.reduce((s, d) => s + d.messageCount, 0);
            return (
              <>
                <div className="grid grid-cols-3 gap-3 mb-4">
                  <div className="p-3 rounded-lg bg-[var(--bg)] border border-[var(--border)]">
                    <div className="text-[10px] text-[var(--text-muted)]">总 Input Token</div>
                    <div className="text-lg font-bold text-blue-400">{formatTokens(totalInput)}</div>
                  </div>
                  <div className="p-3 rounded-lg bg-[var(--bg)] border border-[var(--border)]">
                    <div className="text-[10px] text-[var(--text-muted)]">总 Output Token</div>
                    <div className="text-lg font-bold text-emerald-400">{formatTokens(totalOutput)}</div>
                  </div>
                  <div className="p-3 rounded-lg bg-[var(--bg)] border border-[var(--border)]">
                    <div className="text-[10px] text-[var(--text-muted)]">总消息数</div>
                    <div className="text-lg font-bold text-purple-400">{totalMsgs}</div>
                  </div>
                </div>
                <div className="mb-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-[var(--text-muted)]">🔢 Token 消耗趋势</span>
                    <div className="flex items-center gap-3 text-[10px]">
                      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500 inline-block" /> Input</span>
                      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" /> Output</span>
                    </div>
                  </div>
                  <TrendChart data={currentData} lines={[
                    { key: "inputTokens", color: "#3b82f6", label: "Input" },
                    { key: "outputTokens", color: "#10b981", label: "Output" },
                  ]} />
                </div>
                {statsRange === "daily" && (
                  <div>
                    <span className="text-xs text-[var(--text-muted)]">⏱️ 平均响应时间趋势</span>
                    <ResponseTrendChart data={currentData} />
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}

      {/* 群聊管理 */}
      {data.groupChats && data.groupChats.length > 0 && (
        <div className="mt-8 p-4 rounded-xl border border-[var(--border)] bg-[var(--card)]">
          <h2 className="text-sm font-semibold text-[var(--text-muted)] mb-3">
            💬 群聊拓扑
          </h2>
          <div className="space-y-3">
            {data.groupChats.map((group, i) => (
              <div key={i} className="flex items-center gap-3 p-3 rounded-lg bg-[var(--bg)] border border-[var(--border)]">
                <span className="text-lg">{group.channel === "feishu" ? "📱" : "🎮"}</span>
                <div className="flex-1">
                  <div className="text-xs text-[var(--text-muted)] mb-1">
                    {group.channel === "feishu" ? "飞书群" : "Discord 频道"} · {group.groupId.split(":")[1]}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {group.agents.map((a) => (
                      <span key={a.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-[var(--card)] border border-[var(--border)]">
                        {a.emoji} {a.name}
                      </span>
                    ))}
                  </div>
                </div>
                <span className="text-xs text-[var(--text-muted)]">{group.agents.length} 个机器人</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Fallback 信息 */}
      {data.defaults.fallbacks.length > 0 && (
        <div className="mt-8 p-4 rounded-xl border border-[var(--border)] bg-[var(--card)]">
          <h2 className="text-sm font-semibold text-[var(--text-muted)] mb-2">
            🔄 Fallback 模型
          </h2>
          <div className="flex flex-wrap gap-2">
            {data.defaults.fallbacks.map((f, i) => (
              <ModelBadge key={i} model={f} />
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
