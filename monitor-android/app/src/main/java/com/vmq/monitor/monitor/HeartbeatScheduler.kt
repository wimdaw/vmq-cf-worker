package com.vmq.monitor.monitor

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import com.vmq.monitor.data.ConfigStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * 硬件级心跳调度器（基于 AlarmManager）。
 *
 * 为什么需要它：
 * 手机锁屏或切换至后台挂机后，Android 系统进入 Doze 模式且 CPU 休眠。
 * 此时普通协程的 delay() 或定时线程会被系统挂起冻结，导致心跳停滞。
 *
 * AlarmManager 配合 ELAPSED_REALTIME_WAKEUP 能够在休眠状态下由硬件 RTC 唤醒 CPU，
 * 在 WakeLock 保护下完成网络请求后再进入低功耗状态，确保息屏挂机心跳永不中断。
 */
object HeartbeatScheduler {

    const val ACTION_PULSE = "com.vmq.monitor.action.HEARTBEAT_PULSE"
    private const val REQUEST_CODE = 2001
    private const val INTERVAL_MS = 30_000L

    fun start(context: Context) {
        scheduleNext(context.applicationContext)
    }

    fun stop(context: Context) {
        val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        val pi = getPendingIntent(context.applicationContext)
        am.cancel(pi)
    }

    fun scheduleNext(context: Context) {
        val config = ConfigStore.get(context)
        if (!config.configured || !config.serviceEnabled) return

        val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        val pi = getPendingIntent(context)
        val triggerAt = SystemClock.elapsedRealtime() + INTERVAL_MS

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi)
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
                am.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi)
            } else {
                am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi)
            }
        } catch (_: SecurityException) {
            // Android 12+ 若缺少精确闹钟权限，降级为 setAndAllowWhileIdle
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi)
            } else {
                am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi)
            }
        }
    }

    private fun getPendingIntent(context: Context): PendingIntent {
        val intent = Intent(context, HeartbeatReceiver::class.java).apply {
            action = ACTION_PULSE
        }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getBroadcast(context, REQUEST_CODE, intent, flags)
    }
}

/**
 * 接收定时唤醒广播并执行心跳。
 */
class HeartbeatReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != HeartbeatScheduler.ACTION_PULSE) return

        val appContext = context.applicationContext
        val config = ConfigStore.get(appContext)
        if (!config.configured || !config.serviceEnabled) return

        // 立即调度下一次闹钟，保持循环
        HeartbeatScheduler.scheduleNext(appContext)

        val pm = appContext.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val wakeLock = pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "vmq:heartbeat_pulse")?.apply {
            setReferenceCounted(false)
            acquire(15_000L) // 最多持有 15 秒防止异常耗电
        }

        val pendingResult = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                HeartbeatManager.get(appContext).doHeartbeatRound()
            } finally {
                try {
                    if (wakeLock?.isHeld == true) wakeLock.release()
                } catch (_: Exception) {}
                pendingResult.finish()
            }
        }
    }
}
