/**
 * 记忆神经网络 · 皮层 3D 大脑的挂载层
 * ================================================================
 * 底层是上游 dafeiyu-3d-brain（经 src/brain/gen_brain3d.py 从 brain3d.py 的 build()
 * 生成到 assets/vendor/brain3d.js）。本文件只做三件事：
 *   1) 稳定的上层 API（mountBrain / setData / setOptions / rotate / reset / setDensity /
 *      onSelect / dispose），把上游 window.CortexBrain3D 的细节挡在里面；
 *   2) 时序：setData 早于场景就绪时不丢数据（上游缓存 pendingGraph，这里再兜一层）；
 *   3) 错误一律写进 #model-loading（找不到就 console.error），不许静默白屏。
 *
 * 相机标定参数在下方 BRAIN_CAMERA / BRAIN_TRANSFORM，数值来源见
 * docs/04-brain-notes.md 的几何量对照表（ref.png → 实现侧）。
 *
 * 确定性截图模式：URL 带 ?still=1（或 opts.still=true）时自动旋转关、动画时间冻结。
 * 上游所有随机量都走 seeded() 的字符串哈希，没有 Math.random()；devicePixelRatio
 * 在无头 Chrome 下恒为 1，因此两次截图必须逐像素一致（实测 diff=0%）。
 */

import Brain from '../../assets/vendor/brain3d.js';

/** 相机标定值（1819×865 设计稿下标定；画布是中间舞台，约 1230×744）。 */
export const BRAIN_CAMERA = {
  fov: 35,
  x: 0.02, cy: 2.08, cz: 10.65,
  tx: 0, ty: 0.02, tz: 0,
  rx: 0, ry: 0, rz: 0,
  yaw: 0,
  cyCompact: 2.9, czCompact: 17.2,
};

/** 脑体 group 的位移/缩放（上游构造默认 0,.08,0 / 1.15,.94,1）。 */
export const BRAIN_TRANSFORM = { x: 0.23, y: 0.45, z: 0, sx: 1.235, sy: 0.99, sz: 1.0 };

/** 泛光三参数：设计稿的节点是「亮核 + 短光晕」，不是大光斑。 */
export const BRAIN_BLOOM = { strength: 0.70, radius: 0.30, threshold: 0.78 };

/** 默认 glow（节点尺寸因子 + 光纤亮度）。 */
export const BRAIN_GLOW = 60;

/** 整帧曝光。 */
export const BRAIN_EXPOSURE = 0.80;

/** 顶部珠链环整组缩放（本设计隐藏 stage，仅保留兼容）。 */
export const BRAIN_STAGE = { topScale: 1.19, topX: 0, topY: 0, topZ: 0 };

const LOADING_ID = 'model-loading';

// ---------------------------------------------------------------- 内部状态
let current = null;          // 当前 controller
let pendingGraph = null;     // 场景就绪前收到的数据
let pendingOptions = {};     // 场景就绪前收到的 setOptions 补丁（挂载后补上）
let lastSelectCb = null;
let lastOptions = {};

function loadingEl() {
  return document.getElementById(LOADING_ID);
}

function show(msg, isError = false) {
  const el = loadingEl();
  if (!el) {
    if (isError) console.error('[brain]', msg);
    return;
  }
  const text = el.querySelector('.ml-text');
  if (text) text.textContent = msg;
  else el.textContent = msg;
  el.classList.remove('is-hidden');
  el.classList.toggle('is-error', isError);
  el.dataset.state = isError ? 'error' : 'loading';
}

function hide() {
  const el = loadingEl();
  if (el) el.classList.add('is-hidden');
}

function errText(e) {
  if (!e) return '未知错误';
  return e.message || String(e);
}

function stillFromUrl(opts) {
  if (typeof opts.still === 'boolean') return opts.still;
  try {
    return new URLSearchParams(location.search).has('still');
  } catch (_) {
    return false;
  }
}

function applyCameraOpts(opts) {
  // 相机/脑体变换必须在 new HologramScene 之前挂到 window 上：上游 reset() 在
  // 构造期就会读它们（ResizeObserver → resize() → reset()）。
  const cam = { ...BRAIN_CAMERA, ...(opts.camera || {}) };
  const tr = { ...BRAIN_TRANSFORM, ...(opts.transform || {}) };
  const bloom = { ...BRAIN_BLOOM, ...(opts.bloom || {}) };
  const stage = { ...BRAIN_STAGE, ...(opts.stage || {}) };
  window.__BRAIN_CAMERA__ = cam;
  window.__BRAIN_TRANSFORM__ = tr;
  window.__BRAIN_BLOOM__ = bloom;
  window.__BRAIN_STAGE__ = stage;
  window.__BRAIN_EXPOSURE__ = opts.exposure != null ? opts.exposure : BRAIN_EXPOSURE;
  return { cam, tr, bloom, stage };
}

// ---------------------------------------------------------------- 公开 API
/**
 * 把 3D 皮层大脑挂到 canvas 上。
 * @param {HTMLCanvasElement|string} canvasEl 画布元素（也接受 id 字符串）
 * @param {object} [opts]
 *   - still: boolean            确定性模式（默认读 ?still=1）
 *   - data: graph               mount 时顺带给的数据，等价于先 setData
 *   - camera / transform / bloom: object 覆盖标定参数（见 BRAIN_CAMERA / BRAIN_TRANSFORM / BRAIN_BLOOM）
 *   - glow: number              光纤/节点亮度与连线密度因子（默认 BRAIN_GLOW=120，上游默认 60）
 *   - density: number           光纤/连线密度 0..100（默认 32）
 *   - onSelect: (node) => void  节点点击回调
 *   - timeout: number           等皮层加载的超时 ms（默认 45000）
 * @returns {Promise<object>} controller：{ setData, setOptions, rotate, reset,
 *   setDensity, onSelect, dispose, ready, loadMs, scene, canvas }
 */
export async function mountBrain(canvasEl, opts = {}) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const canvas = typeof canvasEl === 'string' ? document.getElementById(canvasEl) : canvasEl;
  if (!canvas) return fail('找不到画布元素，3D 无法挂载。');

  if (current) current.dispose();

  show(opts.loadingText || '正在加载记忆皮层…');
  const { cam, tr, bloom, stage } = applyCameraOpts(opts);
  const still = stillFromUrl(opts);

  let resolveReady;
  const readyPromise = new Promise((res) => { resolveReady = res; });
  const timeout = opts.timeout || 45000;
  const timer = setTimeout(() => {
    show(`皮层模型加载超时（>${Math.round(timeout / 1000)}s），请刷新重试。`, true);
    resolveReady({ ok: false, error: new Error('timeout') });
  }, timeout);

  const sub = (s) => {
    if (s.state === 'ready') {
      clearTimeout(timer);
      const loadMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
      hide();
      resolveReady({ ok: true, loadMs });
    } else if (s.state === 'error') {
      clearTimeout(timer);
      show(s.message || '大脑模型加载失败。', true);
      resolveReady({ ok: false, error: new Error(s.message || 'load error') });
    }
  };
  Brain._subs.push(sub);

  // 确定性模式：自动旋转关 + 动画时间冻结（running=false 后 time 不再累加，
  // 所有 shader 的 uTime 停在 0；随机量全部是 seeded()，无 Math.random()）。
  Brain.setOptions({
    bloomStrength: bloom.strength,
    bloomRadius: bloom.radius,
    bloomThreshold: bloom.threshold,
    brainYaw: cam.yaw != null ? cam.yaw : 0,
    glow: opts.glow != null ? opts.glow : BRAIN_GLOW,
    art: opts.art === true,
    density: opts.density != null ? opts.density : 36,
  });
  if (still) {
    Brain.setOptions({ running: false, autoRotate: false, art: opts.art === true });
  } else {
    Brain.setOptions({ running: true, autoRotate: true, art: opts.art === true });
  }
  if (opts.glow != null) Brain.setOptions({ glow: opts.glow });
  if (opts.density != null) Brain.setOptions({ density: opts.density });
  if (Object.keys(pendingOptions).length) {
    Brain.setOptions(pendingOptions);   // 挂载前上层调过的 setOptions 在这里补上
    pendingOptions = {};
  }
  lastOptions = { ...Brain.options };

  let mounted = false;
  try {
    mounted = await Brain.mount(canvas);
  } catch (e) {
    show('三维场景创建失败：' + errText(e), true);
    console.error('[brain] mount 抛错', e);
    clearTimeout(timer);
    return fail('三维场景创建失败：' + errText(e));
  }
  if (!mounted) {
    clearTimeout(timer);
    return fail('三维场景创建失败（可能是 WebGL 不可用）。');
  }

  const controller = {
    canvas,
    still,
    camera: cam,
    transform: tr,
    bloom,
    stage,
    ready: false,
    loadMs: 0,
    get scene() { return Brain.scene; },
    setData(graph) {
      pendingGraph = graph;
      if (Brain.scene) Brain.setData(graph);
    },
    setOptions(patch) {
      Object.assign(lastOptions, patch || {});
      if (Brain.scene) Brain.setOptions(patch);
    },
    rotate(on) {
      if (Brain.scene) return Brain.rotate(on);
      Brain.options.autoRotate = on !== false;
      return Brain.options.autoRotate;
    },
    reset() { if (Brain.scene) Brain.reset(); },
    setDensity(n) {
      const v = Math.max(0, Math.min(100, Number(n) || 0));
      this.setOptions({ density: v });
    },
    setRunning(on) { this.setOptions({ running: on !== false }); },
    setAutoRotate(on) { return this.rotate(on !== false); },
    setArt(on) { this.setOptions({ art: on === true }); },
    setGlow(n) { this.setOptions({ glow: Math.max(0, Math.min(160, Number(n) || 0)) }); },
    setBloom({ strength, radius, threshold } = {}) {
      const patch = {};
      if (strength != null) patch.bloomStrength = Math.max(0, Math.min(2, Number(strength)));
      if (radius != null) patch.bloomRadius = Math.max(0, Math.min(1.5, Number(radius)));
      if (threshold != null) patch.bloomThreshold = Math.max(0, Math.min(1, Number(threshold)));
      this.setOptions(patch);
    },
    getOptions() { return { ...Brain.options }; },
    select(id) { try { Brain.scene?.select?.(id) } catch (_) {} },
    setPointer(enabled) {
      try {
        const c = Brain.scene?.controls
        if (c) { c.enabled = enabled !== false; c.enableRotate = enabled !== false; c.enableZoom = enabled !== false; }
        canvas.style.cursor = enabled === false ? 'default' : 'grab'
      } catch (_) {}
    },
    onSelect(cb) {
      lastSelectCb = typeof cb === 'function' ? cb : null;
      window.__onSelect = lastSelectCb;
    },
    dispose() {
      clearTimeout(timer);
      const i = Brain._subs.indexOf(sub);
      if (i >= 0) Brain._subs.splice(i, 1);
      try { Brain.dispose(); } catch (_) {}
      window.__onSelect = null;
      current = null;
      pendingGraph = null;
      pendingOptions = {};
    },
    whenReady() { return readyPromise; },
  };
  current = controller;

  if (opts.haze === false && Brain.scene?.haze) Brain.scene.haze.visible = false;
  if (opts.data) controller.setData(opts.data);
  else if (pendingGraph) controller.setData(pendingGraph);
  if (opts.onSelect) controller.onSelect(opts.onSelect);
  else if (lastSelectCb) window.__onSelect = lastSelectCb;

  const result = await readyPromise;
  controller.ready = result.ok;
  controller.loadMs = result.loadMs || 0;
  if (!result.ok) {
    controller.dispose();
    return fail(result.error ? errText(result.error) : '大脑模型加载失败。');
  }
  if (still) {
    // 冻结后把最后一帧画完：rAF 在无头 Chrome 的 virtual-time 里会继续跑，
    // 但 time 不变 → 每帧像素相同。
    controller.reset();
  }
  console.log(`[brain] 就绪，加载 ${controller.loadMs.toFixed(0)}ms${still ? '（still 模式）' : ''}`);
  return controller;
}

function fail(msg) {
  show(msg, true);
  console.error('[brain]', msg);
  throw new Error(msg);
}

// ---------------------------------------------------------------- 单例转发
// 上层如果只想"一个页面一个脑"，直接 import 这几个函数即可；它们转发到最近一次
// mountBrain 返回的 controller。多实例场景请用 mountBrain 返回的对象。
export function setData(graph) {
  if (current) return current.setData(graph);
  pendingGraph = graph;              // 场景还没就绪：先存着
}
export function setOptions(patch) {
  lastOptions = { ...lastOptions, ...(patch || {}) };
  if (current) return current.setOptions(patch);
  pendingOptions = { ...pendingOptions, ...(patch || {}) };
  if (patch && 'density' in patch) Brain.setOptions({ density: patch.density });
  if (patch && 'glow' in patch) Brain.setOptions({ glow: patch.glow });
}
export function rotate(on) {
  if (current) return current.rotate(on);
  Brain.options.autoRotate = on !== false;
  return Brain.options.autoRotate;
}
export function reset() { if (current) return current.reset(); }
export function setDensity(n) { if (current) return current.setDensity(n); }
export function onSelect(cb) {
  lastSelectCb = typeof cb === 'function' ? cb : null;
  window.__onSelect = lastSelectCb;
  if (current) current.onSelect(cb);
}
export function dispose() { if (current) current.dispose(); }
export function getBrain() { return current || Brain; }
export { Brain };
