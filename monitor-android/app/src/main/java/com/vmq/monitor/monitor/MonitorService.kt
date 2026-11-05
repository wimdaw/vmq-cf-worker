package com.vmq.monitor.monitor

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.vmq.monitor.MainActivity
import com.vmq.monitor.R
import com.vmq.monitor.data.ConfigStore

/**
 * 前台服务：驱动心跳与推送重试。
 *
 * 为什么需要它：`NoticeService` 由系统绑定，用户撤销通知使用权、
 * 或者系统内存紧张时可能被回收；心跳与重试队列需要一个自己能控制的
 * 常驻载体。前台服务 + START_STICKY 是最稳的组合。
 *
 * 同时持有 `PARTIAL_WAKE_LOCK`：息屏后 CPU 不被挂起，
 * 保证心跳与推送不中断。锁是部分的，不会亮屏。
 */
class MonitorService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                buildNotification(),
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            )
        } else {
            startForeground(NOTIFICATION_ID, buildNotification())
        }

        val config = ConfigStore.get(this)
        if (config.configured) {
            HeartbeatManager.get(this).start()
            PushWorker.get(this).start()
            HeartbeatScheduler.start(this)
        }
        config.serviceEnabled = true

        acquireWakeLock()
        // 被系统杀掉后自动重启，并重新投递未完成的 Intent
        return START_STICKY
    }

    override fun onDestroy() {
        if (instance == this) instance = null
        HeartbeatScheduler.stop(this)
        HeartbeatManager.get(this).stop()
        PushWorker.get(this).stop()
        ConfigStore.get(this).serviceEnabled = false
        releaseWakeLock()
        super.onDestroy()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        // 用户在最近任务列表中划掉 Activity 时，服务依然保持运行
        val config = ConfigStore.get(this)
        if (config.configured && config.serviceEnabled) {
            val restartIntent = Intent(applicationContext, MonitorService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                applicationContext.startForegroundService(restartIntent)
            } else {
                applicationContext.startService(restartIntent)
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_TAG).apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    private fun releaseWakeLock() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
    }

    private fun buildNotification(): Notification {
        val config = ConfigStore.get(this)
        val text = when {
            !config.configured -> "尚未配置，去配置面板填写"
            else -> "监听中 · ${config.baseUrl}"
        }
        return buildNotificationWithText(text)
    }

    private fun buildNotificationWithText(text: String): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(open)
            .build()
    }

    fun updateNotificationText(text: String) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
        nm?.notify(NOTIFICATION_ID, buildNotificationWithText(text))
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "监控服务",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "常驻通知，显示监控端运行状态"
                setShowBadge(false)
            }
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .createNotificationChannel(channel)
        }
    }

    companion object {
        private const val CHANNEL_ID = "vmq_monitor_service"
        private const val NOTIFICATION_ID = 1001
        private const val WAKE_TAG = "vmq:monitor"

        const val ACTION_STOP = "com.vmq.monitor.action.STOP"

        @Volatile
        private var instance: MonitorService? = null

        fun updateStatus(text: String) {
            instance?.updateNotificationText(text)
        }

        fun start(context: Context) {
            val intent = Intent(context, MonitorService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.startService(
                Intent(context, MonitorService::class.java).setAction(ACTION_STOP)
            )
        }
    }
}
