package com.vmq.monitor.monitor

/**
 * 通知去重。
 *
 * 为什么要有它：微信偶尔会对同一笔到账连发两条通知（尤其网络抖动重推时）。
 * 服务端虽然幂等，但日志里会多出一条看起来像「重复收款」的记录，排查时很误导。
 *
 * 判定依据是「窗口内出现过的**所有** key」，不是只记最后一条 ——
 * 后者在 `A → B → A` 这种交错场景下，第二个 A 不会被去重。
 *
 * 内存有界：只保留 [windowMs] 内出现过的 key，超时即删；
 * 5 秒内的通知条数天然很少，不需要额外的容量上限。
 */
class NoticeDeduper(private val windowMs: Long = DEFAULT_WINDOW_MS) {

    private val seen = LinkedHashMap<String, Long>()

    /**
     * @param key 去重键（通常是 `包名|标题|正文`）
     * @param now 当前时间戳，测试时注入
     * @return true 表示 [windowMs] 内已经出现过同样的 key，应丢弃
     */
    fun isDuplicate(key: String, now: Long = System.currentTimeMillis()): Boolean {
        synchronized(seen) {
            val it = seen.entries.iterator()
            while (it.hasNext()) {
                if (now - it.next().value >= windowMs) it.remove()
            }
            // 清理完还留着，说明它在窗口内
            val last = seen[key]
            seen[key] = now
            return last != null
        }
    }

    /** 当前跟踪的条目数，仅供测试断言内存不膨胀 */
    internal fun size(): Int = synchronized(seen) { seen.size }

    companion object {
        const val DEFAULT_WINDOW_MS = 5_000L
    }
}
