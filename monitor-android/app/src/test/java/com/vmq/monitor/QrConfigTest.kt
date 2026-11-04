package com.vmq.monitor

import androidx.test.core.app.ApplicationProvider
import com.vmq.monitor.data.ConfigStore
import com.vmq.monitor.util.QrConfig
import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 扫码 / 相册 / 手工录入共用的配置解析测试。
 * 格式：`域名/密钥/通道ID,类型`
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class QrConfigTest {

    private lateinit var config: ConfigStore

    @Before
    fun setUp() {
        config = ConfigStore(ApplicationProvider.getApplicationContext())
        config.clearAll()
    }

    @Test
    fun `full format parses host key and passage`() {
        assertTrue(QrConfig.apply(config, "pay.example.com/testkey0001/9,2"))
        assertEquals("pay.example.com", config.host)
        assertEquals("testkey0001", config.commKey)
        assertEquals("9", config.getPassage(2))
    }

    @Test
    fun `legacy format without passage`() {
        // 老格式只有域名和密钥，不动通道
        assertTrue(QrConfig.apply(config, "pay.example.com/testkey0001"))
        assertEquals("pay.example.com", config.host)
        assertEquals("testkey0001", config.commKey)
        assertTrue(config.allPassages().isEmpty())
    }

    @Test
    fun `host with protocol prefix gets normalized`() {
        // 用户可能粘贴带协议的地址，ConfigStore 会归一化
        assertTrue(QrConfig.apply(config, "https://pay.example.com/key1"))
        assertEquals("pay.example.com", config.host)
    }

    @Test
    fun `all three passage types parse`() {
        assertTrue(QrConfig.apply(config, "h.com/k/8,1"))
        assertEquals("8", config.getPassage(1))
        assertTrue(QrConfig.apply(config, "h.com/k/9,2"))
        assertEquals("9", config.getPassage(2))
        assertTrue(QrConfig.apply(config, "h.com/k/7,4"))
        assertEquals("7", config.getPassage(4))
    }

    @Test
    fun `rejects garbage input`() {
        assertFalse(QrConfig.apply(config, ""))
        assertFalse(QrConfig.apply(config, "hello"))
        assertFalse(QrConfig.apply(config, "only-host/"))
        assertFalse(QrConfig.apply(config, "/only-key"))
    }

    @Test
    fun `unknown passage type is ignored but host key still saved`() {
        // 类型 3（QQ）监控端不用，但不能因此丢掉地址和密钥
        assertTrue(QrConfig.apply(config, "h.com/k/9,3"))
        assertEquals("h.com", config.host)
        assertTrue(config.allPassages().isEmpty())
    }
}
