const fs = require("fs");
const path = require("path");
process.on("unhandledRejection", (e) => {
  console.log("未捕获异常: " + (e && e.message ? e.message : e));
  process.exit(1);
});
process.on("uncaughtException", (e) => {
  console.log("未捕获异常: " + (e && e.message ? e.message : e));
  process.exit(1);
});

const code = fs.readFileSync("web/spine-webgl.js", "utf8");
const spine = new Function(code + "; return spine;")();

function toLocal(p) {
  return p.replace("http://127.0.0.1:8123/", "").replace(/\//g, path.sep);
}

global.fetch = (url, opts) => {
  const local = toLocal(String(url));
  if (local.startsWith("output")) {
    try {
      const buf = fs.readFileSync(local);
      return Promise.resolve(new Response(buf, { status: 200 }));
    } catch (e) {
      return Promise.resolve(new Response("404", { status: 404 }));
    }
  }
  throw new Error("unexpected url: " + url);
};
global.XMLHttpRequest = class {
  constructor() { this.overrideMimeType = () => {}; }
  open(method, url) { this.url = url; }
  send() {
    global.fetch(this.url).then(r => r.text()).then(t => {
      this.status = 200; this.responseText = t;
      if (this.onload) this.onload();
    }).catch(() => { this.status = 0; if (this.onerror) this.onerror(); });
  }
};
global.createImageBitmap = async () => ({ width: 2048, height: 2048 });

const stubTex = {
  getImage: () => ({ width: 2048, height: 2048 }),
  setFilters: () => {},
  setWraps: () => {},
  dispose: () => {}
};

const BASE = "http://127.0.0.1:8123/";
const id = "74002";
const names = ["daiji", "beijing", "qianjing"];

const am = new spine.AssetManagerBase(() => stubTex, BASE);
let remaining = names.length * 2, failed = false, finished = false;
const oneDown = (isErr, tag) => {
  if (isErr) failed = true;
  console.log((isErr ? "[ERR] " : "[OK]  ") + tag);
  if (--remaining > 0) return;
  if (failed) { console.log("结果: 失败"); process.exit(1); }
  finished = true;
  try {
    for (const n of names) {
      const atlas = am.get("output/skins/" + id + "/" + n + ".atlas");
      const jsonText = am.get("output/skins/" + id + "/" + n + ".json");
      if (!atlas || !jsonText) throw new Error(n + " 资源缺失");
      if (!atlas.pages.length || !atlas.pages[0].texture) throw new Error(n + " 贴图未绑定");
      const sd = new spine.SkeletonJson(new spine.AtlasAttachmentLoader(atlas))
                   .readSkeletonData(jsonText);
      const sk = new spine.Skeleton(sd);
      sk.setToSetupPose();
      try { sk.setSkinByName("default"); } catch (e) {}
      const st = new spine.AnimationState(new spine.AnimationStateData(sd));
      const anims = sd.animations.map(a => a.name);
      st.setAnimation(0, anims[0], true);
      st.update(0.5); st.apply(sk); sk.updateWorldTransform();
      const off = new spine.Vector2(), size = new spine.Vector2();
      sk.getBounds(off, size, new Array(2));
      console.log(n + ": 骨骼=" + sd.bones.length + " 动画=" + anims.join(",") +
        " 边界=" + Math.round(size.x) + "x" + Math.round(size.y) + " OK");
    }
    am.dispose();
    console.log("结果: 全部成功（6/6 加载 + 3层渲染验证）");
    process.exit(0);
  } catch (e) {
    console.log("结果: 失败 - " + e.message);
    process.exit(1);
  }
};

for (const n of names) {
  am.loadTextureAtlas("output/skins/" + id + "/" + n + ".atlas",
    () => oneDown(false, n + ".atlas"), () => oneDown(true, n + ".atlas"));
  am.loadText("output/skins/" + id + "/" + n + ".json",
    () => oneDown(false, n + ".json"), () => oneDown(true, n + ".json"));
}
setTimeout(() => {
  if (!finished) { console.log("结果: 超时未完成, remaining=" + remaining); process.exit(1); }
}, 15000);