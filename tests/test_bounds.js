const fs = require("fs");
const path = require("path");
const code = fs.readFileSync("web/spine-webgl.js", "utf8");
const spine = new Function(code + "; return spine;")();

const html = fs.readFileSync("web/player.js", "utf8");
const m = html.match(/function computeLayerBounds\(l\) \{[\s\S]*?\n\}/);
if (!m) { console.log("computeLayerBounds not found"); process.exit(1); }
const fn = new Function("spine", m[0] + "; return computeLayerBounds;");
const computeBounds = fn(spine);

const stubTex = {
  getImage: () => ({ width: 2048, height: 2048 }),
  setFilters: () => {},
  setWraps: () => {}
};

const dir = "output/skins/74002";
let union = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
for (const n of ["beijing", "daiji", "qianjing"]) {
  const atlas = new spine.TextureAtlas(fs.readFileSync(dir + "/" + n + ".atlas", "utf8"));
  for (const page of atlas.pages) page.setTexture(stubTex);
  const loader = new spine.AtlasAttachmentLoader(atlas);
  const sd = new spine.SkeletonJson(loader)
    .readSkeletonData(fs.readFileSync(dir + "/" + n + ".json", "utf8"));
  const layer = { skeletonData: sd, curAnim: sd.animations.length ? sd.animations[0].name : null, bounds: null };
  const t0 = Date.now();
  computeBounds(layer);
  console.log(n + ": 动画=" + layer.curAnim + " 时长=" + (sd.animations[0] ? sd.animations[0].duration.toFixed(2) : "-") +
    "s bounds=[" + [layer.bounds.minX, layer.bounds.minY, layer.bounds.maxX, layer.bounds.maxY].map(v => Math.round(v)).join(",") +
    "] 耗时=" + (Date.now() - t0) + "ms");
  union.minX = Math.min(union.minX, layer.bounds.minX);
  union.minY = Math.min(union.minY, layer.bounds.minY);
  union.maxX = Math.max(union.maxX, layer.bounds.maxX);
  union.maxY = Math.max(union.maxY, layer.bounds.maxY);
}

const w = union.maxX - union.minX, h = union.maxY - union.minY;
console.log("三层并集: " + Math.round(w) + "x" + Math.round(h));

function checkZoom(viewportW, viewportH) {
  const zoom = 1 / (Math.min(viewportW / w, viewportH / h) * 0.94);
  const visibleW = zoom * viewportW, visibleH = zoom * viewportH;
  const dispW = viewportW * w / visibleW, dispH = viewportH * h / visibleH;
  console.log("窗口 " + viewportW + "x" + viewportH + ": 皮肤显示 " + Math.round(dispW) + "x" + Math.round(dispH) +
    " 像素（占宽 " + (dispW / viewportW * 100).toFixed(1) + "%）");
}

checkZoom(1920, 1080);
checkZoom(800, 600);
checkZoom(3840, 2160);
console.log("TEST DONE");