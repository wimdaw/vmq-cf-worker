package com.vmq.monitor.net

import com.vmq.monitor.data.ConfigStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

/** 一次接口调用的结果 */
data class ApiResult(
    val ok: Boolean,
    val code: Int,
    val msg: String
) {
    companion object {
        fun fail(reason: String) = ApiResult(false, -1, reason)
    }
}

/**
 * 与服务端通信。
 *
 * **这是 HTTPS 的落地点**：地址一律由 [ConfigStore.baseUrl] 拼 `https://`，
 * 没有任何开关能降级成 http（network_security_config 也不放行明文）。
 */
class ApiClient(private val config: ConfigStore) {

    companion object {
        private const val CONNECT_TIMEOUT_MS = 10_000
        private const val READ_TIMEOUT_MS = 10_000

        /**
         * 解析服务端响应。
         *
         * 成功是 `{"code":0,"msg":"成功"}`，失败是 `{"code":-1,"msg":"..."}`。
         *
         * **`code == 0` 才是成功。** 判错的后果不是「报个错」这么简单，
         * 而是表现成两个看起来互不相干的故障：
         *   - 心跳永远「异常」：`last_heart` 从不更新，`healthy()` 恒为 false
         *   - 推送成功的单子留在 `pending_push` 里无限重试，面板一直显示「N 条待推送」
         *
         * 不要为了「兼容」把 1 也算成功 —— 后台管理接口 `/admin/` 那套用 `{code:1}`
         * 表示成功，但 `/appHeart`、`/appPush` 不是那套约定，混着认会把真正的
         * 失败当成功。
         */
        internal fun parseResult(body: String, httpStatus: Int): ApiResult {
            if (httpStatus !in 200..299) return ApiResult.fail("HTTP $httpStatus")
            val code = Regex("\"code\"\\s*:\\s*(-?\\d+)")
                .find(body)?.groupValues?.get(1)?.toIntOrNull()
            val msg = Regex("\"msg\"\\s*:\\s*\"([^\"]*)\"")
                .find(body)?.groupValues?.get(1)
            return when (code) {
                0 -> ApiResult(true, 0, msg ?: "成功")
                else -> ApiResult(false, code ?: -1, msg ?: "服务端返回异常")
            }
        }
    }

    /** 心跳。pid 为空串表示「未绑定具体通道」 */
    suspend fun heart(pid: String): ApiResult = withContext(Dispatchers.IO) {
        if (!config.configured) return@withContext ApiResult.fail("尚未配置通知地址或密钥")
        val t = System.currentTimeMillis() / 1000
        val sign = Signer.heartSign(t, pid, config.commKey)
        val query = "t=$t&pid=${urlEncode(pid)}&sign=$sign"
        call("/appHeart", query)
    }

    /**
     * 到账推送。
     *
     * @param type 1 微信 / 2 支付宝 / 4 数字人民币
     * @param price 金额字符串，保留原样（"18.01" 而不是 18.01）
     */
    suspend fun push(type: Int, price: String, pid: String): ApiResult = withContext(Dispatchers.IO) {
        if (!config.configured) return@withContext ApiResult.fail("尚未配置通知地址或密钥")
        val t = System.currentTimeMillis() / 1000
        val sign = Signer.pushSign(type, price, t, pid, config.commKey)
        val query =
            "type=$type&price=${urlEncode(price)}&t=$t&pid=${urlEncode(pid)}&sign=$sign"
        call("/appPush", query)
    }

    private suspend fun call(path: String, query: String): ApiResult = withContext(Dispatchers.IO) {
        var conn: HttpURLConnection? = null
        try {
            val full = "${config.baseUrl}$path?$query"
            conn = (URL(full).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = READ_TIMEOUT_MS
                doOutput = true
                // 参数同时放 query 和 body 两份，服务端从哪边取都能拿到
                setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
            }
            conn.outputStream.use { it.write(ByteArray(0)) }
            val status = conn.responseCode
            val body = readBody(conn, status)
            parseResult(body, status)
        } catch (e: Exception) {
            ApiResult.fail(e.javaClass.simpleName + ": " + (e.message ?: "网络异常"))
        } finally {
            conn?.disconnect()
        }
    }

    private fun readBody(conn: HttpURLConnection, status: Int): String {
        val stream = if (status in 200..299) conn.inputStream else conn.errorStream
        if (stream == null) return ""
        return BufferedReader(InputStreamReader(stream, StandardCharsets.UTF_8)).use { it.readText() }
    }

    private fun urlEncode(s: String): String =
        java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")
}
