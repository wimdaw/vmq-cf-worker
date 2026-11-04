package com.vmq.monitor.ui

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.widget.ImageView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.google.zxing.client.android.Intents
import com.journeyapps.barcodescanner.CaptureManager
import com.journeyapps.barcodescanner.DecoratedBarcodeView
import com.vmq.monitor.R
import com.vmq.monitor.util.QrDecoder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 扫码页。
 *
 * 没有直接继承库的 `CaptureActivity` —— 它的 `onCreate` 里写死了
 * `setContentView(R.layout.zxing_capture)`，子类没有机会换布局。
 * 这里照抄它的那几行（setContentView → new CaptureManager → initializeFromIntent → decode），
 * 布局换成自己的 [R.layout.activity_scan]。
 *
 * 三个要点：
 *   1. **竖屏**：库的 manifest 给 CaptureActivity 写死了 `sensorLandscape`，
 *      不声明的话一进扫码就横过来。本类在 manifest 里声明 `portrait`。
 *   2. **返回按钮**：左上角 ←，不用只靠系统返回键。
 *   3. **相册入口**：右上角「相册」，选图后本地解码，结果按 ScanContract 的约定回传。
 */
class ScanActivity : AppCompatActivity() {

    private lateinit var barcodeView: DecoratedBarcodeView
    private lateinit var captureManager: CaptureManager
    private var torchOn = false

    /** 相册选图 → 本地解码 → 当作扫码结果返回 */
    private val galleryLauncher =
        registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
            if (uri == null) return@registerForActivityResult
            lifecycleScope.launch {
                val text = withContext(Dispatchers.IO) { QrDecoder.decode(this@ScanActivity, uri) }
                if (text.isNullOrBlank()) {
                    Toast.makeText(
                        this@ScanActivity,
                        R.string.config_gallery_no_qr,
                        Toast.LENGTH_LONG
                    ).show()
                } else {
                    deliver(text)
                }
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_scan)

        barcodeView = findViewById(R.id.zxing_barcode_scanner)
        captureManager = CaptureManager(this, barcodeView)
        captureManager.initializeFromIntent(intent, savedInstanceState)
        captureManager.decode()

        findViewById<View>(R.id.btnBack).setOnClickListener { finish() }
        findViewById<View>(R.id.btnGallery).setOnClickListener {
            galleryLauncher.launch("image/*")
        }
        findViewById<View>(R.id.btnTorch).setOnClickListener { toggleTorch() }
    }

    private fun toggleTorch() {
        torchOn = !torchOn
        if (torchOn) barcodeView.setTorchOn() else barcodeView.setTorchOff()

        // 开着的时候图标变亮、文案改成"轻触关闭"，否则用户不知道再点一下是关
        findViewById<ImageView>(R.id.ivTorch).setColorFilter(
            getColor(if (torchOn) R.color.brand else android.R.color.white)
        )
        findViewById<TextView>(R.id.tvTorch).setText(
            if (torchOn) R.string.scan_torch_on else R.string.scan_torch
        )
    }

    /** 按 ScanContract 的约定回传（读的是 `SCAN_RESULT` 这个 extra） */
    private fun deliver(text: String) {
        setResult(Activity.RESULT_OK, Intent().putExtra(Intents.Scan.RESULT, text))
        finish()
    }

    /* ---------- 生命周期全部转给 CaptureManager，否则相机会漏关 ---------- */

    override fun onResume() {
        super.onResume()
        captureManager.onResume()
    }

    override fun onPause() {
        super.onPause()
        captureManager.onPause()
    }

    override fun onDestroy() {
        super.onDestroy()
        captureManager.onDestroy()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        captureManager.onSaveInstanceState(outState)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        captureManager.onRequestPermissionsResult(requestCode, permissions, grantResults)
    }

    /** 音量键当快门：CaptureManager 没有 onKeyDown，按键处理在 view 上 */
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean =
        barcodeView.onKeyDown(keyCode, event) || super.onKeyDown(keyCode, event)
}
