package com.vmq.monitor

import com.vmq.monitor.net.ApiClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 服务端响应解析。 */
class ApiClientTest {

    @Test
    fun `code 0 is success`() {
        val r = ApiClient.parseResult("""{"code":0,"msg":"成功"}""", 200)
        assertTrue(r.ok)
        assertEquals(0, r.code)
        assertEquals("成功", r.msg)
    }

    @Test
    fun `code 0 with unmatched order is still success`() {
        // 未匹配订单同样返回 code 0，只是 msg 不同
        val r = ApiClient.parseResult("""{"code":0,"msg":"无匹配订单，已记录"}""", 200)
        assertTrue(r.ok)
    }

    @Test
    fun `code minus one is failure and keeps server message`() {
        val r = ApiClient.parseResult("""{"code":-1,"msg":"签名校验不通过"}""", 200)
        assertFalse(r.ok)
        assertEquals("签名校验不通过", r.msg)
    }

    @Test
    fun `non 2xx is failure even if body says success`() {
        val r = ApiClient.parseResult("""{"code":0,"msg":"成功"}""", 502)
        assertFalse(r.ok)
    }

    @Test
    fun `html error page is failure`() {
        val r = ApiClient.parseResult("<html><body>502 Bad Gateway</body></html>", 200)
        assertFalse(r.ok)
    }

    @Test
    fun `spaces inside json do not break parsing`() {
        val r = ApiClient.parseResult("""{ "code" : 0 , "msg" : "成功" }""", 200)
        assertTrue(r.ok)
    }
}
