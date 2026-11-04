package com.vmq.monitor

import android.app.Application
import com.vmq.monitor.data.ConfigStore

class MonitorApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // 提前初始化，避免首次读取时的 IO 抖动
        ConfigStore.get(this)
    }
}
