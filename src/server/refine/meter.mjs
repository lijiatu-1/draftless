// 记账：每一次回了话的模型调用记一笔（哪次听写、用的哪个型号、多少 token、多少钱、等了多久）。
// 两条链路共用：原生链路记听录音的那一次，本地转写链路记润色的那一次。
// 回了话但用不了的（被截断、被拦下）也收了钱，照记。没回话的拿不到用量、记不了：连不上的本来就不收钱；
// 发出去了却等不到回话（超时、断开）的对方可能照样收了钱，只记一条警告。

/**
 * @param {object} options
 * @param {{ id: string }} options.provider 是哪一家
 * @param {{ info: Function, warn: Function, error: Function }} options.log
 * @param {(record: object) => void} options.onCall 记账：{ purpose: "dictation" | "check" | "cache", audioId, provider,
 *   ...适配器带回的用量, latencyMs, createdAt }。它出错不影响这次听写
 * @returns {(purpose: string, audioId: string | null, call: () => Promise<object | null>) => Promise<object | null>}
 *   调一次适配器，回了话就记一笔，原样交回它的回话
 */
export function createMeter({ provider, log, onCall }) {
  return async function metered(purpose, audioId, call) {
    const startedAt = performance.now();
    let reply;
    try {
      reply = await call();
    } catch (error) {
      // 请求发出去了、我们等不及先断开的（超时、用户那头断了）：对方可能已经算完、照样收钱，账上会少这一笔。
      // 收没收没法知道，记一条警告，对账时有据可查
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        log.warn("model_call_unmetered", {
          purpose,
          audio_id: audioId,
          provider: provider.id,
          reason: error.name,
          latency_ms: Math.round(performance.now() - startedAt),
        });
      }
      throw error;
    }
    const latencyMs = Math.round(performance.now() - startedAt);
    // null：这一次没花钱（比如缓存正在建），没什么可记的
    if (reply === null) return null;
    if (!reply?.usage) {
      log.warn("usage_missing", { purpose, audio_id: audioId, provider: provider.id });
      return reply;
    }
    const { usage } = reply;
    // 只记数，不记成品：成品是用户说的话
    log.info("model_call", {
      purpose,
      audio_id: audioId,
      model: usage.model,
      input_tokens: usage.inputTokens,
      audio_tokens: usage.audioTokens,
      cached_tokens: usage.cachedTokens,
      output_tokens: usage.outputTokens,
      thinking_tokens: usage.thinkingTokens,
      cost_usd: usage.costUsd,
      latency_ms: latencyMs,
    });
    try {
      onCall({ purpose, audioId, provider: provider.id, ...usage, latencyMs, createdAt: new Date().toISOString() });
    } catch (error) {
      // 账没记上只是少一笔统计，不能因此把用户的这句话丢掉
      log.error("model_call_not_recorded", { audio_id: audioId, error: String(error?.stack ?? error) });
    }
    return reply;
  };
}
