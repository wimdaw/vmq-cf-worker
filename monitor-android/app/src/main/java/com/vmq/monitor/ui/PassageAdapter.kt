package com.vmq.monitor.ui

import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.vmq.monitor.monitor.Rules
import com.vmq.monitor.databinding.ItemPassageBinding

/** 通道列表项 */
data class PassageItem(val type: Int, val id: String)

class PassageAdapter(
    private val onDelete: (PassageItem) -> Unit
) : RecyclerView.Adapter<PassageAdapter.VH>() {

    private val items = mutableListOf<PassageItem>()

    fun submit(list: List<PassageItem>) {
        // 同 LogAdapter：通道极少变，没变就别触发重布局
        if (items == list) return
        items.clear()
        items.addAll(list)
        notifyDataSetChanged()
    }

    class VH(val binding: ItemPassageBinding) : RecyclerView.ViewHolder(binding.root)

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH =
        VH(ItemPassageBinding.inflate(LayoutInflater.from(parent.context), parent, false))

    override fun onBindViewHolder(holder: VH, position: Int) {
        val item = items[position]
        holder.binding.tvPassageType.text = Rules.typeName(item.type)
        holder.binding.tvPassageId.text = "ID ${item.id}"
        holder.binding.btnDelete.setOnClickListener { onDelete(item) }
    }

    override fun getItemCount(): Int = items.size
}
