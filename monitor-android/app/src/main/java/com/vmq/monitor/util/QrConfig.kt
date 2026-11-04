package com.vmq.monitor.util

import com.vmq.monitor.data.ConfigStore

/**
 * 扫码 / 手工录入内容解析。
 *
 * 格式：
 * ```
 * 域名/密钥/通道ID,类型
 * ```
 * - `域名`：通知地址，不带协议（协议固定 https，见 ConfigStore.baseUrl）
 * - `密钥`：通讯密钥，三条链路共用
 * - `通道ID,类型`：可选。类型 1 微信 / 2 支付宝 / 4 数字人民币
 *   （3 QQ钱包不支持）。省略时只更新地址与密钥，不动通道。
 *
 * 例：`pay.example.com/你的通讯密钥/9,2`
 */
object QrConfig {

    fun apply(config: ConfigStore, content: String): Boolean {
        // 兼容手工录入时粘了带协议的地址（二维码内容本身不带协议，
        // 但 ConfigStore 的归一化只管直接录地址那条路，这里先剥掉更稳）
        var text = content.trim()
        text = text.removePrefix("https://").removePrefix("http://")

        val parts = text.split("/")
        if (parts.size < 2 || parts[0].isBlank() || parts[1].isBlank()) return false

        config.host = parts[0]
        config.commKey = parts[1]

        if (parts.size >= 3) {
            val pidAndType = parts[2].split(",")
            if (pidAndType.size == 2) {
                val pid = pidAndType[0].trim()
                val type = pidAndType[1].trim().toIntOrNull()
                // 只认 1 微信 / 2 支付宝 / 4 数字人民币（3 QQ钱包不支持）
                if (pid.isNotBlank() && (type == 1 || type == 2 || type == 4)) {
                    config.setPassage(type, pid)
                }
            }
        }
        return true
    }
}
