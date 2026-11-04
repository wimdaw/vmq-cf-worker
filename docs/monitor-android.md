# 监控端（Android）— 合并说明与使用方式

本目录是 [vmq-monitor-android](https://github.com/im-webb/vmq-monitor-android) 的完整副本，
并入本仓库后**原样保留其 Gradle 工程结构**，作为一个独立目录存在，不参与 Node 侧的构建。

监控端的职责：监听手机通知栏的到账通知 → 按规则识别平台与金额 → 签名后 `POST /appPush`
到本仓库部署的服务端。服务端（EdgeOne 版）已经实现了它要求的两条接口，无需为它改任何代码。

---

## 一、为什么放在 `monitor-android/`

| 候选位置 | 结论 |
| --- | --- |
| `apps/` 下 | ✗ `pnpm-workspace.yaml` 的 glob 是 `apps/*`，放进去会被当成 JS workspace 包，`pnpm install` 直接报错 |
| 仓库根目录 | ✗ 会和 Node 侧的 `package.json`、`tsconfig.json` 混在一起，Gradle 也找不到干净的工程根 |
| **`monitor-android/`** | ✓ 自带 `settings.gradle.kts`，用 Android Studio 打开这一层就是独立工程根，与 Node 侧零交叉 |

三个隔离点：

1. **Gradle 根隔离** —— `settings.gradle.kts` / `build.gradle.kts` 都在本目录内，
   `rootProject.name = "vmq-android-kotlin"`，`:app` 模块路径不受外层影响。
2. **忽略规则隔离** —— 本目录自带 `.gitignore`（`.gradle/`、`build/`、`local.properties`、
   `*.jks`、`*.apk`）与 `.gitattributes`（`gradlew` 强制 LF、`gradlew.bat` 强制 CRLF），
   git 的 per-directory 规则只作用于这棵子树，不影响根目录的 Node 配置。
3. **构建产物隔离** —— APK 落在 `monitor-android/app/build/`，不会和 `dist/`、
   `cloud-functions/` 混；`tools/gen_icon.py` 用 `__file__` 相对路径，嵌套后照常工作。

---

## 二、合并后的目录结构

### 仓库视图

```
vmq-cf-worker/                      （edgeone 分支）
├── src/                            Node 侧：EdgeOne Cloud Functions 源码
├── scripts/                        构建脚本（eo-build / eo-local / eo-smoke）
├── apps/                           pnpm workspace：web + admin 两个前端
├── docs/
│   ├── edgeone-deploy.md           服务端部署文档
│   └── monitor-android.md          ← 本文
├── monitor-android/                ★ 监控端 Android 工程（独立 Gradle 根）
├── edgeone.json                    EdgeOne 项目配置
├── package.json / pnpm-workspace.yaml
└── ...
```

### 监控端内部（与上游仓库完全一致）

```
monitor-android/
├── settings.gradle.kts             rootProject.name + include(":app")
├── build.gradle.kts                只声明插件版本，不 apply
├── gradle.properties
├── gradle/
│   ├── libs.versions.toml          版本目录：AGP 8.2.2 / Kotlin 1.9.24 / 各依赖
│   └── wrapper/                    gradle-8.2-bin
├── gradlew / gradlew.bat
├── .gitignore / .gitattributes
├── LICENSE                         MIT（上游原样保留）
├── README.md                       上游完整说明（界面 / 设计取舍 / 权限 / 已知限制）
├── docs/screenshots/               三张面板截图（Robolectric 渲染，数据全假）
├── tools/gen_icon.py               图标生成（PIL + numpy，`--export` 写回 res/）
└── app/
    ├── build.gradle.kts            namespace com.vmq.monitor，compileSdk 34 / minSdk 24
    ├── proguard-rules.pro
    └── src/
        ├── main/
        │   ├── AndroidManifest.xml 权限、NotificationListenerService、前台服务、开机自启
        │   ├── java/com/vmq/monitor/
        │   │   ├── MainActivity.kt         三面板（TabLayout + ViewPager2）
        │   │   ├── MonitorApp.kt
        │   │   ├── monitor/
        │   │   │   ├── NoticeService.kt     NotificationListenerService
        │   │   │   ├── NoticeDeduper.kt     5 秒窗口去重
        │   │   │   ├── MonitorService.kt    前台服务 + PARTIAL_WAKE_LOCK
        │   │   │   ├── MonitorEngine.kt     匹配 → 提金额 → 入队 → 写日志
        │   │   │   ├── Workers.kt           HeartbeatManager + PushWorker
        │   │   │   ├── Rules.kt             匹配规则表 + 金额提取
        │   │   │   └── BootReceiver.kt      开机 / 覆盖安装自启
        │   │   ├── net/
        │   │   │   ├── ApiClient.kt         POST /appHeart、/appPush
        │   │   │   └── Signer.kt            md5 签名
        │   │   ├── data/
        │   │   │   ├── ConfigStore.kt       配置（AES-GCM 加密密钥、host 归一化、固定 https）
        │   │   │   └── Stores.kt            SQLite：notice_log / pending_push / monitor_state
        │   │   ├── ui/                      三个面板 + 扫码页 + 两个 Adapter
        │   │   └── util/                    QrConfig / QrDecoder / Notifications
        │   └── res/                         布局、图标（5 套密度）、network_security_config
        └── test/java/com/vmq/monitor/       8 个测试类（含 Robolectric 截图测试）
```

---

## 三、与服务端的接口契约

监控端**只依赖两条路径**，本仓库的 `src/index.ts` 与 `src/routes/push.ts` 已经实现：

| 方向 | 请求 | 签名 | 成功判定 |
| --- | --- | --- | --- |
| 心跳（30 秒一轮） | `POST /appHeart?t=&pid=&sign=` | `md5(t + pid + key)`，服务端同时兼容老版 `md5(t + key)` | `code == 0` |
| 到账推送 | `POST /appPush?type=&price=&t=&pid=&sign=` | `md5(type + price + t + pid + key)` | `code == 0` |

- `type`：1 微信 / 2 支付宝 / 4 数字人民币（`3` QQ 钱包不支持）
- `key` 是后台的**通讯密钥**，与商户签名共用同一把（`appSecret`：`app_key → key → epaykey_ali`）
- `price` 必须按原始字符串发（`18.01` 不能变成 `18.1`），否则签名对不上
- ⚠️ `/appHeart`、`/appPush` 的成功码是 **0**，不是后台 `/api/admin/*` 那套 `1`
- 推送没匹配到订单时服务端返回 `{"code":0,"msg":"无匹配订单，已记录"}`，**仍算成功**，
  App 不会重试重投；记录可在后台「未匹配到账」里看到

绑定用的二维码内容由后台「通道管理 → APP扫码配置」生成，格式：

```
域名/通讯密钥/通道ID,类型        例：pay.example.com/3f9a…/8,1
```

服务端拼这串时域名**一定带 `https://`**（App 拿它当地址直接请求），
App 侧解析时会剥掉协议再补回，两条路径等价。

---

## 四、构建与安装

### 前置

- **JDK 17**（AGP 8.2.2 的要求；`java -version` 需为 17）
- **Android SDK**，`compileSdk 34` / `build-tools` 34
  —— 设 `ANDROID_HOME`，或在 `monitor-android/local.properties` 写 `sdk.dir=/path/to/Android/sdk`
  （该文件已忽略，Android Studio 首次打开会自动生成）
- 首次构建会从 `services.gradle.org` 拉 Gradle 8.2，从 `google()` / `mavenCentral()` 拉依赖

### 命令（全部在 `monitor-android/` 下执行）

```bash
cd monitor-android

./gradlew assembleDebug          # 产物：app/build/outputs/apk/debug/app-debug.apk
./gradlew testDebugUnitTest      # 8 个测试类，含 Robolectric 截图（输出到 build/ 下）
./gradlew assembleRelease        # 未签名包，只能侧载测试

adb install -r app/build/outputs/apk/debug/app-debug.apk
```

也可以用 **Android Studio**（Hedgehog 或更新）直接打开 `monitor-android/` 目录 ——
它有自己的 `settings.gradle.kts`，会被识别为一个独立工程，不会去读外层的 Node 配置。

### 发布签名

`assembleRelease` 产出的是未签名包。正式发布先生成密钥库（**不要提交进仓库**，
`.gitignore` 已挡掉 `*.jks` / `*.keystore`）：

```bash
keytool -genkey -v -keystore vmq-release.jks -keyalg RSA -keysize 2048 \
        -validity 10000 -alias vmq
```

再在 `app/build.gradle.kts` 里配 `signingConfigs`，密码走环境变量（`VMQ_STORE_PASS` /
`VMQ_KEY_PASS`），完整片段见 `monitor-android/README.md` 的「签名」一节。

---

## 五、装好之后要做的三件事

1. **授予「通知使用权」** —— 设置 → 通知 → 通知使用权 → 「V免签监控端」打开。
   App 内点该项会直接跳转；这是系统级权限，无法程序化授予，不给就不工作。
2. **加入电池优化白名单** —— 设置 → 电池 → 无限制；App 内也有入口。
   华为 / 小米 / vivo 等还需额外允许自启动、锁定后台。
3. **扫码绑定服务端** —— 后台建好通道后点「APP扫码配置」，用 App 的扫码页扫，
   或手工录入 `域名/密钥/通道ID,类型`。

绑定完成后回到监控面板，三个指标应变成：心跳有值、通道数正确；
「运行条件 N/3」应为 `3/3`。

### 联调自检顺序

```
后台建通道 → 复制 APP 扫码配置 → App 扫码
   → 监控面板看到心跳（30 秒内）
   → 前台下一笔 0.01 元订单（/demo.html?type=wxpay&money=0.01）
   → 用真微信/支付宝付这 0.01 元
   → App「最近通知」出现绿点 + 待推送归零
   → 后台订单状态变「已支付」
```

任何一环断了看 App 的「最近通知」：绿=已入队 / 橙=未配通道 / 红=没取到金额 / 灰=未匹配。

---

## 六、注意事项

- **协议固定 HTTPS**：App 只存 `host`，`baseUrl` 恒为 `https://$host`，
  manifest 里 `usesCleartextTraffic="false"`，没有降级开关。所以服务端**必须能走 HTTPS**。
  EdgeOne 预置域名 `*.edgeone.dev` 在大陆访问会 401（见 `edgeone-deploy.md`），
  正式使用请绑定自己的域名。
- **「强行停止」会导致通知监听失效**，且重开 App 也不会恢复 ——
  要去「通知使用权」里关掉再打开，或重启手机。普通覆盖安装不受影响。
- **与本仓库的 cron 无关**：服务端定时任务只负责关单、重试商户回调、清孤儿金额占位；
  监控端的重试队列在 App 本地（`pending_push` 表 + 指数退避），进程被杀也不丢。
- **App 不收集任何数据**，通知内容只在设备本地解析后发往你自己的服务端，
  没有第三方统计或崩溃上报 SDK。
- 本目录代码**未做任何功能性改动**，仅把 `ConfigStore.kt` 注释里的一个示例 IP
  换成了主机名（原值形似公网 IP，会触发本仓库的泄露门禁）。

---

## 七、与上游仓库同步

本目录是上游的快照。上游更新后同步：

```bash
# 在仓库根目录
git clone https://github.com/im-webb/vmq-monitor-android.git /tmp/vmq-monitor-android
rsync -a --delete \
  --exclude='.git' --exclude='build/' --exclude='.gradle/' --exclude='local.properties' \
  /tmp/vmq-monitor-android/ monitor-android/
git diff --stat monitor-android
```

`--delete` 会同步删除上游已移除的文件，注意别把本地新增的构建产物带进来
（`build/`、`.gradle/`、`local.properties` 已排除，也在 `.gitignore` 里）。
