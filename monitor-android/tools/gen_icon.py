"""生成 V免签监控端 的桌面图标（科技风：深空底 + 扫描环 + ￥）。

设计坐标统一按 Android adaptive icon 的 108dp 画布，最后按比例放大到
supersample 画布再缩回去，保证边缘干净。

产物：
  build/icon/ic_launcher.png            1024 预览（带背景）
  build/icon/ic_launcher_foreground.png 透明底前景（108dp 布局）
  build/icon/ic_launcher_background.png 纯渐变背景
"""
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

# ---------- 基础参数 ----------
DESIGN = 108.0          # 设计画布边长（dp）
SS = 2                  # supersample 倍数
OUT = 1024              # 最终预览尺寸
W = OUT * SS            # 工作画布

SCALE = W / DESIGN      # 设计坐标 -> 工作像素

# ---------- 布局（单位 dp，108dp 画布）----------
# adaptive icon 只有中心 72dp 保证可见（半径 36），
# 所以最外层的刻度必须收在 36 以内，否则会被启动器的圆形/圆角遮罩切掉。
RING_R = 29.5           # 主环中心线半径
TICK_IN = 32.5          # 刻度内端
TICK_OUT = 35.6         # 刻度外端（< 36 安全线）
INNER_R = 23.5          # 内层装饰环


def px(v: float) -> float:
    return v * SCALE


# ---------- 配色 ----------
BG_IN = (26, 62, 94)      # 中心深蓝
BG_OUT = (4, 7, 13)       # 边缘近黑
CYAN = (45, 212, 240)     # 主青
CYAN_HI = (168, 246, 255)  # 高光青
CYAN_DIM = (30, 110, 140)  # 暗青
WHITE = (240, 254, 255)   # ￥ 白


def radial_gradient(size: int, inner, outer, center=(0.5, 0.46), power=1.45) -> Image.Image:
    """径向渐变。center 用 0..1 归一化坐标（默认略微偏上，视觉更稳）。"""
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    cx, cy = center[0] * size, center[1] * size
    r = np.sqrt((x - cx) ** 2 + (y - cy) ** 2) / (size * 0.62)
    r = np.clip(r, 0.0, 1.0) ** power

    a = np.array(inner, dtype=np.float32)
    b = np.array(outer, dtype=np.float32)
    rgb = a[None, None, :] * (1 - r[..., None]) + b[None, None, :] * r[..., None]
    return Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), "RGB")


def draw_ring(d: ImageDraw.ImageDraw, cx, cy, radius, width, color, start, end):
    """画一段圆环。start/end 是 PIL 角度（0° 在 3 点方向，顺时针递增）。"""
    r_out = radius + width / 2
    box = (cx - r_out, cy - r_out, cx + r_out, cy + r_out)
    d.arc(box, start=start, end=end, fill=color, width=int(round(width)))


def draw_ticks(d: ImageDraw.ImageDraw, cx, cy, r_in, r_out, count, width, color,
               skip_from=None, skip_to=None):
    """沿圆周画刻度线，像仪表盘 / 雷达。skip_from/skip_to 之间跳过（让亮段更干净）。"""
    import math
    for i in range(count):
        ang = i * (360.0 / count)
        if skip_from is not None:
            # 归一化到 0..360 判断是否在跳过区间
            a = ang % 360
            s, e = skip_from % 360, skip_to % 360
            inside = (s <= a <= e) if s <= e else (a >= s or a <= e)
            if inside:
                continue
        rad = math.radians(ang)
        x1, y1 = cx + r_in * math.cos(rad), cy + r_in * math.sin(rad)
        x2, y2 = cx + r_out * math.cos(rad), cy + r_out * math.sin(rad)
        d.line([(x1, y1), (x2, y2)], fill=color, width=int(round(width)))


def draw_yuan(d: ImageDraw.ImageDraw, color, width):
    """画人民币符号 ￥（设计坐标）。"""
    lw = int(round(px(width)))
    r = lw / 2

    def seg(p1, p2):
        d.line([p1, p2], fill=color, width=lw)
        # line 端点不是圆的，补两个圆做 round cap
        for (x, y) in (p1, p2):
            d.ellipse((x - r, y - r, x + r, y + r), fill=color)

    def p(x, y):
        return (px(x), px(y))

    seg(p(45, 38), p(54, 50))     # 左斜
    seg(p(63, 38), p(54, 50))     # 右斜
    seg(p(54, 49), p(54, 70))     # 竖
    seg(p(46, 55.5), p(62, 55.5))  # 横 1
    seg(p(46, 63), p(62, 63))      # 横 2


def build():
    cx = cy = px(54)

    # ---------- 背景 ----------
    bg = radial_gradient(W, BG_IN, BG_OUT)

    # 极淡的一圈内环，给 ￥ 和主环之间一点层次（不要多，多了会脏）
    tex = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    td = ImageDraw.Draw(tex)
    draw_ring(td, cx, cy, px(INNER_R), px(0.45), (120, 200, 230, 34), 0, 360)
    bg = Image.alpha_composite(bg.convert("RGBA"), tex)

    # ---------- 光晕层（先画粗、后模糊） ----------
    glow = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    draw_ring(gd, cx, cy, px(RING_R), px(7), (*CYAN, 90), 0, 360)
    draw_yuan(gd, (*CYAN_HI, 110), 9)
    glow = glow.filter(ImageFilter.GaussianBlur(px(5.5)))

    # ---------- 前景层 ----------
    fg = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(fg)

    # 刻度：外圈 24 格均匀分布，像仪表盘
    draw_ticks(d, cx, cy, px(TICK_IN), px(TICK_OUT), 20, px(0.85), (*CYAN, 85))

    # 环：主暗段 270°，亮段 90°（右上 -> 右下）
    # 数学角 330°->60° 转 PIL：300° -> 30°（顺时针 90°）
    draw_ring(d, cx, cy, px(RING_R), px(3.9), (*CYAN_DIM, 215), 30, 300)
    draw_ring(d, cx, cy, px(RING_R), px(3.9), (*CYAN, 255), 300, 30)

    # 亮段两端的扫描头
    import math
    for ang_deg, col, rad in ((300, CYAN_HI, 1.9), (30, CYAN, 1.9)):
        a = math.radians(ang_deg)
        hx = cx + px(RING_R) * math.cos(a)
        hy = cy + px(RING_R) * math.sin(a)
        rr = px(rad)
        d.ellipse((hx - rr, hy - rr, hx + rr, hy + rr), fill=(*col, 255))

    # ￥
    draw_yuan(d, (*WHITE, 255), 6.1)

    # ---------- 合成 ----------
    out = Image.alpha_composite(bg, glow)
    out = Image.alpha_composite(out, fg)
    out = out.resize((OUT, OUT), Image.LANCZOS)

    # 前景单独出（透明底），供 adaptive icon 用
    fg_only = Image.alpha_composite(glow, fg).resize((OUT, OUT), Image.LANCZOS)
    bg_only = bg.resize((OUT, OUT), Image.LANCZOS)

    return out.convert("RGB"), fg_only, bg_only


def build_monochrome() -> Image.Image:
    """Android 13+ 主题图标用的单色剪影（透明底 + 纯白）。

    系统会拿 alpha 通道按壁纸/主题着色，所以这里只留形状、不要渐变和光晕。
    环画成完整圆 —— 亮段/暗段是给彩色版做"扫描"观感的，单色版里区分不出来，
    反而会让缺口显得像画错了。
    """
    layer = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx = cy = px(54)
    draw_ticks(d, cx, cy, px(TICK_IN), px(TICK_OUT), 20, px(0.85), (255, 255, 255, 255))
    draw_ring(d, cx, cy, px(RING_R), px(3.9), (255, 255, 255, 255), 0, 360)
    draw_yuan(d, (255, 255, 255, 255), 6.1)
    return layer.resize((OUT, OUT), Image.LANCZOS)


def rounded(img: Image.Image, size: int, ratio: float = 0.215) -> Image.Image:
    """缩到 size 并加圆角。API 24/25 的启动器不会给图标加遮罩，自带圆角更好看。"""
    im = img.resize((size, size), Image.LANCZOS).convert("RGBA")
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=max(1, int(size * ratio)), fill=255
    )
    im.putalpha(mask)
    return im


def export_res(full, fg, bg, mono, res_dir: str):
    """把四张 1024 图落到 res/ 下的各个密度目录。"""
    # legacy 图标（API 24/25 用，也作为部分老启动器的兜底）
    for name, size in (("mdpi", 48), ("hdpi", 72), ("xhdpi", 96),
                       ("xxhdpi", 144), ("xxxhdpi", 192)):
        d = os.path.join(res_dir, f"mipmap-{name}")
        os.makedirs(d, exist_ok=True)
        rounded(full, size).save(os.path.join(d, "ic_launcher.png"))

    # adaptive icon 的前景 / 背景 / 单色剪影，108dp
    for name, size in (("mdpi", 108), ("hdpi", 162), ("xhdpi", 216),
                       ("xxhdpi", 324), ("xxxhdpi", 432)):
        d = os.path.join(res_dir, f"drawable-{name}")
        os.makedirs(d, exist_ok=True)
        fg.resize((size, size), Image.LANCZOS).save(
            os.path.join(d, "ic_launcher_foreground.png"))
        bg.resize((size, size), Image.LANCZOS).save(
            os.path.join(d, "ic_launcher_background.png"))
        mono.resize((size, size), Image.LANCZOS).save(
            os.path.join(d, "ic_launcher_monochrome.png"))


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    dst = os.path.join(here, "build", "icon")
    os.makedirs(dst, exist_ok=True)

    full, fg, bg = build()
    mono = build_monochrome()
    full.save(os.path.join(dst, "ic_launcher.png"))
    fg.save(os.path.join(dst, "ic_launcher_foreground.png"))
    bg.save(os.path.join(dst, "ic_launcher_background.png"))
    mono.save(os.path.join(dst, "ic_launcher_monochrome.png"))
    print("saved ->", dst)

    # --export 时顺便写入项目 res/
    if "--export" in os.sys.argv:
        res = os.path.join(here, os.pardir, "app", "src", "main", "res")
        export_res(full, fg, bg, mono, os.path.abspath(res))
        print("exported ->", os.path.abspath(res))
