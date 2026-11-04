package com.vmq.monitor.monitor

import android.app.Notification
import android.content.ComponentName
import android.content.Context
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import com.vmq.monitor.data.ConfigStore

/**
 * 通知监听。
 *
 * 这是监控端**唯一**必须由系统提供的原生能力：
 *   - 用户授予「通知使用权」后由系统绑定
 *   - 每条新通知触发 [onNotificationPosted]
 *
 * 两道过滤：
 *   1. 常驻通知（`FLAG_ONGOING_EVENT`）直接跳过 —— 音乐播放、下载进度
 *      这类通知会反复触发，喂给匹配逻辑只是噪音
 *   2. 相同内容 5 秒内去重 —— 微信偶尔会连发两条一样的通知，
 *      服务端虽然幂等但日志会被污染
 */
class NoticeService : NotificationListenerService() {

    private lateinit var engine: MonitorEngine
    private var config: ConfigStore? = null

    /**
     * 相同内容 5 秒内去重。
     *
     * 注意：不能用"只记最后一条"的写法 —— 微信/支付宝交替来通知时，
     * A→B→A 里的第二个 A 会漏掉。见 [NoticeDeduper]。
     */
    private val deduper = NoticeDeduper()

    override fun onCreate() {
        super.onCreate()
        engine = MonitorEngine.get(this)
        config = ConfigStore.get(this)
    }

    override fun onListenerConnected() {
        super.onListenerConnected()
        connectedAt = System.currentTimeMillis()
        // 服务被系统重新绑定时会走到这里，此时应确保心跳在跑
        if (config?.configured == true) {
            HeartbeatManager.get(this).start()
            PushWorker.get(this).start()
        }
    }

    override fun onListenerDisconnected() {
        super.onListenerDisconnected()
        // 被系统解绑（常见于用户关掉通知使用权）。心跳继续跑，
        // 这样恢复授权后能立刻重新上线，不用用户再点一次。
        connectedAt = 0
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val notification = sbn.notification ?: return
        if (notification.flags and Notification.FLAG_ONGOING_EVENT != 0) return

        val extras = notification.extras ?: return
        val pkg = sbn.packageName ?: return

        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: ""
        val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString() ?: ""
        val bigText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString() ?: ""

        // 正文：优先取 bigText（展开态，信息最全），否则 text
        val content = when {
            bigText.isNotBlank() -> bigText
            else -> text
        }
        if (title.isBlank() && content.isBlank()) return
        if (deduper.isDuplicate("$pkg|$title|$content")) return

        engine.handleNotice(pkg, title, "$title\n$content")
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification) {
        // 不需要处理
    }

    companion object {
        /**
         * 服务最近一次被系统绑定的时刻。0 = 没连上。
         *
         * 为什么要单独记：`isPermissionGranted()` 只读
         * `Settings.Secure.enabled_notification_listeners` —— 那是"用户允许了"，
         * 不等于"服务真的连上了"。两者会脱节，最典型的是 `adb shell am force-stop`
         * 或系统强杀之后：权限还挂在允许列表里，服务却不会被自动重绑，
         * 界面显示"已授予"、实际一条通知都收不到。
         */
        @Volatile
        private var connectedAt = 0L

        /** 服务当前是否真的绑着（能收到 onNotificationPosted） */
        fun isConnected(): Boolean = connectedAt > 0

        /**
         * 用户是否已授予「通知使用权」。
         *
         * 框架没有公开 API 可查（NotificationManagerCompat 也没有对应方法），
         * 只能读 Settings.Secure 的 enabled_notification_listeners。
         * 不同 ROM 的这个值格式有差异（有的带包名前缀，有的不带），
         * 所以长短两种 ComponentName 形式都检查一遍，避免漏判。
         */
        fun isPermissionGranted(context: Context): Boolean {
            return try {
                val enabled = Settings.Secure.getString(
                    context.contentResolver,
                    "enabled_notification_listeners"
                ) ?: return false
                val cn = ComponentName(context, NoticeService::class.java)
                enabled.contains(cn.flattenToString()) ||
                    enabled.contains(cn.flattenToShortString())
            } catch (e: Exception) {
                false
            }
        }
    }
}
