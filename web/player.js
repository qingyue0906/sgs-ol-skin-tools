"use strict";

const LAYER_NAMES = ["beijing", "daiji", "qianjing", "xingxiang"];
const LAYER_LABEL = { beijing: "背景", daiji: "人物", qianjing: "前景", xingxiang: "形象" };
const LAYER_DEFAULT_ON = { beijing: true, daiji: true, qianjing: true, xingxiang: false };

const canvas = document.getElementById("glCanvas");
const msgEl = document.getElementById("msg");
const skinNameEl = document.getElementById("skinName");
const statusEl = document.getElementById("status");
const skinListEl = document.getElementById("skinList");
const layerCtrlsEl = document.getElementById("layerControls");

let context = null, renderer = null, am = null;
let layers = [];        // {name, skeletonData, skeleton, state, enabled, animNames}
let skinIds = [], cur = -1;
let speed = 1, looping = true, playing = true, zoomMul = 1, loadSeq = 0;
let pan = { x: 0, y: 0 };   // 相对适配中心的偏移（CSS 像素）
let fpsLimit = 60, lastFrame = 0;

function setStatus(s) { statusEl.textContent = s || ""; }
function showMsg(s) { msgEl.textContent = s; msgEl.style.display = "block"; }
function hideMsg() { msgEl.style.display = "none"; }

window.addEventListener("error", e => {
  showMsg("脚本错误: " + (e.message || e.error));
  setStatus("");
});

function fetchJSON(u) {
  return fetch(u).then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
}

function resizeCanvas() {
  if (!renderer) return;
  try {
    renderer.resize(spine.ResizeMode.Expand);
  } catch (e) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    renderer.camera.viewportWidth = w;
    renderer.camera.viewportHeight = h;
  }
}

function initGL() {
  if (context) return;
  context = new spine.ManagedWebGLRenderingContext(canvas, { alpha: true, preserveDrawingBuffer: true });
  renderer = new spine.SceneRenderer(canvas, context);
  window.addEventListener("resize", () => { resizeCanvas(); fit(); });
  requestAnimationFrame(tick);
}

function computeLayerBounds(l) {
  const sd = l.skeletonData;
  const anims = sd.animations;
  const anim = anims.find(a => a.name === l.curAnim) || anims[0];
  const sk = new spine.Skeleton(sd);
  sk.setToSetupPose();
  try { sk.setSkinByName("default"); } catch (e) {}
  const st = new spine.AnimationState(new spine.AnimationStateData(sd));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = () => {
    const off = new spine.Vector2(), size = new spine.Vector2();
    sk.getBounds(off, size, new Array(2));
    if (!isFinite(size.x) || !isFinite(size.y)) return;
    minX = Math.min(minX, off.x); minY = Math.min(minY, off.y);
    maxX = Math.max(maxX, off.x + size.x); maxY = Math.max(maxY, off.y + size.y);
  };
  if (anim) {
    st.setAnimation(0, anim.name, false);
    st.apply(sk);
    sk.updateWorldTransform();
    acc();
    const dur = anim.duration || 0;
    if (dur > 0) {
      const step = 1 / 30;
      let t = 0;
      while (t < dur) {
        const dt = Math.min(step, dur - t);
        st.update(dt);
        st.apply(sk);
        sk.updateWorldTransform();
        acc();
        t += dt;
      }
    }
  } else {
    sk.updateWorldTransform();
    acc();
  }
  l.bounds = isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

function zoomLabel() {
  return Math.round(100 / zoomMul) + "%";
}

function applyCamera() {
  if (!renderer || !layers.length) return;
  zoomMul = Math.min(50, Math.max(0.1, zoomMul));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of layers) {
    if (!l.bounds) continue;
    minX = Math.min(minX, l.bounds.minX); minY = Math.min(minY, l.bounds.minY);
    maxX = Math.max(maxX, l.bounds.maxX); maxY = Math.max(maxY, l.bounds.maxY);
  }
  if (!isFinite(minX)) return;
  const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const zoom = 1 / (Math.min(canvas.width / w, canvas.height / h) * 0.94 * zoomMul);
  const scale = canvas.width / Math.max(1, canvas.clientWidth);  // 设备像素 / CSS 像素
  renderer.camera.position.set(cx + pan.x * zoom * scale, cy - pan.y * zoom * scale, 0);
  renderer.camera.zoom = zoom;
  const lbl = document.getElementById("zoomVal");
  if (lbl) lbl.textContent = "缩放 " + zoomLabel();
}

function fit() { applyCamera(); }

function zoomAt(mx, my, f) {
  const next = zoomMul * f;
  if (next < 0.1 || next > 50) return;
  const cw = Math.max(1, canvas.clientWidth), ch = Math.max(1, canvas.clientHeight);
  pan.x = f * pan.x + (f - 1) * (mx - cw / 2);
  pan.y = f * pan.y - (f - 1) * (ch / 2 - my);
  zoomMul = next;
  applyCamera();
}

canvas.addEventListener("wheel", e => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
}, { passive: false });

let dragging = false, lastX = 0, lastY = 0;
canvas.addEventListener("pointerdown", e => {
  if (e.button !== 0) return;
  dragging = true;
  lastX = e.clientX; lastY = e.clientY;
  try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
});
canvas.addEventListener("pointermove", e => {
  if (!dragging) return;
  pan.x -= e.clientX - lastX;
  pan.y -= e.clientY - lastY;
  lastX = e.clientX; lastY = e.clientY;
  applyCamera();
});
canvas.addEventListener("pointerup", () => { dragging = false; });
canvas.addEventListener("pointercancel", () => { dragging = false; });

canvas.addEventListener("dblclick", () => {
  zoomMul = 1;
  pan.x = 0; pan.y = 0;
  applyCamera();
});

function applyLayerAnim(l, doFit = true) {
  const sel = document.querySelector('.layerAnim[data-layer="' + l.name + '"]');
  const name = sel && sel.value ? sel.value : (l.animNames.length ? l.animNames[0] : null);
  if (name) {
    l.state.setAnimation(0, name, looping);
    l.curAnim = name;
  }
  computeLayerBounds(l);
  if (doFit) fit();
}

function buildLayerControls() {
  layerCtrlsEl.innerHTML = "";
  for (const l of layers) {
    const row = document.createElement("span");
    row.className = "layer-row";
    row.innerHTML =
      '<label><input type="checkbox" class="layerOn" data-layer="' + l.name + '"' +
      (l.enabled ? " checked" : "") + '></label>' +
      '<span class="lname">' + LAYER_LABEL[l.name] + '</span>' +
      '<select class="layerAnim" data-layer="' + l.name + '"></select>';
    if (!l.enabled) row.classList.add("off");
    const sel = row.querySelector(".layerAnim");
    for (const an of l.animNames) {
      const opt = document.createElement("option");
      opt.value = an; opt.textContent = an;
      sel.appendChild(opt);
    }
    sel.value = l.animNames.length ? l.animNames[0] : "";
    row.querySelector(".layerOn").addEventListener("change", e => {
      l.enabled = e.target.checked;
      row.classList.toggle("off", !l.enabled);
      fit();
    });
    sel.addEventListener("change", () => { applyLayerAnim(l); });
    layerCtrlsEl.appendChild(row);
  }
}

function buildLayers(id, names) {
  for (const n of names) {
    const atlas = am.get("output/skins/" + id + "/" + n + ".atlas");
    const jsonText = am.get("output/skins/" + id + "/" + n + ".json");
    const sd = new spine.SkeletonJson(new spine.AtlasAttachmentLoader(atlas))
                 .readSkeletonData(jsonText);
    const sk = new spine.Skeleton(sd);
    sk.setToSetupPose();
    try { sk.setSkinByName("default"); } catch (e) {}
    const st = new spine.AnimationState(new spine.AnimationStateData(sd));
    layers.push({
      name: n, skeletonData: sd, skeleton: sk, state: st,
      enabled: !!LAYER_DEFAULT_ON[n],
      animNames: sd.animations.map(a => a.name), curAnim: null, bounds: null
    });
  }
  layers.sort((a, b) => LAYER_NAMES.indexOf(a.name) - LAYER_NAMES.indexOf(b.name));
  buildLayerControls();
  for (const l of layers) applyLayerAnim(l, false);
  resizeCanvas();
  fit();
  setStatus("已加载 " + id);
}

function loadSkin(i) {
  if (i < 0 || i >= skinIds.length) return;
  cur = i;
  const id = skinIds[i];
  const seq = ++loadSeq;
  zoomMul = 1;
  pan.x = 0; pan.y = 0;
  skinNameEl.textContent = id + "（" + (i + 1) + "/" + skinIds.length + "）";
  highlightList();
  hideMsg();
  setStatus("加载 " + id + " ...");
  fetchJSON("/api/skin/" + id).then(info => {
    if (seq !== loadSeq) return;
    const names = LAYER_NAMES.filter(n =>
      info.files.includes(n + ".json") && info.files.includes(n + ".atlas"));
    initGL();
    if (am) { try { am.dispose(); } catch (e) {} am = null; }
    layers = [];
    if (!names.length) { setStatus(""); showMsg("该皮肤没有动皮文件（只有静皮或旧格式）"); return; }
    am = new spine.AssetManager(context, "/");
    let remaining = names.length * 2, failed = false;
    const oneDown = isErr => {
      if (seq !== loadSeq) return;
      if (isErr) failed = true;
      if (--remaining > 0) return;
      if (failed) { setStatus(""); showMsg("动皮资源加载失败（文件不完整？）"); return; }
      buildLayers(id, names);
    };
    for (const n of names) {
      am.loadTextureAtlas("output/skins/" + id + "/" + n + ".atlas",
        () => oneDown(false), () => oneDown(true));
      am.loadText("output/skins/" + id + "/" + n + ".json",
        () => oneDown(false), () => oneDown(true));
    }
  }).catch(e => { if (seq === loadSeq) { setStatus(""); showMsg("读取失败: " + e); } });
}

function refreshSkins() {
  fetchJSON("/api/skins").then(d => {
    skinIds = d.skins || [];
    skinListEl.innerHTML = "";
    if (!skinIds.length) {
      skinListEl.innerHTML = '<li class="empty">没有可播放的皮肤。<br>请先在"下载"面板抓取动皮。</li>';
      skinNameEl.textContent = "无皮肤";
      return;
    }
    for (let i = 0; i < skinIds.length; i++) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.textContent = skinIds[i];
      b.dataset.i = i;
      b.addEventListener("click", () => loadSkin(parseInt(b.dataset.i, 10)));
      li.appendChild(b);
      skinListEl.appendChild(li);
    }
    if (cur < 0) loadSkin(0); else loadSkin(cur);
  }).catch(e => showMsg("无法连接服务器: " + e));
}

function highlightList() {
  const btns = skinListEl.querySelectorAll("button");
  btns.forEach((b, i) => b.classList.toggle("active", i === cur));
}

function tick(now) {
  requestAnimationFrame(tick);
  if (!renderer || !layers.length) return;
  const interval = fpsLimit > 0 ? 1000 / fpsLimit : 0;
  if (interval) {
    if (now - lastFrame < interval) return;
    // 重同步到最近的帧间隔整数倍，避免高刷屏下帧率漂移（如 144Hz 屏限 60 帧掉到 48）
    lastFrame += Math.floor((now - lastFrame) / interval) * interval;
  } else {
    lastFrame = now;
  }
  resizeCanvas();
  const dt = Math.min(0.1, (now - (tick._last || now)) / 1000) * speed;
  tick._last = now;
  if (playing) {
    for (const l of layers) {
      if (!l.enabled) continue;
      l.state.update(dt);
      l.state.apply(l.skeleton);
      l.skeleton.updateWorldTransform();
    }
  }
  const gl = context.gl;
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  renderer.begin();
  for (const l of layers) if (l.enabled) renderer.drawSkeleton(l.skeleton, false);
  renderer.end();
}

document.getElementById("btnPrev").addEventListener("click", () => loadSkin(cur - 1));
document.getElementById("btnNext").addEventListener("click", () => loadSkin(cur + 1));
document.getElementById("btnPlay").addEventListener("click", () => {
  playing = !playing;
  document.getElementById("btnPlay").textContent = playing ? "暂停" : "播放";
});
document.getElementById("speed").addEventListener("input", e => {
  speed = parseInt(e.target.value, 10) / 100;
  document.getElementById("speedVal").textContent = speed.toFixed(2) + "x";
});
document.getElementById("fps").addEventListener("input", e => {
  let v = parseInt(e.target.value, 10);
  fpsLimit = (isNaN(v) || v < 0) ? 60 : Math.min(240, v);
});
document.getElementById("loop").addEventListener("change", e => {
  looping = e.target.checked;
  for (const l of layers) applyLayerAnim(l);
});
document.getElementById("btnShot").addEventListener("click", () => {
  if (!layers.length) return;
  const a = document.createElement("a");
  a.download = "skin_" + (skinIds[cur] || "shot") + ".png";
  a.href = canvas.toDataURL("image/png");
  a.click();
});
document.getElementById("btnZoomIn").addEventListener("click", () => { zoomMul *= 1.25; fit(); });
document.getElementById("btnZoomOut").addEventListener("click", () => { zoomMul /= 1.25; fit(); });

document.addEventListener("keydown", e => {
  if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
  if (e.key === "ArrowLeft") loadSkin(cur - 1);
  if (e.key === "ArrowRight") loadSkin(cur + 1);
});

resizeCanvas();
refreshSkins();