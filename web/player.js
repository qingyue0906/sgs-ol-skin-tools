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
let allSkins = [];      // 全量 [{id, name, playable, static}]，接口只拉一次
let skinIds = [], cur = -1;   // skinIds = 当前可见列表（搜索过滤后），cur 是它的下标
let loadedId = null;    // 当前已加载（或正在加载）的皮肤 ID，用于避免重复加载
let skinNames = {};     // {皮肤ID: 官方皮肤名}，取不到名字时列表回退只显示 ID
let labelMode = "name"; // name=显示皮肤名 / id=显示文件夹 ID
let searchText = "";    // 搜索关键词，匹配 ID 与皮肤名
let speed = 1, looping = true, playing = true, zoomMul = 1, loadSeq = 0;
let pan = { x: 0, y: 0 };   // 相对适配中心的偏移（CSS 像素）
let fpsLimit = 60, lastFrame = 0;
let playMode = "auto";      // auto=出场→待机循环 / chu=全部出场循环 / daiji=全部待机循环
let skinView = "grid";      // grid=网格（static 缩略图） / list=列表
let staticOn = false;       // 静态图预览开关（用户手动切换）
let staticForced = false;   // 是否因"仅静皮"皮肤被迫暂停，切回动皮时自动恢复
let staticWasPlaying = true;// 进入静态图前的播放状态
let skinHasStatic = false;  // 当前皮肤是否有 static.png

function setStatus(s) { statusEl.textContent = s || ""; }

// 列表显示文本：名称模式显示皮肤名（没有则回退 ID），ID 模式始终显示目录名
// title 显示另一项，方便对照：名称模式 → ID，ID 模式 → 皮肤名
function skinById(id) { return allSkins.find(s => s.id === id) || null; }
function skinNameOf(id) {
  const s = skinById(id);
  return (s && s.name) || skinNames[id] || "";
}
function skinLabel(id) {
  if (labelMode === "id") return id;
  return skinNameOf(id) || id;
}
function skinTitle(id) {
  const nm = skinNameOf(id);
  return labelMode === "id" ? nm : (nm ? id : "");
}
function showMsg(s) { msgEl.textContent = s; msgEl.style.display = "block"; }
function hideMsg() { msgEl.style.display = "none"; }

// 清空预览区（动皮 + 静态图 + 画布），用于筛空结果或仅静皮皮肤的切换
function clearViewer() {
  if (am) { try { am.dispose(); } catch (e) {} am = null; }
  layers = [];
  const ctrls = document.getElementById("layerControls");
  if (ctrls) ctrls.innerHTML = "";
  const img = document.getElementById("staticImg");
  if (img) { img.hidden = true; img.removeAttribute("src"); }
  const gl = context ? context.gl : null;
  if (gl) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
}

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
  updatePinMarker();
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
let downX = 0, downY = 0, dragDist = 0;
canvas.addEventListener("pointerdown", e => {
  if (e.button !== 0) return;
  dragging = true;
  lastX = e.clientX; lastY = e.clientY;
  downX = e.clientX; downY = e.clientY;
  dragDist = 0;
  try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
});
canvas.addEventListener("pointermove", e => {
  if (!dragging) return;
  dragDist = Math.max(dragDist, Math.hypot(e.clientX - downX, e.clientY - downY));
  pan.x -= e.clientX - lastX;
  pan.y -= e.clientY - lastY;
  lastX = e.clientX; lastY = e.clientY;
  applyCamera();
});
canvas.addEventListener("pointerup", e => {
  dragging = false;
  // 单击判定：几乎无位移的快速点击 → 图钉模式放图钉；拖动平移逻辑不受影响
  if (dragDist < 6 && texToolOn && pinMode) {
    const rect = canvas.getBoundingClientRect();
    placePin(e.clientX - rect.left, e.clientY - rect.top);
  }
});
canvas.addEventListener("pointercancel", () => { dragging = false; });

canvas.addEventListener("dblclick", () => {
  zoomMul = 1;
  pan.x = 0; pan.y = 0;
  applyCamera();
});

// ---- 纹理查看工具（鼠标位置 -> 对应纹理位置）----
let texToolOn = false;
let pinMode = false;     // 图钉模式：纹理查看开启即激活，单击动皮固定命中位置
let pinActive = false;   // 是否已放置图钉（固定后悬停不再刷新面板）
let pinHits = [];        // 图钉命中快照 [{layer, slot, att, page, ...}]
let pinWorld = null;     // 图钉世界坐标 {x, y}
let texHits = [];   // [{layer, slot, att, page, pageW, pageH, u, v, u2, v2, wx, wy}]
let texSel = -1;
const MAX_TEX_HITS = 20;   // 单次悬停最多收集的贴图命中数（防极端重叠刷屏）
const texPanel = document.getElementById("texPanel");
const texHitsEl = document.getElementById("texHits");
const texDetailEl = document.getElementById("texDetail");

function worldAtMouse(mx, my) {
  if (!renderer || !layers.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of layers) {
    if (!l.bounds) continue;
    minX = Math.min(minX, l.bounds.minX); minY = Math.min(minY, l.bounds.minY);
    maxX = Math.max(maxX, l.bounds.maxX); maxY = Math.max(maxY, l.bounds.maxY);
  }
  if (!isFinite(minX)) return null;
  const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const z = 1 / (Math.min(canvas.width / w, canvas.height / h) * 0.94 * zoomMul);
  const scale = canvas.width / Math.max(1, canvas.clientWidth);
  const cw = Math.max(1, canvas.clientWidth), ch = Math.max(1, canvas.clientHeight);
  return { x: cx + z * scale * (pan.x + mx - cw / 2),
           y: cy + z * scale * (ch / 2 - my - pan.y) };
}

function pointInTri(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function triBary(px, py, ax, ay, bx, by, cx, cy) {
  const v0x = cx - ax, v0y = cy - ay, v1x = bx - ax, v1y = by - ay, v2x = px - ax, v2y = py - ay;
  const dot00 = v0x * v0x + v0y * v0y, dot01 = v0x * v1x + v0y * v1y;
  const dot02 = v0x * v2x + v0y * v2y, dot11 = v1x * v1x + v1y * v1y, dot12 = v1x * v2x + v1y * v2y;
  const inv = 1 / (dot00 * dot11 - dot01 * dot01);
  return [(dot11 * dot02 - dot01 * dot12) * inv, (dot00 * dot12 - dot01 * dot02) * inv];
}

function hitLayer(l, wx, wy) {
  const slots = l.skeleton.slots;
  const out = [];
  let scratch = null;
  const seen = new Set();  // 同一附件（mesh 多三角形命中）只记一处
  for (let si = slots.length - 1; si >= 0; si--) {
    const slot = slots[si];
    const att = slot.getAttachment();
    if (!att || !att.region || !att.region.page || seen.has(att)) continue;
    let verts, tris, uvs;
    if (att.offset) {                       // RegionAttachment
      att.updateRegion();
      verts = new Float32Array(8);
      att.computeWorldVertices(slot, verts, 0, 2);
      tris = [0, 1, 2, 2, 3, 0];
      uvs = att.uvs;
    } else if (att.triangles) {             // MeshAttachment
      att.updateRegion();
      const n = att.worldVerticesLength;
      if (!scratch || scratch.length < n) scratch = new Float32Array(Math.max(256, n));
      verts = scratch;
      att.computeWorldVertices(slot, 0, n, verts, 0, 2);
      tris = att.triangles;
      uvs = att.uvs;
    } else continue;
    for (let t = 0; t < tris.length; t += 3) {
      const i0 = tris[t] * 2, i1 = tris[t + 1] * 2, i2 = tris[t + 2] * 2;
      const ax = verts[i0], ay = verts[i0 + 1], bx = verts[i1], by = verts[i1 + 1],
            cx = verts[i2], cy = verts[i2 + 1];
      if (!pointInTri(wx, wy, ax, ay, bx, by, cx, cy)) continue;
      const bc = triBary(wx, wy, ax, ay, bx, by, cx, cy);
      const u = (1 - bc[0] - bc[1]) * uvs[i0] + bc[0] * uvs[i1] + bc[1] * uvs[i2];
      const v = (1 - bc[0] - bc[1]) * uvs[i0 + 1] + bc[0] * uvs[i1 + 1] + bc[1] * uvs[i2 + 1];
      const page = att.region.page;
      let uMin = Infinity, vMin = Infinity, uMax = -Infinity, vMax = -Infinity;
      for (let k = 0; k < uvs.length; k += 2) {
        uMin = Math.min(uMin, uvs[k]); uMax = Math.max(uMax, uvs[k]);
        vMin = Math.min(vMin, uvs[k + 1]); vMax = Math.max(vMax, uvs[k + 1]);
      }
      out.push({ layer: l, slot: slot.data.name, att: att.name,
                 page: page.name, pageW: page.width, pageH: page.height,
                 u: u, v: v, u2: uMax, v2: vMax, wx: wx, wy: wy });
      seen.add(att);
      break;  // 该附件已命中，跳过其余三角形
    }
  }
  return out;
}

canvas.addEventListener("mousemove", e => {
  if (!texToolOn || !layers.length) return;
  if (pinActive) return;   // 图钉已固定：悬停不再刷新面板（快照锁定）
  const rect = canvas.getBoundingClientRect();
  const w = worldAtMouse(e.clientX - rect.left, e.clientY - rect.top);
  const hits = [];
  if (w) {
    for (const l of layers) {
      if (!l.enabled) continue;
      for (const h of hitLayer(l, w.x, w.y)) {
        if (hits.length >= MAX_TEX_HITS) break;
        hits.push(h);
      }
      if (hits.length >= MAX_TEX_HITS) break;
    }
  }
  texHits = hits;
  texSel = texHits.length ? texHits.length - 1 : -1;
  renderTexPanel();
});

function renderTexPanel() {
  if (!texToolOn) return;
  const h = texHits[texSel] || null;
  // 1) 命中条目列表（含数量提示）
  const listKey = texHits
    .map(x => x.layer.name + "|" + x.slot + "|" + x.att + "|" + x.u + "|" + x.v).join(";") + "|" + texSel;
  if (listKey !== texHitsEl._key) {
    texHitsEl.innerHTML = "";
    const info = document.createElement("div");
    info.className = "tex-hits-info";
    info.textContent = "命中 " + texHits.length + " 处贴图" +
      (texHits.length >= MAX_TEX_HITS ? "（已达上限，仅显示前 " + MAX_TEX_HITS + " 处）" : "（点选高亮）");
    texHitsEl.appendChild(info);
    texHits.forEach((hit, i) => {
      const b = document.createElement("button");
      b.className = i === texSel ? "active" : "";
      b.textContent = LAYER_LABEL[hit.layer.name] + " · " + hit.slot + " · " + hit.att;
      b.addEventListener("click", () => { texSel = i; renderTexPanel(); });
      texHitsEl.appendChild(b);
    });
    texHitsEl._key = listKey;
  }
  // 2) 贴图页分组：全部命中画十字（选中红色、其余蓝色半透明）
  let pagesEl = document.getElementById("texPages");
  if (!pagesEl) {
    texDetailEl.innerHTML =
      '<div id="texPages"></div>' +
      '<div class="tex-label">区域裁剪放大</div><canvas id="texCrop"></canvas>' +
      '<div class="tex-label">信息</div><div class="tex-info"></div>';
    pagesEl = document.getElementById("texPages");
  }
  const infoEl = texDetailEl.querySelector(".tex-info");
  const crop = document.getElementById("texCrop");
  if (!h) {
    pagesEl.innerHTML = "";
    texDetailEl._pagesKey = "";
    if (crop) crop.style.display = "none";
    if (infoEl) infoEl.innerHTML = '<div class="tex-empty">未命中纹理<br>鼠标移到皮肤上查看</div>';
    return;
  }
  const pagesKey = texHits.map(x => x.page + "|" + x.u + "|" + x.v + "|" + x.slot).join(";");
  if (texDetailEl._pagesKey !== pagesKey) {
    texDetailEl._pagesKey = pagesKey;
    const groups = new Map();
    texHits.forEach((hit, i) => {
      if (!groups.has(hit.page)) groups.set(hit.page, []);
      groups.get(hit.page).push({ hit, i });
    });
    pagesEl.innerHTML = "";
    for (const [page, items] of groups) {
      const it0 = items[0].hit;
      const block = document.createElement("div");
      block.className = "tex-page-block";
      block.dataset.page = page;
      const label = document.createElement("div");
      label.className = "tex-label";
      label.textContent = "贴图页 " + page + "（" + it0.pageW + "x" + it0.pageH + "）· " + items.length + " 处标记";
      block.appendChild(label);
      const wrap = document.createElement("div");
      wrap.className = "tex-page-wrap";
      const img = document.createElement("img");
      img.className = "tex-page-img";
      img.alt = page;
      img.src = "/output/skins/" + skinIds[cur] + "/" + page;
      wrap.appendChild(img);
      for (const { hit, i } of items) {
        const cross = document.createElement("span");
        cross.className = "tex-cross" + (i === texSel ? " active" : "");
        cross.dataset.i = i;
        cross.style.left = (hit.u * 100).toFixed(2) + "%";
        cross.style.top = (hit.v * 100).toFixed(2) + "%";
        wrap.appendChild(cross);
      }
      block.appendChild(wrap);
      pagesEl.appendChild(block);
    }
  } else {
    // 页面组未变，仅刷新十字选中态（避免图片重新加载）
    pagesEl.querySelectorAll(".tex-cross").forEach(c =>
      c.classList.toggle("active", parseInt(c.dataset.i, 10) === texSel));
  }
  // 3) 底部详情：裁剪放大 + 信息，跟随选中条目
  crop.style.display = "block";
  const img = pagesEl.querySelector('[data-page="' + h.page + '"] .tex-page-img');
  if (img) {
    if (img.complete && img.naturalWidth) drawCrop(crop, img, h);
    else img.onload = () => drawCrop(crop, img, h);
  }
  infoEl.innerHTML =
    "<b>层:</b> " + LAYER_LABEL[h.layer.name] + "（" + h.layer.name + "）<br>" +
    "<b>槽位:</b> " + h.slot + "<br>" +
    "<b>附件:</b> " + h.att + "<br>" +
    "<b>贴图页:</b> " + h.page + "<br>" +
    "<b>UV:</b> (" + h.u.toFixed(4) + ", " + h.v.toFixed(4) + ")<br>" +
    "<b>像素:</b> (" + Math.round(h.u * h.pageW) + ", " + Math.round(h.v * h.pageH) + ")<br>" +
    "<b>世界坐标:</b> (" + h.wx.toFixed(1) + ", " + h.wy.toFixed(1) + ")";
}

function drawCrop(crop, img, h) {
  const nw = img.naturalWidth || 1, nh = img.naturalHeight || 1;
  const sx = h.u * nw, sy = h.v * nh;
  const sw = Math.max(1, (h.u2 - h.u) * nw), sh = Math.max(1, (h.v2 - h.v) * nh);
  const scale = Math.min(1, 260 / sw);
  crop.width = Math.max(1, Math.round(sw * scale));
  crop.height = Math.max(1, Math.round(sh * scale));
  const ctx = crop.getContext("2d");
  ctx.clearRect(0, 0, crop.width, crop.height);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, crop.width, crop.height);
  crop.style.imageRendering = scale < 1 ? "" : "pixelated";
}

// ---- 图钉固定工具（单击锁定纹理，鼠标解放后可滚动右侧面板）----
function screenFromWorld(wx, wy) {
  if (!renderer || !layers.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of layers) {
    if (!l.bounds) continue;
    minX = Math.min(minX, l.bounds.minX); minY = Math.min(minY, l.bounds.minY);
    maxX = Math.max(maxX, l.bounds.maxX); maxY = Math.max(maxY, l.bounds.maxY);
  }
  if (!isFinite(minX)) return null;
  const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const z = 1 / (Math.min(canvas.width / w, canvas.height / h) * 0.94 * zoomMul);
  const scale = canvas.width / Math.max(1, canvas.clientWidth);
  const cw = Math.max(1, canvas.clientWidth), ch = Math.max(1, canvas.clientHeight);
  // worldAtMouse 的逆变换
  return { x: (wx - cx) / (z * scale) - pan.x + cw / 2,
           y: ch / 2 - pan.y - (wy - cy) / (z * scale) };
}

let pinMarker = null;
function ensurePinMarker() {
  if (pinMarker) return pinMarker;
  const main = document.getElementById("main");
  pinMarker = document.createElement("div");
  pinMarker.id = "texPin";
  main.appendChild(pinMarker);
  return pinMarker;
}

function updatePinMarker() {
  const m = ensurePinMarker();
  if (!pinActive || !pinWorld) { m.style.display = "none"; return; }
  const s = screenFromWorld(pinWorld.x, pinWorld.y);
  if (!s) { m.style.display = "none"; return; }
  m.style.display = "block";
  m.style.left = s.x + "px";
  m.style.top = s.y + "px";
}

function placePin(mx, my) {
  if (!layers.length) return;
  const w = worldAtMouse(mx, my);
  const hits = [];
  if (w) {
    for (const l of layers) {
      if (!l.enabled) continue;
      for (const h of hitLayer(l, w.x, w.y)) {
        if (hits.length >= MAX_TEX_HITS) break;
        hits.push(h);
      }
      if (hits.length >= MAX_TEX_HITS) break;
    }
  }
  if (!hits.length) {
    showPinTip("该位置未命中纹理，图钉未放置");
    return;
  }
  pinWorld = w;
  pinHits = hits;
  pinActive = true;
  texHits = hits;
  texSel = hits.length - 1;
  renderTexPanel();
  updatePinMarker();
  showPinTip("已固定该位置纹理，可移开鼠标滚动查看右侧面板");
}

function clearPin() {
  pinActive = false;
  pinHits = [];
  pinWorld = null;
  updatePinMarker();
  texHits = []; texSel = -1;
  texHitsEl._key = null; texDetailEl._pagesKey = null;
  renderTexPanel();
}

let pinTipTimer = null;
function showPinTip(msg) {
  let tip = document.getElementById("texPinTip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "texPinTip";
    document.getElementById("main").appendChild(tip);
  }
  tip.textContent = msg;
  tip.classList.remove("show");
  void tip.offsetWidth;   // 强制重排，重启动画
  tip.classList.add("show");
  clearTimeout(pinTipTimer);
  pinTipTimer = setTimeout(() => tip.classList.remove("show"), 4000);
}

canvas.addEventListener("contextmenu", e => {
  e.preventDefault();
  if (texToolOn && pinMode && pinActive) {
    clearPin();
    showPinTip("图钉已解除，鼠标悬停可实时查看，单击可重新固定");
  }
});

document.getElementById("btnTex").addEventListener("click", () => {
  texToolOn = !texToolOn;
  pinMode = texToolOn;   // 纹理查看开启即进入图钉模式
  texPanel.classList.toggle("hidden", !texToolOn);
  document.getElementById("btnTex").classList.toggle("active", texToolOn);
  if (!texToolOn) {
    clearPin();
  } else {
    showPinTip("图钉模式：单击动皮固定纹理查看，再单击其他位置更换，右键解除；拖动/缩放不受影响");
  }
  renderTexPanel();
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

function animExists(l, name) {
  return l.animNames.includes(name);
}

function setLayerAnim(l, name, loop) {
  l.state.setAnimation(0, name, loop);
  l.curAnim = name;
}

function applyPlayMode() {
  // 全局播放模式：有对应动画的层切换，其余层保持不动
  for (const l of layers) {
    if (playMode === "chu") {
      if (animExists(l, "ChuChang")) setLayerAnim(l, "ChuChang", true);
    } else if (playMode === "daiji") {
      if (animExists(l, "DaiJi")) setLayerAnim(l, "DaiJi", true);
    } else if (playMode === "auto") {
      if (animExists(l, "ChuChang")) setLayerAnim(l, "ChuChang", false);
    }
  }
}

function autoAdvance(l) {
  // 自动模式：出场动画播完自动切换待机循环；待机播完且未勾选循环则停在末帧
  if (playMode !== "auto") return;
  const e = l.state.getCurrent(0);
  if (!e || e.loop) return;
  if (e.trackTime < (e.animationEnd || 0) - 0.001) return;
  if (l.curAnim === "DaiJi") return;
  if (animExists(l, "DaiJi")) setLayerAnim(l, "DaiJi", looping);
  else if (l.animNames.length) setLayerAnim(l, l.animNames[0], looping);
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
      // 四层型（有 daiji）形象默认关；beijing+形象型（无 daiji）形象默认开
      enabled: n === "xingxiang" ? !names.includes("daiji") : !!LAYER_DEFAULT_ON[n],
      animNames: sd.animations.map(a => a.name), curAnim: null, bounds: null
    });
  }
  layers.sort((a, b) => LAYER_NAMES.indexOf(a.name) - LAYER_NAMES.indexOf(b.name));
  buildLayerControls();
  for (const l of layers) applyLayerAnim(l, false);
  applyPlayMode();
  resizeCanvas();
  fit();
  setStatus("已加载 " + id);
}

function loadSkin(i) {
  if (i < 0 || i >= skinIds.length) return;
  cur = i;
  const id = skinIds[i];
  loadedId = id;
  const seq = ++loadSeq;
  playMode = "auto";
  const pmSel = document.getElementById("playModeSel");
  if (pmSel) pmSel.value = "auto";
  zoomMul = 1;
  pan.x = 0; pan.y = 0;
  texHits = []; texSel = -1;
  if (texHitsEl) { texHitsEl._key = null; texDetailEl._pagesKey = null; }
  clearPin();
  const nm = skinNameOf(id);
  skinNameEl.textContent = (nm ? nm + " " : "") + id +
    "（" + (i + 1) + "/" + skinIds.length + "）";
  skinNameEl.title = id;
  highlightList();
  hideMsg();
  setStatus("加载 " + id + " ...");
  // 仅静皮（无动皮）：直接显示 static.png，省掉一次文件列表请求
  const meta = skinById(id);
  if (meta && !meta.playable) {
    if (am) { try { am.dispose(); } catch (e) {} am = null; }
    layers = [];
    buildLayerControls();
    closeTexPanel();
    clearViewer();
    skinHasStatic = !!meta.static;
    setPlayButtons(false);
    if (skinHasStatic) {
      showStaticOnly(id);
      setStatus("静皮（无动皮）");
    } else {
      setStatus("");
      showMsg("该皮肤既无动皮也无静皮（文件不完整？）");
    }
    return;
  }
  setPlayButtons(true);
  if (!staticOn) {
    // 从"仅静皮"切回动皮：收起静态图、恢复被迫暂停的播放，并复位按钮高亮
    if (staticForced) {
      staticForced = false;
      if (staticWasPlaying && !playing) {
        playing = true;
        const bp = document.getElementById("btnPlay");
        if (bp) bp.textContent = "暂停";
      }
    }
    const bs0 = document.getElementById("btnStatic");
    if (bs0) bs0.classList.remove("active");
    hideStaticImage();
  }
  fetchJSON("/api/skin/" + id).then(info => {
    if (seq !== loadSeq) return;
    skinHasStatic = info.files.includes("static.png");
    const bs = document.getElementById("btnStatic");
    if (bs) bs.disabled = !skinHasStatic;
    if (staticOn) {
      // 静态图模式下切换皮肤：保持静态图，只换图，不加载动皮
      if (skinHasStatic) {
        const img = document.getElementById("staticImg");
        if (img) { img.src = "/output/skins/" + id + "/static.png"; img.hidden = false; }
        setStatus("静态图预览");
        return;
      }
      staticExitState();  // 新皮肤没有静皮，退出静态图模式继续加载动皮
    }
    const names = LAYER_NAMES.filter(n =>
      info.files.includes(n + ".json") && info.files.includes(n + ".atlas"));
    initGL();
    if (am) { try { am.dispose(); } catch (e) {} am = null; }
    layers = [];
    if (!names.length) {
      // 兜底：标记为可播放但文件不全时，有静皮就退回静态图
      setStatus("");
      if (skinHasStatic) {
        setPlayButtons(false);
        showStaticOnly(id);
        setStatus("静皮（动皮文件不完整）");
      } else {
        showMsg("该皮肤没有动皮文件（只有静皮或旧格式）");
      }
      return;
    }
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

// 仅静皮皮肤专用：直接显示静态图。不改变 staticOn（那是用户手动开关的状态），
// 只记下被迫暂停，切回可播放皮肤时自动恢复播放并收起静态图
function showStaticOnly(id) {
  const img = document.getElementById("staticImg");
  if (!img) return;
  img.src = "/output/skins/" + id + "/static.png";
  img.hidden = false;
  staticWasPlaying = playing;
  staticForced = true;
  const bs = document.getElementById("btnStatic");
  if (bs) bs.classList.add("active");
  if (playing) {
    playing = false;
    const bp = document.getElementById("btnPlay");
    if (bp) bp.textContent = "播放";
  }
}

function hideStaticImage() {
  const img = document.getElementById("staticImg");
  if (img) img.hidden = true;
}

// 仅静皮皮肤下播放/静态图/纹理按钮无意义，统一置灰；换回可播放皮肤时恢复
function setPlayButtons(on) {
  for (const bid of ["btnPlay", "btnStatic", "btnTex"]) {
    const el = document.getElementById(bid);
    if (el) el.disabled = !on;
  }
  const pmSel = document.getElementById("playModeSel");
  if (pmSel) pmSel.disabled = !on;
}

// 关闭纹理查看面板（静态图或仅静皮皮肤下没有意义）
function closeTexPanel() {
  if (!texToolOn) return;
  texToolOn = false;
  pinMode = false;
  texPanel.classList.add("hidden");
  document.getElementById("btnTex").classList.remove("active");
  clearPin();
}

function staticExitState() {
  // 仅退出静态图状态与 UI，不重载动皮（调用方负责重载）
  staticOn = false;
  const img = document.getElementById("staticImg");
  if (img) img.hidden = true;
  const bs = document.getElementById("btnStatic");
  if (bs) bs.classList.remove("active");
  if (staticWasPlaying && !playing) {
    playing = true;
    const bp = document.getElementById("btnPlay");
    if (bp) bp.textContent = "暂停";
  }
}

function setStaticOn(on) {
  const img = document.getElementById("staticImg");
  const bs = document.getElementById("btnStatic");
  if (!img || !bs || on === staticOn) return;
  staticOn = on;
  if (staticOn) {
    if (!skinHasStatic || cur < 0) { staticOn = false; return; }
    // 彻底清理动皮（释放资源、清空图层与画布），避免透出暂停的动皮帧
    if (am) { try { am.dispose(); } catch (e) {} am = null; }
    layers = [];
    const ctrls = document.getElementById("layerControls");
    if (ctrls) ctrls.innerHTML = "";
    const gl = context ? context.gl : null;
    if (gl) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
    img.src = "/output/skins/" + skinIds[cur] + "/static.png";
    img.hidden = false;
    staticWasPlaying = playing;
    if (playing) {
      playing = false;
      document.getElementById("btnPlay").textContent = "播放";
    }
    closeTexPanel();  // 静态图下纹理工具无意义
  } else {
    staticExitState();
    loadSkin(cur);  // 重新加载动皮
  }
  bs.classList.toggle("active", staticOn);
}

function refreshSkins() {
  fetchJSON("/api/skins").then(d => {
    const list = d.skins || [];
    // 兼容老服务端返回的字符串数组：字符串一律当作可播放皮肤
    allSkins = list.map(s => (typeof s === "string"
      ? { id: s, name: "", playable: true, static: false }
      : {
          id: s.id, name: s.name || "",
          playable: s.playable !== false, static: !!s.static
        }));
    skinNames = {};
    allSkins.forEach(s => { if (s.name) skinNames[s.id] = s.name; });
    applyFilter();
  }).catch(e => showMsg("无法连接服务器: " + e));
}

// 按搜索词重算可见列表（纯本地，不打接口）；选中项按 id 找回，找不到则落到第一个
function applyFilter() {
  const q = searchText.trim().toLowerCase();
  const prevId = cur >= 0 ? skinIds[cur] : null;
  const visible = q
    ? allSkins.filter(s =>
        s.id.toLowerCase().includes(q) || (s.name || "").toLowerCase().includes(q))
    : allSkins.slice();
  skinIds = visible.map(s => s.id);
  renderSkinList();
  const cnt = document.getElementById("skinCount");
  if (cnt) cnt.textContent = allSkins.length ? skinIds.length + " / " + allSkins.length : "";
  if (!skinIds.length) {
    cur = -1; loadedId = null;
    skinNameEl.textContent = "无皮肤";
    clearViewer();
    return;
  }
  let i = prevId ? skinIds.indexOf(prevId) : -1;
  if (i < 0) i = 0;
  if (skinIds[i] !== loadedId) loadSkin(i);
  else { cur = i; highlightList(); }
}

function renderSkinList() {
  skinListEl.innerHTML = "";
  if (!skinIds.length) {
    skinListEl.innerHTML = allSkins.length
      ? '<li class="empty">没有匹配的皮肤。<br>换个关键词试试。</li>'
      : '<li class="empty">没有可播放的皮肤。<br>请先在"下载"面板抓取动皮。</li>';
    return;
  }
  const grid = skinView === "grid";
  skinListEl.classList.toggle("grid", grid);
  const side = document.getElementById("side");
  if (side) side.classList.toggle("grid-mode", grid);
  for (let i = 0; i < skinIds.length; i++) {
    const id = skinIds[i];
    const s = skinById(id);
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.dataset.i = i;
    b.title = skinTitle(id);
    if (s && !s.playable) b.classList.add("static-only");
    if (grid) {
      li.className = "grid-item";
      const img = document.createElement("img");
      img.loading = "lazy";
      img.alt = id;
      img.src = "/output/skins/" + id + "/static.png";
      img.onerror = () => { img.onerror = null; img.classList.add("missing"); };
      b.appendChild(img);
      const span = document.createElement("span");
      span.textContent = skinLabel(id);
      b.appendChild(span);
      if (s && !s.playable) {
        const tag = document.createElement("em");
        tag.className = "badge";
        tag.textContent = "静";
        b.appendChild(tag);
      }
    } else {
      const span = document.createElement("span");
      span.textContent = skinLabel(id);
      b.appendChild(span);
      if (s && !s.playable) {
        const tag = document.createElement("em");
        tag.className = "badge inline";
        tag.textContent = "静皮";
        b.appendChild(tag);
      }
    }
    b.addEventListener("click", () => loadSkin(parseInt(b.dataset.i, 10)));
    li.appendChild(b);
    skinListEl.appendChild(li);
  }
  highlightList();
}

function setSkinView(v) {
  if (v !== "grid" && v !== "list") return;
  skinView = v;
  document.getElementById("btnGrid").classList.toggle("active", v === "grid");
  document.getElementById("btnList").classList.toggle("active", v === "list");
  renderSkinList();
}

function setLabelMode(v) {
  if (v !== "name" && v !== "id") return;
  labelMode = v;
  try { localStorage.setItem("sgsLabelMode", v); } catch (e) {}
  const b = document.getElementById("btnLabel");
  if (b) {
    b.textContent = v === "name" ? "名称" : "ID";
    b.title = v === "name" ? "当前显示皮肤名，点击切换为文件夹 ID" : "当前显示文件夹 ID，点击切换为皮肤名";
    b.classList.toggle("active", v === "id");
  }
  renderSkinList();
}

function setSearch(text) {
  const t = text || "";
  if (t === searchText) return;
  searchText = t;
  applyFilter();
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
      autoAdvance(l);
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
document.getElementById("btnGrid").addEventListener("click", () => setSkinView("grid"));
document.getElementById("btnList").addEventListener("click", () => setSkinView("list"));
document.getElementById("btnLabel").addEventListener("click", () =>
  setLabelMode(labelMode === "name" ? "id" : "name"));
{
  const si = document.getElementById("skinSearch");
  if (si) {
    si.addEventListener("input", () => setSearch(si.value));
    si.addEventListener("keydown", e => {
      if (e.key === "Escape") { si.value = ""; setSearch(""); si.blur(); }
    });
  }
}
document.getElementById("btnStatic").addEventListener("click", () => setStaticOn(!staticOn));
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
  applyPlayMode();
});
document.getElementById("playModeSel").addEventListener("change", e => {
  playMode = e.target.value;
  applyPlayMode();
});
document.getElementById("btnShot").addEventListener("click", () => {
  const img = document.getElementById("staticImg");
  if (staticOn && img && img.complete && img.naturalWidth) {
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext("2d").drawImage(img, 0, 0);
    const a = document.createElement("a");
    a.download = "skin_" + (skinIds[cur] || "shot") + "_static.png";
    a.href = c.toDataURL("image/png");
    a.click();
    return;
  }
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

try {
  if (localStorage.getItem("sgsLabelMode") === "id") setLabelMode("id");
} catch (e) {}
resizeCanvas();
refreshSkins();