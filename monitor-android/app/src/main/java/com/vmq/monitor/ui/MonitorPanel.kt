package com.vmq.monitor.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.vmq.monitor.MainActivity
import com.vmq.monitor.R
import com.vmq.monitor.data.ConfigStore
import com.vmq.monitor.data.LogStore
import com.vmq.monitor.data.PushStore
import com.vmq.monitor.databinding.FragmentMonitorBinding
import com.vmq.monitor.monitor.HeartbeatManager
import com.vmq.monitor.monitor.MonitorEngine
import com.vmq.monitor.monitor.MonitorService
import com.vmq.monitor.monitor.NoticeOutcome
import com.vmq.monitor.monitor.NoticeService
import com.vmq.monitor.monitor.PushWorker
import com.vmq.monitor.monitor.Rules
import com.vmq.monitor.util.Notifications
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * 监控面板。
 *
 * 信息层级（从上到下就是用户要依次回答的问题）：
 *   Hero    —— 在跑吗？                （状态点 + 一句话 + 唯一开关）
 *   运行条件 —— 没在跑的话，卡在哪一步？  （三项前置条件，缺哪个点哪个）
 *   通道     —— 配了哪几个？
 *   最近通知 —— 刚才那条通知为什么没推出去？
 *
 * 每一项都能点到自己该去的地方 —— 权限没给就跳设置，配置没填就跳配置页。
 */
class MonitorPanel : Fragment() {

    private var _binding: FragmentMonitorBinding? = null
    private val binding get() = _binding!!

    private val config by lazy { ConfigStore.get(requireContext()) }
    private val logAdapter = LogAdapter()
    private val passageAdapter = PassageAdapter { item -> confirmRemovePassage(item) }

    /** 自动刷新协程。只在面板可见时存在 */
    private var refreshJob: Job? = null

    private val engineListener: (NoticeOutcome) -> Unit = { outcome ->
        activity?.runOnUiThread {
            if (_binding == null) return@runOnUiThread
            when (outcome) {
                is NoticeOutcome.SelfTest ->
                    toast("监听正常 · 通知内容已收到")
                is NoticeOutcome.Pushed ->
                    toast("匹配到 ${Rules.typeName(outcome.platform)} ${outcome.amount} 元，已入队")
                is NoticeOutcome.NoAmount ->
                    toast("命中${Rules.typeName(outcome.platform)}规则但没取到金额，请看日志")
                is NoticeOutcome.NoPassage ->
                    toast("取到 ${outcome.amount} 元，但未配置对应通道")
                is NoticeOutcome.Ignored -> { /* 不弹，避免刷屏；日志里能看到 */ }
            }
        }
    }

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        _binding = FragmentMonitorBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        binding.rvLogs.layoutManager = LinearLayoutManager(requireContext())
        binding.rvLogs.adapter = logAdapter

        binding.rvPassages.layoutManager = LinearLayoutManager(requireContext())
        binding.rvPassages.adapter = passageAdapter

        binding.btnToggleService.setOnClickListener { toggleService() }
        binding.btnTestNotice.setOnClickListener {
            Notifications.sendSelfTest(requireContext())
            toast("已发一条测试通知，稍等片刻")
        }
        binding.btnClearLog.setOnClickListener {
            LogStore.get(requireContext()).clear()
            refreshLogs()
        }
        // 三项前置条件各自跳到该去的地方
        binding.rowNoticePermission.setOnClickListener {
            (activity as? MainActivity)?.openNoticePermissionSettings()
        }
        binding.rowBattery.setOnClickListener {
            (activity as? MainActivity)?.requestBatteryWhitelist()
        }
        binding.rowConfigured.setOnClickListener {
            (activity as? MainActivity)?.openConfigTab()
        }

        MonitorEngine.addListener(engineListener)
    }

    /**
     * 只在面板可见时自动刷新。
     *
     * 不能只依赖 `viewLifecycleOwner.lifecycleScope` —— 它在 `onDestroyView`
     * 才取消，而按 Home 键、切到别的 App、息屏都只走到 `onStop`，
     * Fragment 的 view 并不会销毁，循环会一直在后台跑。
     *
     * 每轮的代价并不小：跨进程读一次 `enabled_notification_listeners`、
     * 一次 `isIgnoringBatteryOptimizations`、两次 SQLite 查询，
     * 再加两次 `notifyDataSetChanged()` 全量重建（没有 DiffUtil）。
     * 面板不在屏幕上时，这些结果没人看。
     *
     * 所以 onResume 起、onPause 停，周期 5 秒 —— 心跳本来就是 30 秒一次，
     * 待推送变化有 toast 提示，不需要 2 秒。
     */
    override fun onResume() {
        super.onResume()
        refresh()          // 立刻刷一次，避免回到前台先闪一下旧数据
        startAutoRefresh()
    }

    override fun onPause() {
        stopAutoRefresh()
        super.onPause()
    }

    override fun onDestroyView() {
        stopAutoRefresh()
        MonitorEngine.removeListener(engineListener)
        _binding = null
        super.onDestroyView()
    }

    /** 配置保存后由 MainActivity 调用 */
    fun refresh() {
        if (_binding == null) return
        refreshStatus()
        refreshPassages()
        refreshLogs()
    }

    private fun toggleService() {
        val activity = activity as? MainActivity ?: return
        if (!activity.noticePermissionGranted()) {
            toast("请先授予通知使用权")
            activity.openNoticePermissionSettings()
            return
        }
        if (!NoticeService.isConnected()) {
            // 权限在、服务没绑上：force-stop 或系统强杀之后就是这样。
            // 不 return —— 心跳和推送队列还能跑，只是收不到通知。
            toast("通知监听未连接：去设置里把「通知使用权」关掉再打开")
            activity.openNoticePermissionSettings()
        }
        if (!config.configured) {
            toast("请先在配置面板填写通知地址与密钥")
            activity.openConfigTab()
            return
        }
        if (config.serviceEnabled) {
            MonitorService.stop(requireContext())
            toast("监控已停止")
        } else {
            MonitorService.start(requireContext())
            toast("监控已开启")
        }
        // serviceEnabled 是 Service 的 onStartCommand / onDestroy 写的，
        // 这里立刻读还是旧值。刷新周期已经放宽到 5 秒，不能靠自动刷新兜底，
        // 所以稍等一下主动补一次。
        view?.postDelayed({ if (_binding != null) refresh() }, 400)
    }

    private fun startAutoRefresh() {
        if (refreshJob?.isActive == true) return
        refreshJob = viewLifecycleOwner.lifecycleScope.launch {
            while (isActive) {
                delay(REFRESH_INTERVAL_MS)
                refresh()
            }
        }
    }

    private fun stopAutoRefresh() {
        refreshJob?.cancel()
        refreshJob = null
    }

    private fun refreshStatus() {
        val activity = activity as? MainActivity ?: return

        val noticePerm = activity.noticePermissionGranted()
        // 权限还在允许列表里 ≠ 服务真的绑着。force-stop / 系统强杀之后
        // 两者会脱节：界面显示"已授予"，实际一条通知都收不到。
        val noticeConnected = NoticeService.isConnected()
        val noticeOk = noticePerm && noticeConnected
        val batteryOk = activity.isBatteryWhitelisted()
        val configured = config.configured
        val running = config.serviceEnabled

        val heartbeat = HeartbeatManager.get(requireContext())
        val heartOk = heartbeat.healthy()
        val pending = PushWorker.get(requireContext()).pendingCount()

        /* ---------- Hero ---------- */
        binding.tvHeroTitle.setText(
            if (running) R.string.monitor_running else R.string.monitor_stopped
        )
        binding.tvHeroSub.text = if (configured) {
            config.baseUrl
        } else {
            getString(R.string.monitor_not_configured_hint)
        }
        binding.viewHeroDot.setBackgroundResource(
            when {
                !running -> R.drawable.dot_idle
                heartOk -> R.drawable.dot_ok
                else -> R.drawable.dot_warn
            }
        )
        binding.btnToggleService.setText(
            if (running) R.string.monitor_stop else R.string.monitor_start
        )

        /* ---------- 三个指标 ---------- */
        binding.tvHeartbeat.text = when {
            !configured -> getString(R.string.monitor_heartbeat_none)
            heartOk -> getString(R.string.monitor_heartbeat_ok)
            else -> getString(R.string.monitor_heartbeat_fail)
        }
        binding.tvHeartbeat.setTextColor(
            color(
                when {
                    !configured -> R.color.text_tertiary
                    heartOk -> R.color.status_ok
                    else -> R.color.status_bad
                }
            )
        )

        binding.tvPendingPush.text = getString(R.string.monitor_pending_value, pending)
        binding.tvPendingPush.setTextColor(
            color(
                when {
                    pending >= PushStore.STUCK_THRESHOLD -> R.color.status_bad
                    pending > 0 -> R.color.status_warn
                    else -> R.color.text_primary
                }
            )
        )

        /* ---------- 运行条件 ---------- */
        val ready = listOf(noticeOk, batteryOk, configured).count { it }
        binding.tvReadyCount.text = getString(R.string.monitor_ready_count, ready, 3)

        bindCheck(
            dot = binding.viewDotNotice,
            value = binding.tvNoticePermission,
            ok = noticeOk,
            okText = getString(R.string.monitor_notice_permission_granted),
            todoText = if (noticePerm) {
                // 有权限但没连上：最常见的修法是去设置里把它关掉再打开
                getString(R.string.monitor_notice_not_connected)
            } else {
                getString(R.string.monitor_notice_permission_missing)
            }
        )
        bindCheck(
            dot = binding.viewDotBattery,
            value = binding.tvBatteryWhitelist,
            ok = batteryOk,
            okText = getString(R.string.monitor_battery_on),
            todoText = getString(R.string.monitor_battery_off)
        )
        // 配置缺失是硬伤（服务根本起不来），用红色而不是橙色
        binding.viewDotConfigured.setBackgroundResource(
            if (configured) R.drawable.dot_ok else R.drawable.dot_bad
        )
        binding.tvConfigured.text = getString(
            if (configured) R.string.monitor_config_done else R.string.config_not_set
        )
        binding.tvConfigured.setTextColor(
            color(if (configured) R.color.status_ok else R.color.status_bad)
        )
    }

    /** 一行前置条件：状态点 + 文案，颜色跟着走 */
    private fun bindCheck(
        dot: View,
        value: TextView,
        ok: Boolean,
        okText: String,
        todoText: String
    ) {
        dot.setBackgroundResource(if (ok) R.drawable.dot_ok else R.drawable.dot_warn)
        value.text = if (ok) okText else todoText
        value.setTextColor(color(if (ok) R.color.status_ok else R.color.status_warn))
    }

    /** 移除通道：先确认再删。删完立刻刷新，否则列表还挂着旧数据 */
    private fun confirmRemovePassage(item: PassageItem) {
        val name = Rules.typeName(item.type)
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(getString(R.string.monitor_remove_passage_title, name))
            .setMessage(R.string.monitor_remove_passage_message)
            .setNegativeButton(R.string.common_cancel, null)
            .setPositiveButton(R.string.common_delete) { _, _ ->
                config.removePassage(item.type)
                refresh()
                toast("已移除${name}通道")
            }
            .show()
    }

    private fun refreshPassages() {
        val passages = config.allPassages()
        binding.tvPassageCount.text = "${passages.size}"
        binding.tvNoPassage.visibility = if (passages.isEmpty()) View.VISIBLE else View.GONE
        binding.rvPassages.visibility = if (passages.isEmpty()) View.GONE else View.VISIBLE
        passageAdapter.submit(
            passages.entries
                .sortedBy { it.key }
                .map { PassageItem(it.key, it.value) }
        )
    }

    private fun refreshLogs() {
        // 只取 20 条：整个面板在一个 ScrollView 里，嵌套 RecyclerView 全量渲染会明显卡
        val logs = LogStore.get(requireContext()).recent(20)
        binding.tvLogEmpty.visibility = if (logs.isEmpty()) View.VISIBLE else View.GONE
        binding.rvLogs.visibility = if (logs.isEmpty()) View.GONE else View.VISIBLE
        logAdapter.submit(logs)
    }

    private fun color(id: Int): Int = resources.getColor(id, null)

    private fun toast(msg: String) {
        Toast.makeText(requireContext(), msg, Toast.LENGTH_SHORT).show()
    }

    companion object {
        /**
         * 面板可见时的刷新周期。
         *
         * 心跳 30 秒一次、待推送变化有 toast，5 秒足够。
         * 不可见时完全不刷（见 [onPause]）。
         */
        private const val REFRESH_INTERVAL_MS = 5_000L
    }
}
