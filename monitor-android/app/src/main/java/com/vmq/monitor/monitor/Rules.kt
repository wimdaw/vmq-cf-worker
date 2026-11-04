package com.vmq.monitor.monitor

/** 金额从通知的哪个字段提取 */
enum class MoneySource { TITLE, CONTENT }

/**
 * 一条匹配规则。
 *
 * 判定顺序：包名 → 标题（等于 / 包含）→ 正文关键字，任一不满足即不命中。
 *
 * 两个刻意的取舍：
 *   1. 金额用 `\d+\.\d{2}` 并且取**第一个**匹配 —— 通知文案常见
 *      「收款 18.01 元，余额 1234.56 元」这种尾巴，取最后一个会拿到余额；
 *   2. 匹配失败也写日志。静默丢弃会让「为什么没推送」完全无法排查，
 *      微信改一次文案就可能整晚漏单而无人知晓。
 */
data class MatchRule(
    val pkg: String,
    /** 1 微信 / 2 支付宝 / 3 QQ / 4 数字人民币 */
    val type: Int,
    val titleEquals: List<String> = emptyList(),
    val titleContains: List<String> = emptyList(),
    /** 非空时，内容至少要命中其中一个关键字 */
    val contentContainsAny: List<String> = emptyList(),
    val moneyFrom: MoneySource = MoneySource.CONTENT
) {
    fun matches(pkg: String, title: String, content: String): Boolean {
        if (pkg != this.pkg) return false
        val titleOk = when {
            titleEquals.isNotEmpty() && titleContains.isNotEmpty() ->
                titleEquals.any { title == it } || titleContains.any { title.contains(it) }
            titleEquals.isNotEmpty() -> titleEquals.any { title == it }
            titleContains.isNotEmpty() -> titleContains.any { title.contains(it) }
            else -> true
        }
        if (!titleOk) return false
        if (contentContainsAny.isNotEmpty()) {
            if (contentContainsAny.none { content.contains(it) }) return false
        }
        return true
    }
}

object Rules {

    /**
     * 规则表。顺序即优先级，命中第一条就不再往下匹配。
     */
    val list: List<MatchRule> = listOf(
        // ---------------- 支付宝 ----------------
        MatchRule(
            pkg = "com.eg.android.AlipayGphone",
            type = 2,
            titleEquals = listOf("收钱码"),
            moneyFrom = MoneySource.CONTENT
        ),
        MatchRule(
            pkg = "com.eg.android.AlipayGphone",
            type = 2,
            titleEquals = listOf("收款通知"),
            contentContainsAny = listOf("通过扫码向你付款"),
            moneyFrom = MoneySource.CONTENT
        ),
        MatchRule(
            pkg = "com.eg.android.AlipayGphone",
            type = 2,
            titleContains = listOf("你已成功收款"),
            moneyFrom = MoneySource.TITLE
        ),

        // ---------------- 微信 ----------------
        MatchRule(
            pkg = "com.tencent.mm",
            type = 1,
            titleEquals = listOf("微信支付"),
            contentContainsAny = listOf("微信支付收款", "二维码赞赏到账"),
            moneyFrom = MoneySource.CONTENT
        ),
        MatchRule(
            pkg = "com.tencent.mm",
            type = 1,
            titleEquals = listOf("微信收款助手"),
            contentContainsAny = listOf("微信支付收款", "收款到账"),
            moneyFrom = MoneySource.CONTENT
        ),
        MatchRule(
            pkg = "com.tencent.mm",
            type = 1,
            titleEquals = listOf("微信收款商业版"),
            contentContainsAny = listOf("收款"),
            moneyFrom = MoneySource.CONTENT
        ),

        // ---------------- 数字人民币 ----------------
        // 「数字钱包」和「数字人民币钱包」两种文案在不同 ROM 上都出现过，都接受
        MatchRule(
            pkg = "cn.gov.pbc.dcep",
            type = 4,
            titleEquals = listOf("收款通知"),
            contentContainsAny = listOf("数字钱包", "数字人民币钱包"),
            moneyFrom = MoneySource.CONTENT
        )
    )

    /** 平台 ID → 中文名 */
    fun typeName(type: Int): String = when (type) {
        1 -> "微信"
        2 -> "支付宝"
        3 -> "QQ钱包"
        4 -> "数字人民币"
        else -> "未识别"
    }
}

/**
 * 金额提取。
 *
 * 「收款 18.01 元，余额 1234.56 元」这类文案里有两个数字，
 * 取最后一个会拿到余额。规则：
 *   1. 优先匹配两位小数 `18.01`（收付款场景的常规格式）
 *   2. 退化到一位或多位小数
 *   3. 取**第一个**命中（到账金额通常出现在通知最前）
 *   4. 做 0.01–100000 区间校验，超出视为异常
 */
object MoneyExtractor {

    private val TWO_DECIMAL = Regex("\\d+\\.\\d{2}")
    private val ANY_DECIMAL = Regex("\\d+\\.\\d+")

    fun extract(text: String): String? {
        if (text.isBlank()) return null
        val hit = TWO_DECIMAL.find(text)?.value
            ?: ANY_DECIMAL.find(text)?.value
            ?: return null
        val v = hit.toDoubleOrNull() ?: return null
        if (v < 0.01 || v > 100_000) return null
        return hit
    }
}
