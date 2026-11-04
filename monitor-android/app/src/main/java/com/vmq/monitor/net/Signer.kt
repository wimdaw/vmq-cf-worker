package com.vmq.monitor.net

import java.security.MessageDigest

/**
 * 签名。
 *
 * 服务端与监控端共用一把**商户通讯密钥**（在后台生成，扫码下发给 App），
 * 三个场景的算法分别是：
 *   appHeart : md5(t + pid + key)
 *   appPush  : md5(type + price + t + pid + key)
 * 直接字符串拼接、无分隔符、无排序 —— 与服务端 Worker 实现严格一致。
 */
object Signer {

    fun md5(input: String): String {
        val digest = MessageDigest.getInstance("MD5")
        val bytes = digest.digest(input.toByteArray(Charsets.UTF_8))
        return buildString(bytes.size * 2) {
            for (b in bytes) {
                val v = b.toInt() and 0xFF
                append("0123456789abcdef"[v shr 4])
                append("0123456789abcdef"[v and 0x0F])
            }
        }
    }

    /** 心跳签名：md5(t + pid + key) */
    fun heartSign(t: Long, pid: String, key: String): String = md5("$t$pid$key")

    /**
     * 到账推送签名：md5(type + price + t + pid + key)
     *
     * price 必须是**原始字符串**（例如 "18.01"），不要先转 Double 再格式化，
     * 否则 "18.10" 会变成 "18.1"，签名就对不上了。
     */
    fun pushSign(type: Int, price: String, t: Long, pid: String, key: String): String =
        md5("$type$price$t$pid$key")
}
