"""从仓库 brain3d.py 的 build() 生成独立 ES module：assets/vendor/brain3d.js

为什么要有这个脚本（而不是手抄一份 JS）：
    brain3d.py 是上游唯一事实来源。手抄会在上游更新后悄悄漂移，且抄的过程本身
    就会引入"渲染逻辑一行没动"的假象。这里只做**字符串级最小补丁**，每个补丁
    都在下面 PATCHES 里逐条写明理由和原文/替换文，跑完打印补丁命中数——
    任何一个补丁没命中就直接报错退出，绝不静默产出一个少了补丁的模块。

用法（在 memory-constellation 目录下）：
    python src/brain/gen_brain3d.py
    # 可选：--repo <dafeiyu-3d-brain 目录>
输出：
    assets/vendor/brain3d.js

补丁清单（都只动"接入层"，不动渲染算法）：
    P1  mount() 接受 canvas 元素（原版只接受 id）——上层 mountBrain(canvasEl) 需要
    P2  onStatus 广播给 _subs，并维护 ready / _status —— 上层要等"皮层真的加载完"
    P3  顶层对象加 _subs/_status/ready 与 autoRotate 选项
    P4  rotate(on) 改成开/关自动旋转（原版是一次性转 36°，与 API.md 描述不符；
        API.md 写明 rotate(on) 是"开关自动旋转"）
    P5  tick 里累加 autoY（自动旋转角，与动画时间解耦，running=false 也能转）
    P6  animate 里把 autoY 加到脑体绕 Y 的摆动上
    P7  reset() 的相机参数可由 window.__BRAIN_CAMERA__ 覆盖 —— 相机标定入口
    P8  脑体 group 的位移/缩放可由 window.__BRAIN_TRANSFORM__ 覆盖 —— 构图微调入口
    P9  dispose() 复位 ready/_status
    P10 砍掉原版文件末尾的"自动挂载 #cortex-canvas" IIFE：本项目由 mount.js 显式挂载，
        否则 import 这个模块的瞬间就会偷偷挂到全局 id 上
    P11 末尾加 export（ES module 对外入口）
"""
from __future__ import annotations

import argparse
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent                 # memory-constellation/
DEFAULT_REPO = ROOT.parent / "memory-brain-main" / "dsh" / "dafeiyu-3d-brain"
# 相对路径：页面在根时解析成 /assets/cortex/*.bin；被 DSH 插件挂在
# /memory-constellation/ 前缀下时解析成 /memory-constellation/assets/cortex/*.bin，
# 两种情况都不用改代码。绝对路径 "/assets" 在插件挂载下会 404。
CORTEX_BASE = "./assets"
OUT = ROOT / "assets" / "vendor" / "brain3d.js"

# (id, 原文, 替换文, 说明)
PATCHES: list[tuple[str, str, str, str]] = [
    (
        "P1",
        "    const canvas = document.getElementById(canvasId || 'cortex-canvas');",
        "    const canvas = (canvasId && canvasId.nodeType === 1) ? canvasId : document.getElementById(canvasId || 'cortex-canvas');",
        "mount() 接受 canvas 元素，也兼容原版的 id 字符串",
    ),
    (
        "P2",
        "        (s) => {\n          console.log('3D', s.message || s.state);",
        "        (s) => {\n"
        "          this._status = s; if (s.state === 'ready') this.ready = true;\n"
        "          (this._subs || []).slice().forEach((f) => { try { f(s); } catch (e) { console.error(e); } });\n"
        "          console.log('3D', s.message || s.state);",
        "状态广播：mount.js 靠它 resolve mountBrain() 的 Promise",
    ),
    (
        "P3",
        "  scene: null,\n  options: { mode: 'hologram', running: true, query: '', active: Object.keys(CATEGORIES), density: 32, glow: 60, art: true },",
        "  scene: null, _subs: [], _status: null, ready: false,\n"
        "  options: { mode: 'hologram', running: true, autoRotate: true, query: '', active: Object.keys(CATEGORIES), density: 32, glow: 60, art: true },",
        "顶层对象补内部状态与 autoRotate 选项",
    ),
    (
        "P4",
        "  rotate() { this.scene?.rotate(); },",
        "  rotate(on) { const v = on !== false; this.options.autoRotate = v; return this.options.autoRotate; },",
        "rotate(on) 语义 = 开关自动旋转（对齐 API.md）",
    ),
    (
        "P5",
        "      this.canvas.style.visibility='visible';if(o.running)this.time+=dt;",
        "      this.canvas.style.visibility='visible';if(o.running)this.time+=dt;if(o.autoRotate)this.autoY=(this.autoY||0)+dt*.18;",
        "自动旋转角累加；与动画时间解耦，running=false 时仍可转",
    ),
    (
        "P6",
        "this.brain.rotation.y=Math.sin(this.time*.13)*.12;",
        "this.brain.rotation.y=Math.sin(this.time*.13)*.12+(this.autoY||0)+(o.brainYaw||0);",
        "自动旋转叠加到脑体原有摆动上（不新增运动源，只是加一个角度）；brainYaw 供构图标定",
    ),
    (
        "P7",
        "  reset() { const compact = this.width <= 760 || this.width < this.height * .8; this.camera.position.set(0,compact?2.6:2.0,compact?17.0:10.0); this.controls.target.set(0,compact?.28+Math.max(0,760-this.height)*.0055:0,0); this.controls.update(); this.brain.rotation.set(0,0,0); }",
        "  reset() { const compact = this.width <= 760 || this.width < this.height * .8;"
        " const C = (typeof window !== 'undefined' && window.__BRAIN_CAMERA__) || {};"
        " const fov = C.fov != null ? C.fov : 35; if (this.camera.fov !== fov) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }"
        " this.camera.position.set(C.x != null ? C.x : 0, compact ? (C.cyCompact != null ? C.cyCompact : 2.6) : (C.cy != null ? C.cy : 2.0), compact ? (C.czCompact != null ? C.czCompact : 17.0) : (C.cz != null ? C.cz : 10.0));"
        " this.controls.target.set(C.tx != null ? C.tx : 0, compact ? (C.tyCompact != null ? C.tyCompact : .28+Math.max(0,760-this.height)*.0055) : (C.ty != null ? C.ty : 0), C.tz != null ? C.tz : 0);"
        " this.controls.update(); this.brain.rotation.set(C.rx != null ? C.rx : 0, C.ry != null ? C.ry : 0, C.rz != null ? C.rz : 0); }",
        "相机/目标点/脑体初始旋转由 window.__BRAIN_CAMERA__ 覆盖 —— 标定入口",
    ),
    (
        "P8",
        "this.brain = new THREE.Group(); this.brain.position.y = .08; this.brain.scale.set(1.15,.94,1.0); this.scene.add(this.brain);",
        "const T = (typeof window !== 'undefined' && window.__BRAIN_TRANSFORM__) || {};"
        " this.brain = new THREE.Group();"
        " this.brain.position.set(T.x != null ? T.x : 0, T.y != null ? T.y : .08, T.z != null ? T.z : 0);"
        " this.brain.scale.set(T.sx != null ? T.sx : 1.15, T.sy != null ? T.sy : .94, T.sz != null ? T.sz : 1.0);"
        " this.scene.add(this.brain);",
        "脑体位移/缩放由 window.__BRAIN_TRANSFORM__ 覆盖 —— 构图微调入口",
    ),
    (
        "P9",
        "  dispose() { this.scene?.dispose(); this.scene = null; },",
        "  dispose() { this.scene?.dispose(); this.scene = null; this.ready = false; this._status = null; },",
        "dispose() 复位 ready/_status",
    ),
    (
        "P9b",
        "this.bloom = new UnrealBloomPass(new THREE.Vector2(1280, 720), .72, .48, .50);",
        "const B = (typeof window !== 'undefined' && window.__BRAIN_BLOOM__) || {};"
        " this.bloom = new UnrealBloomPass(new THREE.Vector2(1280, 720), B.strength != null ? B.strength : .72, B.radius != null ? B.radius : .48, B.threshold != null ? B.threshold : .50);",
        "泛光三参数可由 window.__BRAIN_BLOOM__ 覆盖 —— 与设计稿亮度/辉光范围对齐的入口",
    ),
    (
        "P9c",
        "this.stage.visible=o.art;this.bloom.strength=.35+o.glow*.006;",
        "this.stage.visible=o.art;this.bloom.strength=(o.bloomStrength != null ? o.bloomStrength : .35+o.glow*.006);"
        " if(o.bloomRadius != null)this.bloom.radius=o.bloomRadius;"
        " if(o.bloomThreshold != null)this.bloom.threshold=o.bloomThreshold;",
        "animate() 里泛光强度原来由 glow 换算，改为可被 bloomStrength/Radius/Threshold 直接指定",
    ),
    (
        "P9d",
        "this.renderer.toneMappingExposure = 1.15;",
        "this.renderer.toneMappingExposure = (typeof window !== 'undefined' && window.__BRAIN_EXPOSURE__) || 1.15;",
        "曝光可由 window.__BRAIN_EXPOSURE__ 覆盖（整帧亮度，最后才动）",
    ),
    (
        "P12",
        "    ring(1.87,2.35,cyan,.7,.18);ring(2.15,2.35,cyan,.35,.18);ring(1.55,2.27,gold,.45,.18);",
        "    this.topRing = new THREE.Group(); this.stage.add(this.topRing);\n"
        "    [ring(1.87,2.35,cyan,.7,.18), ring(2.15,2.35,cyan,.35,.18), ring(1.55,2.27,gold,.45,.18)].forEach((l) => {\n"
        "      const pos = l.geometry.attributes.position;\n"
        "      for (let vi = 0; vi < pos.count; vi++) pos.setY(vi, pos.getY(vi) - 2.35);\n"
        "      pos.needsUpdate = true; l.position.y = 2.35; this.stage.remove(l); this.topRing.add(l);\n"
        "    });",
        "顶部三道轨道环收进独立的 topRing 组（几何中心搬到组原点），供顶部珠链环整组缩放/位移",
    ),
    (
        "P13",
        "      this.stage.add(group);this.rings.push(group);",
        "      if(layer===1){this.topRing.add(group);}else{this.stage.add(group);}this.rings.push(group);",
        "珠链组（layer=1，y=2.35 的那一圈）也挂进 topRing 组",
    ),
    (
        "P14",
        "    this.makeStage();\n    this.haze=createHaze();this.scene.add(this.haze);",
        "    this.makeStage();\n"
        "    if(this.topRing){const SC=(typeof window!=='undefined'&&window.__BRAIN_STAGE__)||{};"
        "this.topRing.scale.setScalar(SC.topScale!=null?SC.topScale:1);"
        "this.topRing.position.set(SC.topX!=null?SC.topX:0, SC.topY!=null?SC.topY:0, SC.topZ!=null?SC.topZ:0);}\n"
        "    this.haze=createHaze();this.scene.add(this.haze);",
        "topRing 组的 scale/position 可由 window.__BRAIN_STAGE__ 覆盖 —— 顶部珠链环标定入口",
    ),
]

AUTO_MOUNT_MARK = "(async () => {"

EXPORT_BLOCK = """
// ============================================================
// ES module 导出（生成脚本追加）
//   本项目只通过 mount.js 使用：mountBrain(canvasEl, opts)
//   window.CortexBrain3D 同时保留，兼容 dafeiyu 原 demo 的用法。
// ============================================================
export const CortexBrain3D = window.CortexBrain3D;
export const options = CortexBrain3D.options;
export default CortexBrain3D;
"""

BANNER = """// ============================================================
// 由 src/brain/gen_brain3d.py 从上游 brain3d.py 的 build() 生成，请勿手改。
// 上游：dafeiyu-3d-brain/brain3d.py（MIT），皮层数据 Anderson Winkler CC BY-SA 3.0。
// CORTEX_BASE = "{base}"（fetch 的路径按页面 URL 相对解析）
// 生成命令：python src/brain/gen_brain3d.py
// ============================================================
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=str(DEFAULT_REPO))
    ap.add_argument("--out", default=str(OUT))
    args = ap.parse_args()

    repo = pathlib.Path(args.repo)
    if not (repo / "brain3d.py").is_file():
        print(f"[FAIL] 找不到 {repo / 'brain3d.py'}", file=sys.stderr)
        return 2
    sys.path.insert(0, str(repo))
    import brain3d  # noqa: E402

    src = brain3d.build(CORTEX_BASE)
    raw_len = len(src)

    applied = []
    for pid, old, new, why in PATCHES:
        n = src.count(old)
        if n != 1:
            print(f"[FAIL] 补丁 {pid} 命中 {n} 次（应为 1）：{why}", file=sys.stderr)
            print(f"       原文片段：{old[:120]!r}", file=sys.stderr)
            return 3
        src = src.replace(old, new)
        applied.append(pid)

    # P10 砍掉自动挂载 IIFE
    i = src.find(AUTO_MOUNT_MARK)
    if i < 0:
        print("[FAIL] P10 找不到自动挂载 IIFE", file=sys.stderr)
        return 3
    tail_cut = src[i:]
    if "})();" not in tail_cut:
        print("[FAIL] P10 IIFE 结尾不完整", file=sys.stderr)
        return 3
    src = src[:i].rstrip() + "\n"
    applied.append("P10")

    src = BANNER.format(base=CORTEX_BASE) + src + EXPORT_BLOCK

    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(src, encoding="utf-8")

    print(f"brain3d.build() = {raw_len} chars")
    print(f"补丁命中：{', '.join(applied)}（{len(applied)}/{len(PATCHES) + 1}）")
    print(f"移除自动挂载 IIFE：{len(tail_cut)} chars")
    print(f"写出：{out}  {out.stat().st_size} bytes")
    # 自检：import 必须在最前面（注释之后）、不能残留 __CORTEX_BASE__、必须只有一个 default export
    body = src.split("\n")
    first_code = next((ln for ln in body if ln.strip() and not ln.strip().startswith("//")), "")
    assert first_code.startswith("import "), f"首行代码不是 import：{first_code!r}"
    assert "__CORTEX_BASE__" not in src, "残留 __CORTEX_BASE__ 占位符"
    assert src.count("export default") == 1, "default export 不唯一"
    print("自检通过：import 置顶 / 无占位符 / 单一 default export")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
