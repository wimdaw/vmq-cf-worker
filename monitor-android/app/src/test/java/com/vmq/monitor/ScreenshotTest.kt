package com.vmq.monitor

import android.content.ComponentName
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import androidx.test.core.app.ActivityScenario
import com.vmq.monitor.data.ConfigStore
import com.vmq.monitor.data.LogStore
import com.vmq.monitor.data.NoticeLog
import com.vmq.monitor.data.StateStore
import com.vmq.monitor.monitor.NoticeService
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.time.Duration

/**
 * 把界面渲染成 PNG，用来肉眼检查布局。
 *
 * 不是断言测试 —— 它只负责产出图片（`build/screenshots/` 下的 PNG）。
 * 之所以走 Robolectric 而不是模拟器：arm64 镜像的 AVD 在 x86 主机上起不来。
 * NATIVE 图形模式走真实 Skia 绘制，中文字体也能正常出字。
 *
 * 一次跑出三张：空状态 / 运行中（带日志）/ 配置页。
 * 空状态和运行中放在同一个用例里，避免跨用例复用单例 DB 句柄。
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "zh-rCN-w411dp-h1180dp-xxhdpi")
class ScreenshotTest {

    private fun capture(scenario: ActivityScenario<MainActivity>, name: String) {
        scenario.onActivity { activity ->
            shadowOf(Looper.getMainLooper()).idle()
            val root = activity.window.decorView
            if (root.width == 0 || root.height == 0) {
                root.measure(
                    View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(2340, View.MeasureSpec.EXACTLY)
                )
                root.layout(0, 0, root.measuredWidth, root.measuredHeight)
            }
            val bmp = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
            root.draw(Canvas(bmp))

            val dir = File("build/screenshots").apply { mkdirs() }
            File(dir, "$name.png").outputStream().use {
                bmp.compress(Bitmap.CompressFormat.PNG, 100, it)
            }
        }
    }

    @Test
    fun `capture scan page`() {
        // 只 inflate 布局、不启动 Activity：走 onResume 会去开相机，Robolectric 里没有。
        // 取景框由 ViewfinderView 在 onSizeChanged 里算，所以必须真的 measure + layout。
        val themed = android.view.ContextThemeWrapper(
            androidx.test.core.app.ApplicationProvider.getApplicationContext(),
            R.style.Theme_VmqMonitor_Scan
        )
        val view = android.view.LayoutInflater.from(themed)
            .inflate(R.layout.activity_scan, null)
        view.measure(
            View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(2340, View.MeasureSpec.EXACTLY)
        )
        view.layout(0, 0, view.measuredWidth, view.measuredHeight)

        val bmp = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bmp))
        val dir = File("build/screenshots").apply { mkdirs() }
        File(dir, "scan.png").outputStream().use {
            bmp.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
    }

    @Test
    fun `capture empty and running states`() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            capture(scenario, "monitor_empty")

            scenario.onActivity { it.openConfigTab() }
            capture(scenario, "config_empty")

            scenario.onActivity { activity ->
                activity.findViewById<androidx.viewpager2.widget.ViewPager2>(R.id.viewPager)
                    .currentItem = 2
            }
            capture(scenario, "about")

            // 灌一份「看起来正常」的数据：地址 + 密钥 + 两个通道 + 心跳 + 一批不同结果的日志。
            // 这些图会进 README，所以：域名用 pay.example.com、密钥用 testkey0001，
            // 文案只用平台通知模板，不出现任何真实昵称 / 订单号 / 金额。
            scenario.onActivity { activity ->
                val cfg = ConfigStore.get(activity)
                cfg.host = "pay.example.com"
                cfg.commKey = "testkey0001"
                cfg.setPassage(1, "8")
                cfg.setPassage(2, "9")
                cfg.serviceEnabled = true

                // 伪造「已授权」状态，让运行条件显示 3/3。
                // 真机上这两项要用户手动授予，截图里呈现「就绪」才像正常使用的样子。
                val cn = ComponentName(activity, NoticeService::class.java)
                Settings.Secure.putString(
                    activity.contentResolver,
                    "enabled_notification_listeners",
                    cn.flattenToString()
                )
                val pm = activity.getSystemService(Context.POWER_SERVICE) as PowerManager
                shadowOf(pm).setIgnoringBatteryOptimizations(activity.packageName, true)

                // 光有「权限在允许列表里」还不够 —— 面板要求服务真的绑着（isConnected）。
                // Robolectric 不会绑 NotificationListenerService，直接反射把时间戳置上，
                // 比走 buildService().create() 触发完整生命周期安全（onCreate 会起 engine）。
                //
                // 注意字段在**外部类**上：companion object 里的 private var 会被 Kotlin
                // 编译成 NoticeService 的静态字段，不在 NoticeService$Companion 里
                // （它的 declaredFields 是空的）。
                runCatching {
                    NoticeService::class.java.getDeclaredField("connectedAt").apply {
                        isAccessible = true
                        setLong(null, System.currentTimeMillis())
                    }
                }

                val now = System.currentTimeMillis() / 1000
                val state = StateStore.get(activity)
                state.setLastHeart(now - 6)
                state.setHeartFail(0)

                val logs = LogStore.get(activity)
                logs.clear()
                // 按时间从旧到新插：recent() 是 ORDER BY id DESC，先插的排后面。
                // 八条覆盖四种状态（已入队 / 未配置通道 / 没取到金额 / 未匹配），
                // 让「最近通知」这一栏能看出每种颜色代表什么。
                data class L(
                    val ago: Long, val platform: Int, val pkg: String,
                    val title: String, val content: String,
                    val amount: String?, val status: String
                )

                val rows = listOf(
                    L(7200, 0, "com.tencent.mm", "张三", "在吗", null, "未匹配"),
                    L(3600, 2, "com.eg.android.AlipayGphone", "收钱码",
                        "二维码收钱必读\n通过扫码向你付款66.66元", "66.66", "已入队"),
                    L(2700, 0, "com.android.systemui", "截图", "已保存截图", null, "未匹配"),
                    L(1680, 1, "com.tencent.mm", "微信支付",
                        "微信支付收款5.20元", "5.20", "已入队"),
                    L(900, 2, "com.eg.android.AlipayGphone", "收款通知",
                        "收款通知\n你已成功收款", null, "没取到金额"),
                    L(420, 1, "com.tencent.mm", "微信支付",
                        "微信支付收款88.88元", "88.88", "已入队"),
                    L(120, 2, "com.eg.android.AlipayGphone", "收钱码",
                        "通过扫码向你付款0.12元", "0.12", "未配置通道"),
                    L(8, 1, "com.tencent.mm", "微信支付",
                        "微信支付收款18.00元", "18.00", "已入队")
                )
                for (r in rows) {
                    logs.insert(
                        NoticeLog(
                            ts = now - r.ago, platform = r.platform, pkg = r.pkg,
                            title = r.title, content = r.content,
                            amount = r.amount, status = r.status
                        )
                    )
                }

                activity.findViewById<androidx.viewpager2.widget.ViewPager2>(R.id.viewPager)
                    .currentItem = 0
            }
            // 面板每 2 秒自刷一次，把时钟推过去让它读到新数据
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(3))
            capture(scenario, "monitor_running")

            // 再切到配置页截一张「已配置」的 —— 上面那张 config_empty 是空状态
            scenario.onActivity { it.openConfigTab() }
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1))
            capture(scenario, "config_filled")
        }
    }
}
