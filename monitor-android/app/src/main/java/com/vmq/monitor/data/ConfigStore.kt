package com.vmq.monitor.data

import android.content.Context
import android.content.SharedPreferences
import android.util.Base64
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * 监控端配置。
 *
 * 协议**固定为 https**，没有降级开关。这里存的是「主机地址」（域名或 IP，
 * 不带协议），拼 URL 时一律加 `https://`。
 *
 * 为什么不提供「允许明文传输」开关：
 * 这类开关通常只是把 scheme 改成 http，而 `network_security_config` 的
 * base-config 是 `cleartextTrafficPermitted="false"`，API 28+ 上请求会被系统
 * 直接拦成 `Cleartext HTTP traffic not permitted` —— 开关打开后什么都不通，
 * 还给了人「我在用 HTTP 但能连」的错误预期。
 * 通讯密钥、金额、时间戳走明文等于全裸奔；要连内网 HTTP 服务，
 * 请给服务端加 TLS，不要往 App 里开明文口子。
 *
 * 密钥用 AES-GCM 加密后落盘（固定口令 + 随机盐派生密钥），
 * 避免明文躺在 SharedPreferences 里被 adb backup 或文件管理器直接捞走。
 */
class ConfigStore(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences("vmq_monitor_cfg", Context.MODE_PRIVATE)

    /** 通道配置：type -> 通道 ID（type: 1 微信 / 2 支付宝 / 4 数币） */
    private val passages: MutableMap<Int, String> = loadPassages()

    /**
     * 缓存 PBKDF2 派生密钥，避免界面刷新、心跳和推送重复执行高成本计算。
     * 盐存在 SharedPreferences 里且进程内不变，因此派生结果可以安全缓存。
     */
    @Volatile
    private var cachedSecret: SecretKeySpec? = null

    /**
     * 解密后的通讯密钥。null = 尚未解密（"未配置"与"已缓存空串"要区分开，
     * 所以用 null 而不是 ""）。
     *
     * 失效时机只有两个：[commKey] 的 setter、[clearAll]。
     */
    @Volatile
    private var cachedCommKey: String? = null

    var host: String
        get() = prefs.getString(KEY_HOST, "") ?: ""
        set(value) {
            prefs.edit().putString(KEY_HOST, normalizeHost(value)).apply()
        }

    var commKey: String
        get() = cachedCommKey ?: decrypt(prefs.getString(KEY_KEY_ENC, "") ?: "")
            .also { cachedCommKey = it }
        set(value) {
            prefs.edit().putString(KEY_KEY_ENC, encrypt(value)).apply()
            cachedCommKey = value
        }

    /** 服务是否已启动（前台服务运行中） */
    var serviceEnabled: Boolean
        get() = prefs.getBoolean(KEY_SERVICE_ON, false)
        set(value) {
            prefs.edit().putBoolean(KEY_SERVICE_ON, value).apply()
        }

    /** 完整 base URL，例如 https://pay.example.com。协议不可配置。 */
    val baseUrl: String
        get() = "https://$host"

    val configured: Boolean
        get() = host.isNotBlank() && commKey.isNotBlank()

    fun getPassage(type: Int): String = passages[type] ?: ""

    fun setPassage(type: Int, id: String) {
        val trimmed = id.trim()
        if (trimmed.isEmpty()) passages.remove(type) else passages[type] = trimmed
        savePassages()
    }

    fun removePassage(type: Int) {
        passages.remove(type)
        savePassages()
    }

    fun allPassages(): Map<Int, String> = passages.toMap()

    fun clearAll() {
        passages.clear()
        savePassages()
        prefs.edit().clear().apply()
        // 盐也被清掉了，缓存的派生密钥与明文密钥都必须作废，
        // 否则下次写入会用旧盐加密、下次读取拿旧明文冒充新配置
        cachedSecret = null
        cachedCommKey = null
    }

    private fun savePassages() {
        val text = passages.entries
            .joinToString(",") { "${it.key}:${it.value}" }
        prefs.edit().putString(KEY_PASSAGES, text).apply()
    }

    private fun loadPassages(): MutableMap<Int, String> {
        val out = mutableMapOf<Int, String>()
        val text = prefs.getString(KEY_PASSAGES, "") ?: ""
        for (pair in text.split(",")) {
            if (pair.isBlank()) continue
            val idx = pair.indexOf(':')
            if (idx <= 0) continue
            val type = pair.substring(0, idx).trim().toIntOrNull() ?: continue
            val id = pair.substring(idx + 1).trim()
            if (id.isNotEmpty()) out[type] = id
        }
        return out
    }

    /**
     * 归一化主机地址：去掉用户可能手输的协议前缀与尾部斜杠。
     * 这样无论用户填 `pay.example.com`、`https://pay.example.com/` 还是
     * `http://monitor.internal:8081`，最终都只保留 `host[:port]`，
     * 协议一律由 [baseUrl] 补成 https。
     */
    private fun normalizeHost(raw: String): String {
        var s = raw.trim()
        if (s.isEmpty()) return ""
        s = s.removePrefix("https://").removePrefix("http://")
        s = s.trimEnd('/')
        // 去掉路径部分（用户可能粘贴了整个 URL）
        val slash = s.indexOf('/')
        if (slash >= 0) s = s.substring(0, slash)
        return s
    }

    /* ------------------------- 密钥加密 ------------------------- */

    private fun secretKey(): SecretKeySpec {
        // 双重检查：UI 线程和 Dispatchers.Default 会并发进来
        cachedSecret?.let { return it }
        synchronized(this) {
            cachedSecret?.let { return it }
            var saltB64 = prefs.getString(KEY_SALT, null)
            if (saltB64 == null) {
                val generated = ByteArray(16).also { SecureRandom().nextBytes(it) }
                saltB64 = Base64.encodeToString(generated, Base64.NO_WRAP)
                prefs.edit().putString(KEY_SALT, saltB64).apply()
            }
            val salt = Base64.decode(saltB64, Base64.NO_WRAP)

            val pass = SALT_PASS.toCharArray()
            val spec = PBEKeySpec(pass, salt, PBKDF2_ITER, 256)
            val key = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
                .generateSecret(spec).encoded
            return SecretKeySpec(key, "AES").also { cachedSecret = it }
        }
    }

    private fun encrypt(plain: String): String {
        if (plain.isEmpty()) return ""
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, secretKey())
            val iv = cipher.iv
            val blob = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
            Base64.encodeToString(iv + blob, Base64.NO_WRAP)
        } catch (e: Exception) {
            // 加密失败时退回明文存储，总比丢配置强
            "PLAIN:" + Base64.encodeToString(plain.toByteArray(), Base64.NO_WRAP)
        }
    }

    private fun decrypt(stored: String): String {
        if (stored.isEmpty()) return ""
        if (stored.startsWith("PLAIN:")) {
            return try {
                String(Base64.decode(stored.substring(6), Base64.NO_WRAP), Charsets.UTF_8)
            } catch (e: Exception) {
                ""
            }
        }
        return try {
            val raw = Base64.decode(stored, Base64.NO_WRAP)
            val iv = raw.copyOfRange(0, 12)
            val blob = raw.copyOfRange(12, raw.size)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(
                Cipher.DECRYPT_MODE,
                secretKey(),
                GCMParameterSpec(128, iv)
            )
            String(cipher.doFinal(blob), Charsets.UTF_8)
        } catch (e: Exception) {
            ""
        }
    }

    companion object {
        private const val KEY_HOST = "host"
        private const val KEY_KEY_ENC = "key_enc"
        private const val KEY_SALT = "salt"
        private const val KEY_SERVICE_ON = "service_on"
        private const val KEY_PASSAGES = "passages"

        private const val PBKDF2_ITER = 120_000

        /**
         * PBKDF2 口令。说明：口令写在客户端，root 设备理论上总能提取，
         * 这一层防的是 adb backup / 文件管理器直接看到明文这种轻量场景，
         * 不是端上可信计算。要真安全得上服务端托管或 Keystore + 生物识别。
         */
        private const val SALT_PASS = "vmq-monitor-config-v1"

        @Volatile
        private var instance: ConfigStore? = null

        fun get(context: Context): ConfigStore =
            instance ?: synchronized(this) {
                instance ?: ConfigStore(context.applicationContext).also { instance = it }
            }
    }
}
