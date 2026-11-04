package com.vmq.monitor

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.viewpager2.adapter.FragmentStateAdapter
import com.google.android.material.tabs.TabLayoutMediator
import com.vmq.monitor.data.ConfigStore
import com.vmq.monitor.databinding.ActivityMainBinding
import com.vmq.monitor.monitor.MonitorService
import com.vmq.monitor.monitor.NoticeService
import com.vmq.monitor.ui.AboutPanel
import com.vmq.monitor.ui.ConfigPanel
import com.vmq.monitor.ui.MonitorPanel
import com.vmq.monitor.ui.ScanActivity
import com.vmq.monitor.util.QrConfig
import com.vmq.monitor.util.QrDecoder

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private val config by lazy { ConfigStore.get(this) }

    /** 通知权限（Android 13+）。授权后我们才能发出常驻服务通知 */
    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    /** 扫码：扫后台「APP扫码配置」生成的二维码 */
    private val scanLauncher = registerForActivityResult(
        com.journeyapps.barcodescanner.ScanContract()
    ) { result ->
        val text = result.contents
        if (text.isNullOrBlank()) return@registerForActivityResult
        handleQrText(text)
    }


    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        setSupportActionBar(binding.toolbar)

        val adapter = PanelAdapter()
        binding.viewPager.adapter = adapter
        TabLayoutMediator(binding.tabLayout, binding.viewPager) { tab, position ->
            tab.setText(
                when (position) {
                    0 -> R.string.tab_monitor
                    1 -> R.string.tab_config
                    else -> R.string.tab_about
                }
            )
        }.attach()

        askNotificationPermissionIfNeeded()

        // 配置就绪且之前是开启状态：自动拉起服务（开机自启的另一条路径）
        if (config.configured && config.serviceEnabled) {
            MonitorService.start(this)
        }
    }

    fun launchScanner() {
        scanLauncher.launch(
            com.journeyapps.barcodescanner.ScanOptions().apply {
                setDesiredBarcodeFormats(com.journeyapps.barcodescanner.ScanOptions.QR_CODE)
                setPrompt("将二维码放入框内，即可自动扫描")
                setBeepEnabled(true)
                // 竖屏 + 自定义布局（返回键 / 相册 / 手电筒）。库自带的 CaptureActivity
                // 在 manifest 里写死了 sensorLandscape，会一进来就横屏。
                setOrientationLocked(true)
                setCaptureActivity(ScanActivity::class.java)
            }
        )
    }

    /**
     * 处理一条二维码内容（相机扫码与相册识别共用）。
     *
     * 相册那条路径在 [ScanActivity] 里：选图 → [QrDecoder] 解码 →
     * 按 ScanContract 的约定回传，最后仍然汇到这里。
     */
    private fun handleQrText(text: String) {
        if (QrConfig.apply(config, text)) {
            Toast.makeText(this, R.string.config_saved, Toast.LENGTH_SHORT).show()
        } else {
            Toast.makeText(this, R.string.config_qr_invalid, Toast.LENGTH_LONG).show()
        }
    }

    /** 打开系统「通知使用权」设置页 */
    fun openNoticePermissionSettings() {
        startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
    }

    /** 切到配置面板（监控面板里「服务配置」那行会调它） */
    fun openConfigTab() {
        binding.viewPager.currentItem = 1
    }

    /** 申请加入电池优化白名单 */
    fun requestBatteryWhitelist() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:$packageName")
            }
            if (intent.resolveActivity(packageManager) != null) {
                startActivity(intent)
            } else {
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            }
        }
    }

    fun isBatteryWhitelisted(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
        val pm = getSystemService(POWER_SERVICE) as android.os.PowerManager
        return pm.isIgnoringBatteryOptimizations(packageName)
    }

    fun noticePermissionGranted(): Boolean = NoticeService.isPermissionGranted(this)

    private fun askNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
            if (!granted) notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    private inner class PanelAdapter : FragmentStateAdapter(this) {
        override fun getItemCount(): Int = 3

        override fun createFragment(position: Int) = when (position) {
            0 -> MonitorPanel()
            1 -> ConfigPanel()
            else -> AboutPanel()
        }
    }
}
