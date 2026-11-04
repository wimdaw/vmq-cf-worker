package com.vmq.monitor

import androidx.test.core.app.ActivityScenario
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 启动冒烟测试：在 JVM 上跑真实框架代码。
 *
 * 覆盖：Application.onCreate → Activity 创建 → 主题 → 布局 inflate
 * → ViewBinding → Fragment 创建。这些路径上任何一处抛异常，
 * 在真机上就是"闪退打不开"。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LaunchSmokeTest {

    @Test
    fun `MainActivity launches without crashing`() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                // ViewPager 有 adapter = onCreate 全链路跑通
                val vp = activity.findViewById<androidx.viewpager2.widget.ViewPager2>(R.id.viewPager)
                assert(vp.adapter != null)
            }
        }
    }

    @Test
    fun `both fragments inflate without crashing`() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                // 直接构造三个面板并 inflate，覆盖 ViewPager 没预加载的那几个
                val monitor = com.vmq.monitor.ui.MonitorPanel()
                val config = com.vmq.monitor.ui.ConfigPanel()
                val about = com.vmq.monitor.ui.AboutPanel()
                activity.supportFragmentManager
                    .beginTransaction()
                    .add(monitor, "m")
                    .add(config, "c")
                    .add(about, "a")
                    .commitNow()
            }
        }
    }
}
