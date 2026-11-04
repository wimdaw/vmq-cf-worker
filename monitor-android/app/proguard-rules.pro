# 保留 ZXing 的解码入口（扫码库通过反射/工厂加载）
-keep class com.journeyapps.barcodescanner.** { *; }
-dontwarn com.journeyapps.barcodescanner.**
