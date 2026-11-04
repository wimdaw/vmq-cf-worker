package com.vmq.monitor.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import com.vmq.monitor.BuildConfig
import com.vmq.monitor.databinding.FragmentAboutBinding

/**
 * 关于页：使用说明 + 常见问题 + 版本信息。
 *
 * 版本号来自 `BuildConfig.VERSION_NAME`（app/build.gradle.kts 的 versionName），
 * 编译时间来自 `BuildConfig.BUILD_TIME` —— 那个字段是 Gradle 配置阶段
 * 按当前时间生成的，所以它反映的是**这次构建**的时间，不是安装时间。
 */
class AboutPanel : Fragment() {

    private var _binding: FragmentAboutBinding? = null
    private val binding get() = _binding!!

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        _binding = FragmentAboutBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding.tvVersion.text = BuildConfig.VERSION_NAME
        binding.tvBuildTime.text = BuildConfig.BUILD_TIME
        binding.tvPackage.text = requireContext().packageName
    }

    override fun onDestroyView() {
        _binding = null
        super.onDestroyView()
    }
}
