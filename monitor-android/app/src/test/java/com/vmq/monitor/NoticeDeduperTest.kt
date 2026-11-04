package com.vmq.monitor

import com.vmq.monitor.monitor.NoticeDeduper
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 通知去重，包括 `A → B → A` 交错场景。 */
class NoticeDeduperTest {

    @Test
    fun `same key within window is duplicate`() {
        val d = NoticeDeduper(5_000)
        assertFalse(d.isDuplicate("wx|微信支付|收款18.00元", 1_000))
        assertTrue(d.isDuplicate("wx|微信支付|收款18.00元", 3_000))
    }

    @Test
    fun `interleaved a b a is still deduped`() {
        val d = NoticeDeduper(5_000)
        assertFalse(d.isDuplicate("A", 1_000))
        assertFalse(d.isDuplicate("B", 1_500))
        assertTrue(d.isDuplicate("A", 2_000))
    }

    @Test
    fun `outside window is not duplicate`() {
        val d = NoticeDeduper(5_000)
        assertFalse(d.isDuplicate("A", 1_000))
        // 差 5000ms 正好等于窗口，视为过期
        assertFalse(d.isDuplicate("A", 6_000))
    }

    @Test
    fun `different keys never collide`() {
        val d = NoticeDeduper(5_000)
        assertFalse(d.isDuplicate("wx|微信支付|18.00", 1_000))
        assertFalse(d.isDuplicate("wx|微信支付|18.01", 1_100))
        assertFalse(d.isDuplicate("ali|收钱码|18.00", 1_200))
    }

    @Test
    fun `expired keys are evicted so memory stays bounded`() {
        val d = NoticeDeduper(1_000)
        repeat(100) { i -> d.isDuplicate("k$i", i * 1_000L) }
        // 每个 key 间隔 1 秒，进来时上一条正好过期
        assertEquals(1, d.size())
    }
}
