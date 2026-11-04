package com.vmq.monitor.ui

import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.vmq.monitor.R
import com.vmq.monitor.data.NoticeLog
import com.vmq.monitor.databinding.ItemLogBinding
import com.vmq.monitor.monitor.Rules
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** 通知日志列表 */
class LogAdapter : RecyclerView.Adapter<LogAdapter.VH>() {

    private val items = mutableListOf<NoticeLog>()
    private val timeFmt = SimpleDateFormat("HH:mm:ss", Locale.US)

    fun submit(list: List<NoticeLog>) {
        // 数据没变就不重建。
        // 面板每 5 秒刷一次，但日志往往几分钟才多一条；无条件
        // notifyDataSetChanged() 会让嵌套在 ScrollView 里的 RecyclerView
        // 每次都全量重新 measure/layout，是前台 CPU 的主要来源。
        if (items == list) return
        items.clear()
        items.addAll(list)
        notifyDataSetChanged()
    }

    class VH(val binding: ItemLogBinding) : RecyclerView.ViewHolder(binding.root)

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH =
        VH(ItemLogBinding.inflate(LayoutInflater.from(parent.context), parent, false))

    override fun onBindViewHolder(holder: VH, position: Int) {
        val item = items[position]
        val b = holder.binding
        val ctx = b.root.context

        b.tvTime.text = timeFmt.format(Date(item.ts * 1000))
        b.tvPlatform.text = if (item.platform == 0) "未识别" else Rules.typeName(item.platform)
        b.tvAmount.text = item.amount?.let { "$it 元" } ?: ""
        b.tvStatus.text = item.status
        b.tvTitle.text = item.title
        b.tvContent.text = item.content.replace("\n", " · ")

        // 状态色：一眼扫下来就知道哪几条没推出去
        val (dot, colorRes) = when (item.status) {
            "已入队" -> R.drawable.dot_ok to R.color.status_ok
            "未配置通道" -> R.drawable.dot_warn to R.color.status_warn
            "命中规则但未取到金额" -> R.drawable.dot_bad to R.color.status_bad
            else -> R.drawable.dot_idle to R.color.text_secondary
        }
        b.viewLogDot.setBackgroundResource(dot)
        b.tvStatus.setTextColor(ctx.getColor(colorRes))
        // 金额只有在真的入队后才标绿 —— 没推出去的单子用绿色会误导
        b.tvAmount.setTextColor(
            ctx.getColor(if (item.status == "已入队") R.color.status_ok else R.color.text_primary)
        )
    }

    override fun getItemCount(): Int = items.size
}
