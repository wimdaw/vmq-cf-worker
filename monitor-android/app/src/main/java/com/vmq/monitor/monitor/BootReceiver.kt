package com.vmq.monitor.monitor

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.vmq.monitor.data.ConfigStore

/**
 * 开机自启。
 *
 * 没有它，手机重启后要用户手动打开 App 才能恢复监控，
 * 半夜重启一次就可能漏一整晚的单。这里在配置就绪时自动拉起。
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED -> {
                val config = ConfigStore.get(context)
                if (config.configured) MonitorService.start(context)
            }
        }
    }
}
