"use client";

import { useEffect, useState, useCallback } from "react";
import { useI18n } from "@/lib/i18n";

function resolveGatewayUrl(url?: string): string | undefined {
  if (!url || typeof window === "undefined") return url;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "localhost") parsed.hostname = window.location.hostname;
    return parsed.toString();
  } catch { return url; }
}

interface HealthResult {
  ok: boolean;
  error?: string;
  data?: any;
  webUrl?: string;
  openclawVersion?: string;
}

interface LogResult {
  ok: boolean;
  issues: string[];
  lastStallAt: string | null;
  stallActive: boolean;
}

interface GatewayStatusProps {
  compact?: boolean;
  className?: string;
  hideIconOnMobile?: boolean;
}

export function GatewayStatus({ compact = false, className = "", hideIconOnMobile = false }: GatewayStatusProps) {
  const { t } = useI18n();
  const [health, setHealth] = useState<HealthResult | null>(null);
  const [logResult, setLogResult] = useState<LogResult | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const [showVersionTip, setShowVersionTip] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartMsg, setRestartMsg] = useState<string | null>(null);

  const checkHealth = useCallback(() => {
    fetch("/api/gateway-health")
      .then((r) => r.json())
      .then((d: HealthResult) => {
        setHealth(d);
        // If health is down, also fetch logs for more context
        if (!d.ok) fetchLogs();
      })
      .catch(() => setHealth({ ok: false, error: t("gateway.fetchError") }));
  }, [t]);

  const fetchLogs = useCallback(() => {
    fetch("/api/gateway-logs")
      .then((r) => r.json())
      .then((d: LogResult) => setLogResult(d))
      .catch(() => {});
  }, []);

  useEffect(() => {
    checkHealth();
    const timer = setInterval(checkHealth, 10000);
    return () => clearInterval(timer);
  }, [checkHealth]);

  const handleDetailClick = useCallback(() => {
    setShowDetail((v) => !v);
    // Fetch fresh logs whenever the user opens the detail panel
    fetchLogs();
  }, [fetchLogs]);

  const handleRestart = useCallback(async () => {
    if (restarting) return;
    setRestarting(true);
    setRestartMsg(null);
    try {
      const res = await fetch("/api/gateway-restart", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        setRestartMsg("✅ 重啟指令已送出，稍後自動重新檢查…");
        setTimeout(() => {
          checkHealth();
          setRestartMsg(null);
          setShowDetail(false);
        }, 4000);
      } else {
        setRestartMsg(`❌ 重啟失敗：${data.error || "未知錯誤"}`);
      }
    } catch (err: any) {
      setRestartMsg(`❌ 重啟失敗：${err.message}`);
    } finally {
      setRestarting(false);
    }
  }, [restarting, checkHealth]);

  const gatewayTitle = health?.openclawVersion
    ? `OpenClaw ${health.openclawVersion}`
    : "OpenClaw";

  // Determine warning state: gateway alive but Telegram stalled
  const telegramStall = health?.ok && logResult?.stallActive === true;
  const showWarning = telegramStall;
  // Show restart button when: down, or Telegram stalled
  const showRestart = health !== null;

  return (
    <div className={`relative inline-flex items-center gap-1.5 ${className}`.trim()}>
      {/* Gateway link badge */}
      <a
        href={process.env.NEXT_PUBLIC_GATEWAY_CHAT_BASE_URL ?? "/"}
        target="_blank"
        rel="noopener noreferrer"
        title={gatewayTitle}
        onMouseEnter={() => setShowVersionTip(true)}
        onMouseLeave={() => setShowVersionTip(false)}
        onFocus={() => setShowVersionTip(true)}
        onBlur={() => setShowVersionTip(false)}
        className={`inline-flex items-center rounded-full font-medium border hover:bg-cyan-500/30 transition-colors cursor-pointer ${
          compact ? "px-2 py-1 text-[10px]" : "px-2 py-0.5 text-xs"
        } ${
          health?.ok
            ? "bg-cyan-500/25 text-cyan-200 border-cyan-400/45 animate-pulse"
            : "bg-cyan-500/20 text-cyan-300 border-cyan-500/30"
        }`}
      >
        {compact ? "GW" : hideIconOnMobile ? (
          <>
            <span className="md:hidden">Gateway</span>
            <span className="hidden md:inline">🦞 Gateway</span>
          </>
        ) : "🦞 Gateway"}
        <span className="opacity-50 text-[10px]">↗</span>
      </a>

      {showVersionTip && (
        <div className="absolute top-full left-0 mt-1 z-50 px-2 py-1 rounded-md bg-black/80 border border-white/10 text-white text-[10px] whitespace-nowrap shadow-lg pointer-events-none">
          {gatewayTitle}
        </div>
      )}

      {/* Health indicator */}
      {!health ? (
        <span className={compact ? "text-[10px] text-[var(--text-muted)]" : "text-xs text-[var(--text-muted)]"}>--</span>
      ) : health.ok && !showWarning ? (
        <span className={compact ? "text-green-400 text-xs cursor-help" : "text-green-400 text-sm cursor-help"} title={t("gateway.healthy")}>✅</span>
      ) : showWarning ? (
        <span
          className={compact ? "text-yellow-400 text-xs cursor-pointer" : "text-yellow-400 text-sm cursor-pointer"}
          title="Telegram 連線異常，建議重啟"
          onClick={handleDetailClick}
        >⚠️</span>
      ) : (
        <span
          className={compact ? "text-red-400 text-xs cursor-pointer" : "text-red-400 text-sm cursor-pointer"}
          title={health.error || t("gateway.unhealthy")}
          onClick={handleDetailClick}
        >❌</span>
      )}

      {/* Restart button — shown when there's a problem */}
      {showRestart && (
        <button
          onClick={handleDetailClick}
          className={`inline-flex items-center gap-1 rounded-full border font-medium transition-colors ${
            compact ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-xs"
          } bg-orange-500/20 text-orange-300 border-orange-500/40 hover:bg-orange-500/35 cursor-pointer`}
          title="查看問題並重啟 Gateway"
        >
          🔄{!compact && " 重啟"}
        </button>
      )}

      {/* Detail panel */}
      {showDetail && (
        <div className="absolute top-full left-0 mt-1 z-50 rounded-lg bg-[var(--card)] border border-[var(--border)] shadow-xl text-xs w-72 overflow-hidden">
          <div className="px-3 py-2 border-b border-[var(--border)] flex items-center justify-between">
            <span className="font-semibold text-[var(--text)]">Gateway 狀態</span>
            <button onClick={() => setShowDetail(false)} className="text-[var(--text-muted)] hover:text-[var(--text)] cursor-pointer">✕</button>
          </div>

          <div className="px-3 py-2 space-y-2">
            {/* Health status */}
            <div className="flex items-center gap-2">
              <span className="text-[var(--text-muted)]">Process：</span>
              <span className={health?.ok ? "text-green-400" : "text-red-400"}>
                {health?.ok ? "✅ 運作中" : "❌ 無回應"}
              </span>
            </div>

            {/* Telegram stall */}
            {logResult && logResult.issues.includes("telegram_stall") && (
              <div className="flex items-start gap-2">
                <span className="text-[var(--text-muted)] shrink-0">Telegram：</span>
                <span className="text-yellow-400">
                  ⚠️ Polling 異常
                  {logResult.lastStallAt && (
                    <span className="text-[var(--text-muted)] ml-1">
                      ({new Date(logResult.lastStallAt).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" })})
                    </span>
                  )}
                </span>
              </div>
            )}

            {/* Subagent timeout */}
            {logResult && logResult.issues.includes("subagent_timeout") && (
              <div className="flex items-center gap-2">
                <span className="text-[var(--text-muted)]">Subagent：</span>
                <span className="text-orange-400">⚠️ 有 timeout 記錄</span>
              </div>
            )}

            {/* Error message when down */}
            {health && !health.ok && health.error && (
              <div className="text-red-300 bg-red-500/10 rounded px-2 py-1.5 leading-relaxed">
                {health.error}
              </div>
            )}

            {/* Restart result message */}
            {restartMsg && (
              <div className={`rounded px-2 py-1.5 leading-relaxed ${
                restartMsg.startsWith("✅") ? "text-green-300 bg-green-500/10" : "text-red-300 bg-red-500/10"
              }`}>
                {restartMsg}
              </div>
            )}
          </div>

          {/* Restart button */}
          <div className="px-3 py-2 border-t border-[var(--border)]">
            <button
              onClick={handleRestart}
              disabled={restarting}
              className="w-full py-1.5 rounded-lg bg-orange-500/20 text-orange-300 border border-orange-500/40 hover:bg-orange-500/35 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer font-medium"
            >
              {restarting ? "⏳ 重啟中…" : "🔄 重啟 Gateway"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
