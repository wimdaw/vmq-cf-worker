package com.vmq.monitor.monitor

import android.content.Context
import com.vmq.monitor.data.ConfigStore
import com.vmq.monitor.data.LogStore
import com.vmq.monitor.data.NoticeLog
import com.vmq.monitor.data.PushStore
import com.vmq.monitor.data.StateStore
import java.util.concurrent.CopyOnWriteArraySet
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/** 一条通知的处理结果，UI 用来提示用户 */
sealed class NoticeOutcome {
    /** 识别到账并入队推送 */
    data class Pushed(val platform: Int, val amount: String, val queued: Boolean) : NoticeOutcome()
    /** 是自己发的测试通知 */
    object SelfTest : NoticeOutcome()
    /** 没命中任何规则 */
    data class Ignored(val pkg: String, val title: String) : NoticeOutcome()
    /** 命中了规则但金额没取到 */
    data class NoAmount(val platform: Int) : NoticeOutcome()
    /** 命中了规则但该类型没有配通道 */
    data class NoPassage(val platform: Int, val amount: String) : NoticeOutcome()
}

/**
 * 监控引擎：匹配 → 提取金额 → 入队。
 *
 * 只在后台线程跑，不阻塞通知回调。
 */
class MonitorEngine private constructor(private val appContext: Context) {

    private val config = ConfigStore.get(appContext)
    private val logStore = LogStore.get(appContext)
    private val pushStore = PushStore.get(appContext)
    private val stateStore = StateStore.get(appContext)
    private val scope = CoroutineScope(Dispatchers.Default)

    /**
     * 处理一条通知。
     *
     * @param pkg      来源包名
     * @param title    通知标题
     * @param text     通知正文（已把 title/text/bigText 拼起来）
     */
    fun handleNotice(pkg: String, title: String, text: String) {
        scope.launch {
            // 自己的测试通知：用来验证「通知使用权」是否真的生效
            if (pkg == appContext.packageName && title == SELF_TEST_TITLE) {
                notifySelfTest()
                return@launch
            }

            val rule = Rules.list.firstOrNull { it.matches(pkg, title, text) }
            if (rule == null) {
                // 未命中也记日志：静默丢弃的话，微信改一次文案就会整晚漏单而无人知晓
                writeLog(0, pkg, title, text, null, "未匹配")
                emit(NoticeOutcome.Ignored(pkg, title))
                return@launch
            }

            val source = if (rule.moneyFrom == MoneySource.TITLE) title else text
            val amount = MoneyExtractor.extract(source)
            if (amount == null) {
                writeLog(rule.type, pkg, title, text, null, "命中规则但未取到金额")
                emit(NoticeOutcome.NoAmount(rule.type))
                return@launch
            }

            val pid = config.getPassage(rule.type)
            if (pid.isEmpty()) {
                // 金额取到了但没配通道：记日志并提示，不能静默丢掉
                writeLog(rule.type, pkg, title, text, amount, "未配置通道")
                emit(NoticeOutcome.NoPassage(rule.type, amount))
                return@launch
            }

            // 用通知到达时刻作为 t（而不是服务端收到时刻），
            // 这样服务端做时间窗防重放校验时更准
            val t = System.currentTimeMillis() / 1000
            pushStore.enqueue(rule.type, amount, t, pid)
            writeLog(rule.type, pkg, title, text, amount, "已入队")
            stateStore.setLastNotice(t)
            emit(NoticeOutcome.Pushed(rule.type, amount, queued = true))
            PushWorker.ensureRunning(appContext)
        }
    }

    private suspend fun writeLog(
        platform: Int,
        pkg: String,
        title: String,
        content: String,
        amount: String?,
        status: String
    ) {
        logStore.insert(
            NoticeLog(
                ts = System.currentTimeMillis() / 1000,
                platform = platform,
                pkg = pkg,
                title = title,
                content = content.take(600),
                amount = amount,
                status = status
            )
        )
        logStore.trim()
    }

    private fun emit(outcome: NoticeOutcome) {
        lastOutcome = outcome
        listeners.forEach { l ->
            try {
                l(outcome)
            } catch (e: Exception) {
                // UI 监听抛异常不能影响后台处理
            }
        }
    }

    private fun notifySelfTest() {
        lastSelfTestAt = System.currentTimeMillis()
        emit(NoticeOutcome.SelfTest)
    }

    companion object {
        const val SELF_TEST_TITLE = "V免签监控端 · 自检"

        @Volatile
        private var instance: MonitorEngine? = null

        fun get(context: Context): MonitorEngine =
            instance ?: synchronized(this) {
                instance ?: MonitorEngine(context.applicationContext).also { instance = it }
            }

        private val listeners = CopyOnWriteArraySet<(NoticeOutcome) -> Unit>()
        private var lastOutcome: NoticeOutcome? = null
        private var lastSelfTestAt: Long = 0

        fun addListener(l: (NoticeOutcome) -> Unit) {
            listeners.add(l)
        }

        fun removeListener(l: (NoticeOutcome) -> Unit) {
            listeners.remove(l)
        }

        fun selfTestOk(): Boolean = lastSelfTestAt > 0
        fun lastSelfTestTime(): Long = lastSelfTestAt
    }
}
