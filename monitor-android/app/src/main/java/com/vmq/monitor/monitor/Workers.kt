package com.vmq.monitor.monitor

import android.content.Context
import com.vmq.monitor.data.PushStore
import com.vmq.monitor.data.StateStore
import com.vmq.monitor.net.ApiClient
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * 推送重试。
 *
 * 到账推送失败后落在 `pending_push` 表里，由这个循环持续重试，
 * 进程被杀也不丢（SQLite 持久化）。
 *
 * 「下次可重试的时刻」存在 `next_at` 列上，每轮只取到期的条目 ——
 * 不把退避时间睡在循环里，否则一条 attempts 很高的记录会把后面所有
 * 条目一起堵住。
 *
 * 轮询间隔自适应：队列空时 30 秒（绝大多数时间），刚处理过一批才 2 秒。
 * 这两个值都是**上限**而不是固定延迟 —— 新通知入队时 [wake] 会立刻叫醒
 * 循环，所以到账不会因为轮询间隔而变慢。
 */
class PushWorker private constructor(context: Context) {

    private val appContext = context.applicationContext
    private val pushStore = PushStore.get(appContext)
    private val stateStore = StateStore.get(appContext)
    private val api = ApiClient(com.vmq.monitor.data.ConfigStore.get(appContext))

    private var job: Job? = null

    fun start() {
        if (job?.isActive == true) return
        job = CoroutineScope(Dispatchers.Default).launch {
            while (isActive) {
                // 只取 next_at <= now 的；退避中的留在库里等下一轮
                val due = pushStore.due()
                for (item in due) {
                    if (!isActive) break
                    val result = api.push(item.type, item.price, item.pid)
                    if (result.ok) {
                        pushStore.remove(item.id)
                    } else {
                        pushStore.bump(item.id, item.attempts)
                    }
                }
                // 自适应间隔：空队列 30 秒，刚处理过一批 2 秒。
                // 两者都是上限 —— 新入队会通过 wake 立刻叫醒，不拖慢到账。
                val waitMs = if (due.isEmpty()) IDLE_INTERVAL_MS else BUSY_INTERVAL_MS
                withTimeoutOrNull(waitMs) { wake.receive() }
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
    }

    /** 待推送条数，UI 显示 */
    fun pendingCount(): Int = pushStore.count()

    /** 重试很多次仍失败的（需要用户介入，例如网络长期不通） */
    fun stuckCount(): Int = pushStore.stuck().size

    companion object {
        /** 队列空时的轮询间隔 —— 绝大多数时间走这条路 */
        private const val IDLE_INTERVAL_MS = 30_000L

        /** 刚处理过一批时的快轮询，保证积压场景重试及时 */
        private const val BUSY_INTERVAL_MS = 2_000L

        /**
         * 唤醒信号（CONFLATED：连发多次只保留一次）。
         *
         * 队列空时循环最多睡 IDLE_INTERVAL_MS，但**入队会立刻唤醒** ——
         * 否则用户付款后最坏要等满 30 秒才发出第一次推送。
         */
        private val wake = Channel<Unit>(Channel.CONFLATED)

        @Volatile
        private var instance: PushWorker? = null

        fun get(context: Context): PushWorker =
            instance ?: synchronized(this) {
                instance ?: PushWorker(context).also { instance = it }
            }

        /** 确保在跑（供引擎入队后调用） */
        fun ensureRunning(context: Context) {
            get(context).start()
            // 有新条目入队：立刻唤醒推送循环，不必等下一次轮询
            wake.trySend(Unit)
        }
    }
}

/**
 * 心跳管理。
 *
 * 一轮 = 所有通道各发一次，**任意通道成功即算这轮成功**。
 *
 *   - 失败**不停**定时器，继续按 30 秒节奏重试
 *   - 连续 5 轮全失败才冷却 60 秒，避免持续发无效请求
 *   - 状态写进 `monitor_state`，面板上能看见
 *
 * 计数只有一份，存在 `monitor_state.heart_fail` —— 进程重启后天然一致，
 * 不需要「启动时从库里恢复」这种补丁。每轮读写一次，开销可忽略。
 *
 * 按「轮」而不是按「通道」计数：同一个 host + 同一把 key，全通或全断
 * 才是常态；单个 pid 失败多半是那个通道配错了，这时候把其他正常通道
 * 一起暂停只会让情况更糟。
 */
class HeartbeatManager private constructor(context: Context) {

    private val appContext = context.applicationContext
    private val config = com.vmq.monitor.data.ConfigStore.get(appContext)
    private val stateStore = StateStore.get(appContext)
    private val api = ApiClient(config)

    private var job: Job? = null

    /** 是否处于"连续失败后的冷却期"。瞬态，不持久化 —— 重启就该立刻重试 */
    private var paused = false

    fun start() {
        if (job?.isActive == true) return
        // 每次 start 都从"不冷却"开始：用户刚打开服务应该立刻试一次，
        // 而不是继承上一个 job 残留的 paused。
        paused = false
        job = CoroutineScope(Dispatchers.Default).launch {
            while (isActive) {
                if (!config.configured) {
                    delay(HEART_INTERVAL_MS)
                    continue
                }
                doHeartbeatRound()
                if (paused) {
                    delay(PAUSE_MS)
                    paused = false
                } else {
                    delay(HEART_INTERVAL_MS)
                }
            }
        }
    }

    /**
     * 执行一轮心跳请求（由内部协程循环或外部 AlarmManager 定时唤醒调用）。
     */
    suspend fun doHeartbeatRound(): Boolean {
        if (!config.configured) return false
        val passages = config.allPassages()
        var anyOk = false
        if (passages.isEmpty()) {
            anyOk = sendOnce("")
        } else {
            for ((_, pid) in passages) {
                if (sendOnce(pid)) anyOk = true
            }
        }
        finishRound(anyOk)
        return anyOk
    }

    /**
     * 发一次心跳。
     *
     * 只有成功才更新"最后一次成功时刻" —— [healthy] 靠它判断 90 秒窗口，
     * 失败时不能刷这个值，否则离线会被误判成在线。
     */
    private suspend fun sendOnce(pid: String): Boolean {
        val ok = api.heart(pid).ok
        if (ok) stateStore.setLastHeart(System.currentTimeMillis() / 1000)
        return ok
    }

    private val timeFormat = SimpleDateFormat("HH:mm:ss", Locale.getDefault())

    /** 一轮（所有通道都试过）结束后的状态更新。DB 是唯一真源。 */
    private fun finishRound(ok: Boolean) {
        if (ok) {
            if (stateStore.heartFail() != 0) stateStore.setHeartFail(0)
            paused = false
            MonitorService.updateStatus("监听中 · 心跳正常 (${timeFormat.format(Date())})")
        } else {
            val n = stateStore.heartFail() + 1
            stateStore.setHeartFail(n)
            if (n >= MAX_FAIL_BEFORE_PAUSE) {
                // 连续失败：冷却一分钟再试，但**不停止**
                paused = true
                MonitorService.updateStatus("心跳异常 · 连续失败 ${n} 次")
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
        paused = false
    }

    /** 心跳是否正常（最近 90 秒内有成功） */
    fun healthy(): Boolean {
        val last = stateStore.lastHeart()
        return last > 0 && System.currentTimeMillis() / 1000 - last <= 90
    }

    fun failStreak(): Int = stateStore.heartFail()

    fun lastHeartAt(): Long = stateStore.lastHeart()

    companion object {
        private const val HEART_INTERVAL_MS = 30_000L
        private const val MAX_FAIL_BEFORE_PAUSE = 5
        private const val PAUSE_MS = 60_000L

        @Volatile
        private var instance: HeartbeatManager? = null

        fun get(context: Context): HeartbeatManager =
            instance ?: synchronized(this) {
                instance ?: HeartbeatManager(context).also { instance = it }
            }
    }
}
