package com.vmq.monitor.util

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import com.google.zxing.BinaryBitmap
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader

/**
 * 从相册图片里解二维码。
 *
 * 配置页的「从相册选择」和扫码页右上角的「相册」共用这一份 ——
 * 两条路径各写一遍迟早会漂移（一条修了、另一条没修）。
 *
 * 走 `GetContent` 拿 Uri，不申请存储权限。
 * 解码可能耗时（大图 HybridBinarizer），调用方自己放到 IO 线程。
 */
object QrDecoder {

    fun decode(context: Context, uri: Uri): String? {
        return try {
            val bitmap = loadBitmap(context, uri) ?: return null
            val width = bitmap.width
            val height = bitmap.height
            val pixels = IntArray(width * height)
            bitmap.getPixels(pixels, 0, width, 0, 0, width, height)
            val source = RGBLuminanceSource(width, height, pixels)
            QRCodeReader().decode(BinaryBitmap(HybridBinarizer(source))).text
        } catch (e: Exception) {
            // 图里没有码、图片损坏、解码器不认 —— 对用户都是"这张图不行"
            null
        }
    }

    private fun loadBitmap(context: Context, uri: Uri): Bitmap? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(context.contentResolver, uri))
        } else {
            @Suppress("DEPRECATION")
            MediaStore.Images.Media.getBitmap(context.contentResolver, uri)
        }
}
