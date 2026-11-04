package com.vmq.monitor

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.vmq.monitor.data.ConfigStore
import com.vmq.monitor.data.StateStore
import com.vmq.monitor.monitor.HeartbeatManager
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 使用本地拒绝连接验证真实网络调用下的按轮失败计数。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class HeartbeatRoundTest {

    private lateinit var ctx: Context
    private lateinit var config: ConfigStore

    @Before
    fun setUp() {
        ctx = ApplicationProvider.getApplicationContext()
        config = ConfigStore(ctx)
        config.clearAll()
        config.host = "127.0.0.1:1"
        config.commKey = "test-key"
        // 三个通道：微信 / 支付宝 / 数币
        config.setPassage(1, "8")
        config.setPassage(2, "9")
        config.setPassage(4, "7")
        StateStore.get(ctx).setHeartFail(0)
        StateStore.get(ctx).setLastHeart(0)
    }

    @After
    fun tearDown() {
        HeartbeatManager.get(ctx).stop()
        config.clearAll()
    }

    @Test
    fun `three failing passages in one round count as one failure`() {
        HeartbeatManager.get(ctx).start()

        // 等第一轮跑完（3 个通道各一次必然失败的请求，本地拒绝很快）
        val deadline = System.currentTimeMillis() + 10_000
        while (StateStore.get(ctx).heartFail() == 0 && System.currentTimeMillis() < deadline) {
            Thread.sleep(50)
        }

        // 按通道计数的话这里会是 3
        assertEquals(1, HeartbeatManager.get(ctx).failStreak())
        // 失败不能刷新"最后一次成功"，否则 offline 会被误判成 healthy
        assertEquals(false, HeartbeatManager.get(ctx).healthy())
    }
}
