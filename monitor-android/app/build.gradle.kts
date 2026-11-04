import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

/**
 * 编译时间，注入 `BuildConfig.BUILD_TIME`，「关于」页要显示。
 *
 * 精确到**分钟**：同一分钟内多次构建取到同一个值，BuildConfig 内容不变，
 * 就不会因为跑一次测试（每次都会重新配置工程）触发无谓的重编译。
 */
val buildTime: String = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.getDefault()).format(Date())

android {
    namespace = "com.vmq.monitor"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.vmq.monitor"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "BUILD_TIME", "\"$buildTime\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        viewBinding = true
        // AGP 8 默认关闭；「关于」页要读 BuildConfig.VERSION_NAME / BUILD_TIME
        buildConfig = true
    }

    testOptions {
        unitTests.isIncludeAndroidResources = true
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.material)
    implementation(libs.androidx.constraintlayout)
    implementation(libs.androidx.viewpager2)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.service)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.zxing.android.embedded)
    implementation(libs.zxing.core)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
}
