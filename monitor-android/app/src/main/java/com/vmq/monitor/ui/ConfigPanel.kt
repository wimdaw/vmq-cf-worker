package com.vmq.monitor.ui

import android.os.Bundle
import android.text.InputType
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Toast
import androidx.fragment.app.Fragment
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.vmq.monitor.MainActivity
import com.vmq.monitor.R
import com.vmq.monitor.data.ConfigStore
import com.vmq.monitor.databinding.FragmentConfigBinding
import com.vmq.monitor.monitor.MonitorService
import com.vmq.monitor.monitor.Rules
import com.vmq.monitor.util.QrConfig

/**
 * 配置面板。
 *
 * 顶部是「通知地址 / 通讯密钥 / 三个通道ID」信息行，下面是全宽按钮列表
 * （扫码配置 / 手工配置）。
 *
 * 三个设计取舍：
 *   - 点信息行直接改，不用先扫码才能配
 *   - 扫码配置支持**相机**与**相册识别**两种方式
 *   - 密钥默认打码显示
 */
class ConfigPanel : Fragment() {

    private var _binding: FragmentConfigBinding? = null
    private val binding get() = _binding!!

    private val config by lazy { ConfigStore.get(requireContext()) }

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        _binding = FragmentConfigBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        // 信息行：点击即改
        binding.rowUrl.setOnClickListener { editAddress() }
        binding.rowKey.setOnClickListener { editKey() }
        binding.rowWx.setOnClickListener { editPassage(1) }
        binding.rowAli.setOnClickListener { editPassage(2) }
        binding.rowDcep.setOnClickListener { editPassage(4) }

        // 扫码配置：直接进扫码页。
        // 相册入口在扫码页右上角，不再先弹"相机/相册"二选一 —— 多一步没意义。
        binding.btnScan.setOnClickListener { (activity as? MainActivity)?.launchScanner() }

        // 手工配置：粘贴二维码内容
        binding.btnManual.setOnClickListener { showManualDialog() }

        refresh()
    }

    override fun onResume() {
        super.onResume()
        // 扫码 / 相册识别返回后刷新显示
        if (_binding != null) refresh()
    }

    override fun onDestroyView() {
        _binding = null
        super.onDestroyView()
    }

    /* ------------------------- 显示 ------------------------- */

    fun refresh() {
        if (_binding == null) return

        // 协议固定 https，不再随开关变化
        binding.tvUrlValue.text = if (config.host.isBlank()) {
            getString(R.string.config_not_set)
        } else {
            config.baseUrl
        }
        binding.tvKeyValue.text = maskKey(config.commKey)
        binding.tvWxValue.text = valueOrNotSet(config.getPassage(1))
        binding.tvAliValue.text = valueOrNotSet(config.getPassage(2))
        binding.tvDcepValue.text = valueOrNotSet(config.getPassage(4))
    }

    private fun valueOrNotSet(value: String): String =
        if (value.isBlank()) getString(R.string.config_not_set) else value

    /** 密钥打码：保留前 4 后 4，中间星号 */
    private fun maskKey(key: String): String {
        if (key.isBlank()) return getString(R.string.config_not_set)
        if (key.length <= 8) return "*".repeat(key.length)
        return key.take(4) + "****" + key.takeLast(4)
    }

    /* ------------------------- 编辑对话框 ------------------------- */

    private fun editAddress() {
        textInputDialog(
            title = getString(R.string.config_notice_address),
            initial = config.host,
            hint = "pay.example.com（不要带 http://）",
            numeric = false
        ) { input ->
            if (input.isBlank()) {
                toast(getString(R.string.config_url_required))
                return@textInputDialog
            }
            val wasConfigured = config.configured
            config.host = input
            toast(getString(R.string.config_saved))
            if (!wasConfigured && config.configured) MonitorService.start(requireContext())
            refresh()
        }
    }

    private fun editKey() {
        textInputDialog(
            title = getString(R.string.config_comm_key),
            initial = config.commKey,
            hint = getString(R.string.config_comm_key_hint),
            numeric = false,
            password = true
        ) { input ->
            if (input.isBlank()) {
                toast(getString(R.string.config_key_required))
                return@textInputDialog
            }
            val wasConfigured = config.configured
            config.commKey = input
            toast(getString(R.string.config_saved))
            if (!wasConfigured && config.configured) MonitorService.start(requireContext())
            refresh()
        }
    }

    private fun editPassage(type: Int) {
        val name = Rules.typeName(type)
        val current = config.getPassage(type)
        val neutral = if (current.isBlank()) {
            null
        } else {
            getString(R.string.common_delete) to {
                config.removePassage(type)
                toast(getString(R.string.config_deleted_toast))
                refresh()
            }
        }
        textInputDialog(
            title = getString(R.string.config_passage_title, name),
            initial = current,
            hint = getString(R.string.config_channel_id),
            numeric = true,
            neutral = neutral
        ) { input ->
            if (input.isBlank()) {
                config.removePassage(type)
                toast("${name}通道已清空")
            } else {
                config.setPassage(type, input)
                toast(getString(R.string.config_saved))
            }
            refresh()
        }
    }

    /* ------------------------- 扫码 / 手工 ------------------------- */

    private fun showManualDialog() {
        textInputDialog(
            title = getString(R.string.config_manual),
            initial = "",
            hint = "域名/密钥/通道ID,类型（通道部分可省略）",
            numeric = false
        ) { input ->
            if (input.isBlank()) return@textInputDialog
            if (QrConfig.apply(config, input)) {
                toast(getString(R.string.config_saved))
                refresh()
            } else {
                toast(getString(R.string.config_qr_invalid))
            }
        }
    }

    /* ------------------------- 工具 ------------------------- */

    /**
     * 通用文本输入对话框。
     *
     * @param neutral 非空时显示一个中性按钮（例如删除通道）
     */
    private fun textInputDialog(
        title: String,
        initial: String,
        hint: String,
        numeric: Boolean,
        password: Boolean = false,
        neutral: Pair<String, () -> Unit>? = null,
        onConfirm: (String) -> Unit
    ) {
        val input = EditText(requireContext()).apply {
            setText(initial)
            setSelection(text.length)
            this.hint = hint
            inputType = when {
                numeric -> InputType.TYPE_CLASS_NUMBER
                password -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
                else -> InputType.TYPE_CLASS_TEXT
            }
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { setMargins(48, 16, 48, 0) }
        }
        val builder = MaterialAlertDialogBuilder(requireContext())
            .setTitle(title)
            .setView(input)
            .setNegativeButton(R.string.common_cancel, null)
            .setPositiveButton(R.string.common_ok) { _, _ ->
                onConfirm(input.text?.toString()?.trim().orEmpty())
            }
        if (neutral != null) {
            builder.setNeutralButton(neutral.first) { _, _ -> neutral.second() }
        }
        builder.show()
    }

    private fun toast(msg: String) {
        Toast.makeText(requireContext(), msg, Toast.LENGTH_SHORT).show()
    }
}
