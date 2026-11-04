package com.vmq.monitor.data

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/** 一条通知日志 */
data class NoticeLog(
    val id: Long = 0,
    val ts: Long,
    /** 1 微信 / 2 支付宝 / 3 QQ / 4 数币 / 0 未识别 */
    val platform: Int,
    val pkg: String,
    val title: String,
    val content: String,
    /** 提取到的金额，未识别为 null */
    val amount: String?,
    /** 处理结果说明，例如"已入队"、"未匹配"、"金额为空" */
    val status: String
)

/** 一条待推送记录 */
data class PendingPush(
    val id: Long = 0,
    val type: Int,
    val price: String,
    val t: Long,
    val pid: String,
    val attempts: Int,
    val createdAt: Long,
    /** 下次可重试时刻（秒）。0 表示立即可发 */
    val nextAt: Long = 0
)

/**
 * 本地数据库：通知日志 + 待推送队列。
 *
 * `pending_push` 表是「推送失败不丢单」的落点：到账推送失败就留在表里，
 * 由后台协程持续重试，进程被杀也不丢（SQLite 持久化）。
 */
class DbHelper(context: Context) :
    SQLiteOpenHelper(context, "vmq_monitor.db", null, VERSION) {

    companion object {
        /**
         * v1 → v2：pending_push 增加 next_at（下次可重试时刻）。
         *
         * 加这一列是为了让**退避不阻塞队列**：如果把退避睡在循环里
         * （`delay(backoff)`），队首一条 attempts=6 的条目会先睡 60 秒，
         * 后面所有条目跟着一起等 —— 整条队列被一条坏记录掐住。
         * 把「什么时候能重试」落到行上，每轮只取到期的，互不影响。
         */
        private const val VERSION = 2

        const val T_LOG = "notice_log"
        const val T_PUSH = "pending_push"
        const val T_STATE = "monitor_state"
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE $T_LOG (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                ts        INTEGER NOT NULL,
                platform  INTEGER NOT NULL DEFAULT 0,
                pkg       TEXT    NOT NULL DEFAULT '',
                title     TEXT    NOT NULL DEFAULT '',
                content   TEXT    NOT NULL DEFAULT '',
                amount    TEXT,
                status    TEXT    NOT NULL DEFAULT ''
            )
            """.trimIndent()
        )
        db.execSQL(
            """
            CREATE TABLE $T_PUSH (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                type        INTEGER NOT NULL,
                price       TEXT    NOT NULL,
                t           INTEGER NOT NULL,
                pid         TEXT    NOT NULL DEFAULT '',
                attempts    INTEGER NOT NULL DEFAULT 0,
                created_at  INTEGER NOT NULL DEFAULT 0,
                next_at     INTEGER NOT NULL DEFAULT 0
            )
            """.trimIndent()
        )
        db.execSQL(
            """
            CREATE TABLE $T_STATE (
                id           INTEGER PRIMARY KEY CHECK (id = 1),
                last_heart   INTEGER NOT NULL DEFAULT 0,
                heart_fail   INTEGER NOT NULL DEFAULT 0,
                last_notice  INTEGER NOT NULL DEFAULT 0
            )
            """.trimIndent()
        )
        db.execSQL("INSERT OR IGNORE INTO $T_STATE (id) VALUES (1)")
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_log_ts ON $T_LOG (ts DESC)")
        // 取"到期待推送"是热路径，每 8 秒一次
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_push_next ON $T_PUSH (next_at)")
    }

    /**
     * 增量迁移，**绝不 DROP**。
     *
     * 用 drop 再 onCreate 的写法升级一次，`notice_log` 只是丢历史，
     * 但 `pending_push` 里是**还没推成功的到账记录** —— 全丢等于把
     * 「推送失败不丢单」这个核心保证废掉。
     */
    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) {
            db.execSQL("ALTER TABLE $T_PUSH ADD COLUMN next_at INTEGER NOT NULL DEFAULT 0")
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_push_next ON $T_PUSH (next_at)")
        }
    }
}

/* ============================ 日志 ============================ */

class LogStore private constructor(context: Context) {

    private val db = DbHelper(context.applicationContext).writableDatabase

    fun insert(log: NoticeLog): Long {
        val cv = ContentValues().apply {
            put("ts", log.ts)
            put("platform", log.platform)
            put("pkg", log.pkg)
            put("title", log.title)
            put("content", log.content)
            put("amount", log.amount)
            put("status", log.status)
        }
        return db.insert(DbHelper.T_LOG, null, cv)
    }

    fun recent(limit: Int = 120): List<NoticeLog> {
        val out = mutableListOf<NoticeLog>()
        db.rawQuery(
            "SELECT * FROM ${DbHelper.T_LOG} ORDER BY id DESC LIMIT ?",
            arrayOf(limit.toString())
        ).use { c ->
            while (c.moveToNext()) {
                out.add(
                    NoticeLog(
                        id = c.getLong(c.getColumnIndexOrThrow("id")),
                        ts = c.getLong(c.getColumnIndexOrThrow("ts")),
                        platform = c.getInt(c.getColumnIndexOrThrow("platform")),
                        pkg = c.getString(c.getColumnIndexOrThrow("pkg")),
                        title = c.getString(c.getColumnIndexOrThrow("title")),
                        content = c.getString(c.getColumnIndexOrThrow("content")),
                        amount = c.getString(c.getColumnIndexOrThrow("amount")),
                        status = c.getString(c.getColumnIndexOrThrow("status"))
                    )
                )
            }
        }
        return out
    }

    fun clear() {
        db.delete(DbHelper.T_LOG, null, null)
    }

    /** 只保留最近 N 条，防止无限增长 */
    fun trim(keep: Int = 500) {
        db.execSQL(
            "DELETE FROM ${DbHelper.T_LOG} WHERE id NOT IN " +
                "(SELECT id FROM ${DbHelper.T_LOG} ORDER BY id DESC LIMIT ?)",
            arrayOf<Any>(keep)
        )
    }

    companion object {
        @Volatile
        private var instance: LogStore? = null

        fun get(context: Context): LogStore =
            instance ?: synchronized(this) {
                instance ?: LogStore(context.applicationContext).also { instance = it }
            }
    }
}

/* ============================ 待推送队列 ============================ */

/**
 * 待推送队列。
 *
 * 构造器是 internal 而不是 private：单元测试要能每个用例新建一个实例
 * （Robolectric 每个用例重建临时数据库目录，复用单例会拿着已经失效的
 * SQLiteDatabase 句柄）。生产代码请走 [get] 单例。
 */
class PushStore internal constructor(context: Context) {

    private val db = DbHelper(context.applicationContext).writableDatabase

    fun enqueue(type: Int, price: String, t: Long, pid: String): Long {
        val cv = ContentValues().apply {
            put("type", type)
            put("price", price)
            put("t", t)
            put("pid", pid)
            put("attempts", 0)
            put("created_at", System.currentTimeMillis() / 1000)
            put("next_at", 0)
        }
        return db.insert(DbHelper.T_PUSH, null, cv)
    }

    /**
     * 到期可发的条目（`next_at <= now`）。
     *
     * 只取到期的，退避中的条目根本不进结果集 —— 这是「一条卡住不拖累全队」
     * 的关键。
     */
    fun due(
        now: Long = System.currentTimeMillis() / 1000,
        limit: Int = 200
    ): List<PendingPush> {
        val out = mutableListOf<PendingPush>()
        db.rawQuery(
            "SELECT * FROM ${DbHelper.T_PUSH} WHERE next_at <= ? ORDER BY id ASC LIMIT ?",
            arrayOf(now.toString(), limit.toString())
        ).use { c -> readRows(c, out) }
        return out
    }

    fun count(): Int {
        db.rawQuery("SELECT COUNT(*) FROM ${DbHelper.T_PUSH}", null).use { c ->
            return if (c.moveToFirst()) c.getInt(0) else 0
        }
    }

    /**
     * 记一次失败：attempts+1，并按新的 attempts 算出下次可重试时刻。
     *
     * @param attempts 调用方从 [due] 拿到的当前次数（避免再查一次库）
     */
    fun bump(id: Long, attempts: Int) {
        val next = attempts + 1
        val nextAt = System.currentTimeMillis() / 1000 + backoffMs(next) / 1000
        val cv = ContentValues().apply {
            put("attempts", next)
            put("next_at", nextAt)
        }
        db.update(DbHelper.T_PUSH, cv, "id = ?", arrayOf(id.toString()))
    }

    fun remove(id: Long) {
        db.delete(DbHelper.T_PUSH, "id = ?", arrayOf(id.toString()))
    }

    /** 超过 N 次仍失败：留着但告警，不删除（避免真的掉单） */
    fun stuck(): List<PendingPush> {
        val out = mutableListOf<PendingPush>()
        db.rawQuery(
            "SELECT * FROM ${DbHelper.T_PUSH} WHERE attempts >= ? ORDER BY id ASC",
            arrayOf(STUCK_THRESHOLD.toString())
        ).use { c -> readRows(c, out) }
        return out
    }

    private fun readRows(c: Cursor, out: MutableList<PendingPush>) {
        while (c.moveToNext()) {
            out.add(
                PendingPush(
                    id = c.getLong(c.getColumnIndexOrThrow("id")),
                    type = c.getInt(c.getColumnIndexOrThrow("type")),
                    price = c.getString(c.getColumnIndexOrThrow("price")),
                    t = c.getLong(c.getColumnIndexOrThrow("t")),
                    pid = c.getString(c.getColumnIndexOrThrow("pid")),
                    attempts = c.getInt(c.getColumnIndexOrThrow("attempts")),
                    createdAt = c.getLong(c.getColumnIndexOrThrow("created_at")),
                    nextAt = c.getLong(c.getColumnIndexOrThrow("next_at"))
                )
            )
        }
    }

    companion object {
        /** 失败超过这个次数视为"卡住"，UI 要显式告警 */
        const val STUCK_THRESHOLD = 20

        private const val MAX_BACKOFF_MS = 60_000L

        /**
         * 第 n 次失败后的退避时长：1s → 2s → 4s → 8s → 16s → 32s → 60s（封顶）。
         *
         * 指数部分用 `1s << (n-1)`，但**必须和上限取 min** ——
         * `1s << 6` 已经是 64 秒，不封顶就会超出「最多 60 秒」的约定。
         */
        fun backoffMs(attempts: Int): Long {
            if (attempts <= 0) return 0L
            val exp = 1_000L shl (attempts - 1).coerceAtMost(6)
            return minOf(MAX_BACKOFF_MS, exp)
        }

        @Volatile
        private var instance: PushStore? = null

        fun get(context: Context): PushStore =
            instance ?: synchronized(this) {
                instance ?: PushStore(context.applicationContext).also { instance = it }
            }
    }
}

/* ============================ 运行状态 ============================ */

class StateStore private constructor(context: Context) {

    private val db = DbHelper(context.applicationContext).writableDatabase

    fun setLastHeart(ts: Long) = put("last_heart", ts)
    fun lastHeart(): Long = get("last_heart")

    fun setHeartFail(n: Int) = put("heart_fail", n.toLong())
    fun heartFail(): Int = get("heart_fail").toInt()

    fun setLastNotice(ts: Long) = put("last_notice", ts)
    fun lastNotice(): Long = get("last_notice")

    private fun put(key: String, value: Long) {
        val cv = ContentValues().apply { put(key, value) }
        db.update(DbHelper.T_STATE, cv, "id = 1", null)
    }

    private fun get(key: String): Long {
        db.rawQuery("SELECT $key FROM ${DbHelper.T_STATE} WHERE id = 1", null).use { c ->
            return if (c.moveToFirst()) c.getLong(0) else 0L
        }
    }

    companion object {
        @Volatile
        private var instance: StateStore? = null

        fun get(context: Context): StateStore =
            instance ?: synchronized(this) {
                instance ?: StateStore(context.applicationContext).also { instance = it }
            }
    }
}
