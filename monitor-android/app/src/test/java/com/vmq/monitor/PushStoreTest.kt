package com.vmq.monitor

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.vmq.monitor.data.PushStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** 待推送队列的退避上限与非阻塞调度。 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PushStoreTest {

    private lateinit var store: PushStore

    private fun now(): Long = System.currentTimeMillis() / 1000

    @Before
    fun setUp() {
        // 每个用例新建实例，避免复用到上一个用例的数据库句柄
        store = PushStore(ApplicationProvider.getApplicationContext<Context>())
        store.due(now = Long.MAX_VALUE, limit = 10_000).forEach { store.remove(it.id) }
    }

    @Test
    fun `backoff doubles then caps at 60s`() {
        assertEquals(0L, PushStore.backoffMs(0))
        assertEquals(1_000L, PushStore.backoffMs(1))
        assertEquals(2_000L, PushStore.backoffMs(2))
        assertEquals(4_000L, PushStore.backoffMs(3))
        assertEquals(8_000L, PushStore.backoffMs(4))
        assertEquals(16_000L, PushStore.backoffMs(5))
        assertEquals(32_000L, PushStore.backoffMs(6))
        assertEquals(60_000L, PushStore.backoffMs(7))
        assertEquals(60_000L, PushStore.backoffMs(50))
    }

    @Test
    fun `newly enqueued item is immediately due`() {
        store.enqueue(1, "18.01", 1_000, "8")
        val due = store.due(now())
        assertEquals(1, due.size)
        assertEquals("18.01", due[0].price)
        assertEquals(0L, due[0].nextAt)
    }

    @Test
    fun `failed item is not due until its backoff passes`() {
        val id = store.enqueue(1, "18.01", 1_000, "8")
        store.bump(id, 0)

        // 第 1 次失败 → 1 秒后
        assertTrue(store.due(now()).isEmpty())
        assertEquals(1, store.due(now() + 2).size)
    }

    @Test
    fun `a stuck item does not block newer items`() {
        val old = store.enqueue(1, "1.00", 1_000, "8")
        var attempts = 0
        repeat(6) {
            store.bump(old, attempts)
            attempts++
        }
        // 老记录现在退避 60 秒，新记录应立刻可发 —— 把退避睡在循环里就会被堵住
        store.enqueue(2, "2.00", 2_000, "9")

        val due = store.due(now())
        assertEquals(1, due.size)
        assertEquals("2.00", due[0].price)
    }

    @Test
    fun `stuck lists items past threshold`() {
        val id = store.enqueue(1, "1.00", 1_000, "8")
        repeat(PushStore.STUCK_THRESHOLD) { store.bump(id, it) }
        assertEquals(1, store.stuck().size)
    }

    @Test
    fun `successful removal shrinks queue`() {
        val id = store.enqueue(1, "1.00", 1_000, "8")
        assertEquals(1, store.count())
        store.remove(id)
        assertEquals(0, store.count())
    }
}
