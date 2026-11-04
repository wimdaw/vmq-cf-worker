package com.vmq.monitor.util

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import com.vmq.monitor.R
import com.vmq.monitor.monitor.MonitorEngine

/**
 * 通知相关工具。
 *
 * 目前只有一个用途：发一条自检通知，验证「通知使用权」是否真的生效。
 * 自检通知同样会被 [NoticeService] 捕获并写入日志，所以不只验证「能弹」，
 * 还能验证「能被读到」。
 */
object Notifications {

    private const val CHANNEL_ID = "vmq_self_test"

    fun sendSelfTest(context: Context) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "自检测试",
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply { description = "验证通知监听是否生效" }
            manager.createNotificationChannel(channel)
        }

        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(MonitorEngine.SELF_TEST_TITLE)
            .setContentText("如果你在监控面板看到\"监听正常\"，说明通知使用权已生效")
            .setCategory(Notification.CATEGORY_STATUS)
            .setAutoCancel(true)
            .build()

        manager.notify(SELF_TEST_ID, notification)
    }

    private const val SELF_TEST_ID = 2001
}
