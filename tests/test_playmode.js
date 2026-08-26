const fs = require("fs");

const code = fs.readFileSync("web/spine-webgl.js", "utf8");
const spine = new Function(code + "; return spine;")();

const src = fs.readFileSync("web/player.js", "utf8");
function extract(fnName) {
  const re = new RegExp("function " + fnName + "\\([\\s\\S]*?\\n\\}");
  const m = src.match(re);
  if (!m) throw new Error(fnName + " not found");
  return new Function("spine", m[0] + "; return " + fnName + ";")("spine");
}
const animExists = extract("animExists");
const setLayerAnim = extract("setLayerAnim");
const applyPlayMode = extract("applyPlayMode");
const autoAdvance = extract("autoAdvance");
global.animExists = animExists;
global.setLayerAnim = setLayerAnim;
console.log("函数提取 OK");

let fail = 0;
const ok = (cond, msg) => { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) fail++; };

const stubTex = {
  getImage: () => ({ width: 2048, height: 2048 }),
  setFilters: () => {}, setWraps: () => {}
};
function loadSkinData(id, n) {
  const dir = "output/skins/" + id;
  const atlas = new spine.TextureAtlas(fs.readFileSync(dir + "/" + n + ".atlas", "utf8"));
  for (const p of atlas.pages) p.setTexture(stubTex);
  return new spine.SkeletonJson(new spine.AtlasAttachmentLoader(atlas))
    .readSkeletonData(fs.readFileSync(dir + "/" + n + ".json", "utf8"));
}

// 全局状态（player.js 中的模块变量）
global.layers = [];
global.playMode = "auto";
global.looping = true;

function makeLayer(name, sd) {
  const st = new spine.AnimationState(new spine.AnimationStateData(sd));
  const l = { name, state: st, animNames: sd.animations.map(a => a.name), curAnim: null, enabled: true };
  l.state.setAnimation(0, l.animNames[0], true);
  l.curAnim = l.animNames[0];
  global.layers.push(l);
  return l;
}

// ---- 四层型：74002 daiji（ChuChang, DaiJi）----
{
  global.layers = [];
  const sd = loadSkinData("74002", "daiji");
  const l = makeLayer("daiji", sd);
  ok(sd.animations.some(a => a.name === "ChuChang") && sd.animations.some(a => a.name === "DaiJi"),
    "74002 daiji 含 ChuChang/DaiJi");

  // auto：出场非循环
  global.playMode = "auto";
  applyPlayMode();
  let e = l.state.getCurrent(0);
  ok(e.animation.name === "ChuChang" && !e.loop, "auto 模式播出场（非循环）");

  // 播放完 → 自动切待机循环
  l.state.update(999);
  e = l.state.getCurrent(0);
  ok(e.trackTime >= e.animationEnd - 0.001, "trackTime 到达 animationEnd");
  autoAdvance(l);
  e = l.state.getCurrent(0);
  ok(e.animation.name === "DaiJi" && e.loop, "出场结束自动切待机循环");

  // 待机循环中 autoAdvance 不应再动
  autoAdvance(l);
  ok(l.state.getCurrent(0).animation.name === "DaiJi", "待机循环保持");

  // 全部出场（循环）
  global.playMode = "chu";
  applyPlayMode();
  e = l.state.getCurrent(0);
  ok(e.animation.name === "ChuChang" && e.loop, "全部出场：ChuChang 循环");

  // 全部待机（循环）
  global.playMode = "daiji";
  applyPlayMode();
  e = l.state.getCurrent(0);
  ok(e.animation.name === "DaiJi" && e.loop, "全部待机：DaiJi 循环");

  // 循环关闭时：待机播完停在末帧
  global.playMode = "auto";
  global.looping = false;
  applyPlayMode();
  l.state.update(999);
  autoAdvance(l);
  ok(l.state.getCurrent(0).animation.name === "DaiJi", "循环关闭仍切待机");
  l.state.update(999);
  autoAdvance(l);
  ok(l.state.getCurrent(0).animation.name === "DaiJi" && !l.state.getCurrent(0).loop,
    "待机播完停在末帧（不重播）");
  global.looping = true;
}

// ---- 单动画层：39003 beijing（只有 play）----
{
  global.layers = [];
  const sd = loadSkinData("39003", "beijing");
  const l = makeLayer("beijing", sd);
  ok(l.animNames.length === 1 && l.animNames[0] === "play", "39003 beijing 只有 play");

  global.playMode = "auto";
  applyPlayMode();
  let e = l.state.getCurrent(0);
  ok(e.animation.name === "play", "无 ChuChang 的层保持不动（auto）");
  l.state.update(999);
  autoAdvance(l);
  ok(l.state.getCurrent(0).animation.name === "play", "autoAdvance 后仍保持");

  global.playMode = "chu";
  applyPlayMode();
  ok(l.state.getCurrent(0).animation.name === "play", "无 ChuChang 的层保持不动（全部出场）");
  global.playMode = "daiji";
  applyPlayMode();
  ok(l.state.getCurrent(0).animation.name === "play", "无 DaiJi 的层保持不动（全部待机）");
}

// ---- 形象层（GongJi/JiNeng/HuDong，无 ChuChang/DaiJi）----
{
  global.layers = [];
  const sd = loadSkinData("74002", "xingxiang");
  const l = makeLayer("xingxiang", sd);
  ok(!l.animNames.includes("ChuChang") && !l.animNames.includes("DaiJi"), "形象无出场/待机动画");

  global.playMode = "auto";
  applyPlayMode();
  const before = l.state.getCurrent(0).animation.name;
  ok(before === l.animNames[0], "形象保持当前动画（auto）");
  global.playMode = "chu";
  applyPlayMode();
  global.playMode = "daiji";
  applyPlayMode();
  ok(l.state.getCurrent(0).animation.name === before, "形象全程保持不动");
}

console.log(fail ? "结果: 失败 " + fail + " 项" : "结果: 全部成功");
process.exit(fail ? 1 : 0);