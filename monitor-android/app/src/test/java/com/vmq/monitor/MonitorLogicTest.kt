package com.vmq.monitor

import com.vmq.monitor.monitor.MatchRule
import com.vmq.monitor.monitor.MoneyExtractor
import com.vmq.monitor.monitor.MoneySource
import com.vmq.monitor.monitor.Rules
import com.vmq.monitor.net.Signer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 核心算法测试。
 *
 * 签名断言使用固定假密钥和时间戳；[sign input is plain concatenation]
 * 使用独立的 MessageDigest 实现验证拼接顺序。
 */
class MonitorLogicTest {

    /* ==================== 签名 ==================== */

    @Test
    fun `md5 matches php md5`() {
        // 标准测试向量
        assertEquals("d41d8cd98f00b204e9800998ecf8427e", Signer.md5(""))
        assertEquals("0cc175b9c0f1b6a831c399e269772661", Signer.md5("a"))
        assertEquals("900150983cd24fb0d6963f7d28e17f72", Signer.md5("abc"))
        assertEquals("f96b697d7cb7938d525a2f31aaf161d0", Signer.md5("message digest"))
        // UTF-8 中文（PHP 的 md5() 对 UTF-8 字符串也是按字节算）
        assertEquals("089b4943ea034acfa445d050c7913e55", Signer.md5("中文测试"))
    }

    @Test
    fun `appHeart sign`() {
        // 期望值按 md5(t + pid + key) 手工算好写死，防止拼接顺序被改动。
        // 密钥用固定假值 —— 真实密钥不能进仓库。
        val key = "testkey0001"
        assertEquals(
            "c361105c8036350f2bcd81fa720aaeef",
            Signer.heartSign(1700000000L, "8", key)
        )
        assertEquals(
            "bfb8658ddd2ef01874e9847d28bfe1a9",
            Signer.heartSign(1700000030L, "9", key)
        )
    }

    @Test
    fun `appPush sign`() {
        // 期望值按 md5(type + price + t + pid + key) 算
        val key = "testkey0001"
        assertEquals(
            "83664d2ae5fe569f7a7b2c7f01eeee0b",
            Signer.pushSign(2, "18.00", 1700000000L, "9", key)
        )
        assertEquals(
            "4b51e899c1a5bae2dfec004ab3ab73fb",
            Signer.pushSign(1, "18.01", 1700000030L, "8", key)
        )
    }

    @Test
    fun `sign input is plain concatenation`() {
        // 用**独立的** MessageDigest 实现重算一遍，不复用 Signer.md5 / heartSign。
        // 上面两条的期望值是"按同一个理解"算出来的，万一拼接顺序理解错了会一起错；
        // 这条把「拼接规则」和「md5 实现」拆开，谁改了顺序它先红。
        fun md5Hex(s: String): String =
            java.security.MessageDigest.getInstance("MD5")
                .digest(s.toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it.toInt() and 0xFF) }

        val t = 1700000000L
        val pid = "8"
        val key = "testkey0001"

        // appHeart: t + pid + key（无分隔符、无排序）
        assertEquals(md5Hex("$t$pid$key"), Signer.heartSign(t, pid, key))
        // appPush: type + price + t + pid + key
        assertEquals(
            md5Hex("2" + "18.00" + t + "9" + key),
            Signer.pushSign(2, "18.00", t, "9", key)
        )
    }

    @Test
    fun `price must stay raw string`() {
        // 18.10 转 Double 再格式化会变成 18.1，签名就错了
        val key = "k"
        assertFalse(
            Signer.pushSign(1, "18.1", 1L, "8", key) ==
                Signer.pushSign(1, "18.10", 1L, "8", key)
        )
    }

    /* ==================== 匹配规则 ==================== */

    private val wx = "com.tencent.mm"
    private val ali = "com.eg.android.AlipayGphone"
    private val dcep = "cn.gov.pbc.dcep"

    @Test
    fun `alipay rules match original wording`() {
        // title == 收钱码
        assertTrue(
            Rules.list.any {
                it.matches(ali, "收钱码", "收钱码\n二维码收钱必读\n通过扫码向你付款18.01元")
            }
        )
        // title == 收款通知 && content 含"通过扫码向你付款"
        assertTrue(
            Rules.list.any {
                it.matches(ali, "收款通知", "收款通知\n通过扫码向你付款18.00元")
            }
        )
        // title 含"你已成功收款" → 金额从 title 取
        val rule = Rules.list.first { it.matches(ali, "你已成功收款0.12元", "其他") }
        assertEquals(2, rule.type)
        assertEquals(MoneySource.TITLE, rule.moneyFrom)
    }

    @Test
    fun `wechat rules match original wording`() {
        assertTrue(Rules.list.any { it.matches(wx, "微信支付", "微信支付\n微信支付收款18.00元") })
        assertTrue(Rules.list.any { it.matches(wx, "微信支付", "微信支付\n二维码赞赏到账0.12元") })
        assertTrue(Rules.list.any { it.matches(wx, "微信收款助手", "微信收款助手\n收款到账18.01元") })
        assertTrue(Rules.list.any { it.matches(wx, "微信收款商业版", "微信收款商业版\n收款18.00元") })
    }

    @Test
    fun `dcep rule matches`() {
        // 关键字：content 含「数字钱包」
        assertTrue(
            Rules.list.any {
                it.matches(dcep, "收款通知", "收款通知\n数字钱包收款18.00元")
            }
        )
        // 部分 ROM 文案是「数字人民币钱包」，两种都要兼容
        assertTrue(
            Rules.list.any {
                it.matches(dcep, "收款通知", "收款通知\n数字人民币钱包收款18.00元")
            }
        )
    }

    @Test
    fun `non payment notification does not match`() {
        // 音乐播放、系统提示
        assertFalse(Rules.list.any { it.matches(wx, "网易云音乐", "正在播放：晴天") })
        assertFalse(Rules.list.any { it.matches("com.android.systemui", "截图", "已保存截图") })
        // 微信普通消息
        assertFalse(Rules.list.any { it.matches(wx, "张三", "在吗") })
        // 支付宝非到账通知
        assertFalse(Rules.list.any { it.matches(ali, "余额宝", "昨日收益 1.23 元") })
    }

    @Test
    fun `wrong package never matches`() {
        // 同样的文案，换个包名不该命中
        assertFalse(Rules.list.any { it.matches("com.tencent.mm.fake", "微信支付", "微信支付收款18.00元") })
    }

    /* ==================== 金额提取 ==================== */

    @Test
    fun `extract takes first amount not last`() {
        // 取第一个金额，避免把余额当成收款金额
        assertEquals("18.01", MoneyExtractor.extract("你已成功收款18.01元，余额1234.56元"))
        assertEquals("18.00", MoneyExtractor.extract("微信支付收款18.00元，零钱余额99.99元"))
    }

    @Test
    fun `extract handles common formats`() {
        assertEquals("0.12", MoneyExtractor.extract("二维码赞赏到账0.12元"))
        assertEquals("18.00", MoneyExtractor.extract("收款到账18.00元"))
        assertEquals("18.01", MoneyExtractor.extract("通过扫码向你付款18.01元"))
    }

    @Test
    fun `extract rejects nonsense`() {
        assertNull(MoneyExtractor.extract(""))
        assertNull(MoneyExtractor.extract("没有金额的通知"))
        assertNull(MoneyExtractor.extract("金额 999999999.99 元超出上限"))
        assertNull(MoneyExtractor.extract("金额 0.001 元低于下限"))
    }

    @Test
    fun `single rule object works standalone`() {
        val rule = MatchRule(
            pkg = wx,
            type = 1,
            titleEquals = listOf("微信支付"),
            contentContainsAny = listOf("微信支付收款"),
            moneyFrom = MoneySource.CONTENT
        )
        assertTrue(rule.matches(wx, "微信支付", "微信支付收款18.00元"))
        assertFalse(rule.matches(wx, "微信支付", "别的内容"))
        assertFalse(rule.matches(ali, "微信支付", "微信支付收款18.00元"))
    }
}
