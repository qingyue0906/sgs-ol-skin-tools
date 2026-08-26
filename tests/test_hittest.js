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
const hitLayer = extract("hitLayer");
global.pointInTri = extract("pointInTri");
global.triBary = extract("triBary");
console.log("函数提取 OK");

const stubTex = {
  getImage: () => ({ width: 256, height: 256 }),
  setFilters: () => {}, setWraps: () => {}
};

function buildSkeleton(overlap) {
  const atlasText =
    "test.png\nsize:256,256\nformat:RGBA8888\nfilter:Linear,Linear\nrepeat:none\n" +
    "a\n  rotate:false\n  xy: 0, 0\n  size: 100, 100\n  orig: 100, 100\n  offset: 0, 0\n  index: -1\n" +
    "b\n  rotate:false\n  xy: 100, 0\n  size: 100, 100\n  orig: 100, 100\n  offset: 0, 0\n  index: -1\n";
  const atlas = new spine.TextureAtlas(atlasText);
  for (const p of atlas.pages) p.setTexture(stubTex);
  const loader = new spine.AtlasAttachmentLoader(atlas);
  const sd = new spine.SkeletonData();
  sd.name = "test";
  const bone = new spine.BoneData(0, "root", null);
  sd.bones.push(bone);
  const slot1 = new spine.SlotData(0, "slot1", bone);
  slot1.attachmentName = "rectA";
  const slot2 = new spine.SlotData(1, "slot2", bone);
  slot2.attachmentName = "rectB";
  sd.slots.push(slot1, slot2);
  const skin = new spine.Skin("default");
  let ra = loader.newRegionAttachment(skin, "rectA", "a", null);
  ra.x = -50; ra.y = 0; ra.width = 100; ra.height = 100; ra.updateRegion();
  skin.setAttachment(0, "rectA", ra);
  ra = loader.newRegionAttachment(skin, "rectB", "b", null);
  ra.x = overlap ? 0 : 50; ra.y = 0; ra.width = 100; ra.height = 100; ra.updateRegion();
  skin.setAttachment(1, "rectB", ra);
  sd.skins.push(skin);
  sd.defaultSkin = skin;
  const sk = new spine.Skeleton(sd);
  sk.setToSetupPose();
  try { sk.setSkinByName("default"); } catch (e) {}
  sk.updateWorldTransform();
  return { skeleton: sk, layer: { skeleton: sk, name: "test" } };
}

function centroidOf(att, slot) {
  const v = new Float32Array(8);
  att.computeWorldVertices(slot, v, 0, 2);
  return { x: (v[0] + v[2] + v[4] + v[6]) / 4, y: (v[1] + v[3] + v[5] + v[7]) / 4 };
}

let fail = 0;
const ok = (cond, msg) => { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) fail++; };

// ---- 合成测试：不重叠 ----
{
  const { skeleton, layer } = buildSkeleton(false);
  const a = skeleton.slots[0].getAttachment();
  const b = skeleton.slots[1].getAttachment();
  const ca = centroidOf(a, skeleton.slots[0]);
  const cb = centroidOf(b, skeleton.slots[1]);
  const ha = hitLayer(layer, ca.x, ca.y);
  const hb = hitLayer(layer, cb.x, cb.y);
  ok(ha && ha.slot === "slot1" && ha.att === "rectA", "A 质心命中自身 slot1/rectA");
  ok(hb && hb.slot === "slot2" && hb.att === "rectB", "B 质心命中自身 slot2/rectB");
  const hMid = hitLayer(layer, -25, 0);
  ok(hMid && hMid.slot === "slot1", "(-25,0) 命中 slot1");
  ok(hitLayer(layer, 9999, 9999) === null, "远处点未命中");
  // UV 插值: rectA 纹理 u∈[0,100/256], 世界 x∈[-100,0], (-25,0) -> u≈0.293, v≈0.1953(纵向中心)
  ok(hMid && Math.abs(hMid.u - 0.2930) < 0.02 && Math.abs(hMid.v - 0.1953) < 0.02,
    "UV 插值 u=" + (hMid ? hMid.u.toFixed(3) : "-") + " v=" + (hMid ? hMid.v.toFixed(3) : "-"));
  const hp = hitLayer(layer, 25, 0);
  ok(hp && hp.slot === "slot2", "(25,0) 命中 slot2");
}

// ---- 合成测试：重叠（B 盖在 A 上）----
{
  const { skeleton, layer } = buildSkeleton(true);
  const hit = hitLayer(layer, 0, 0);
  ok(hit && hit.slot === "slot2", "重叠区域命中最上层 slot2/rectB");
}

// ---- 真实皮肤冒烟：所有 region 质心至少命中一个槽位 ----
{
  const dir = "output/skins/74002";
  const atlas = new spine.TextureAtlas(fs.readFileSync(dir + "/daiji.atlas", "utf8"));
  for (const p of atlas.pages) {
    p.setTexture({ getImage: () => ({ width: 2048, height: 2048 }), setFilters: () => {}, setWraps: () => {} });
  }
  const data = new spine.SkeletonJson(new spine.AtlasAttachmentLoader(atlas))
    .readSkeletonData(fs.readFileSync(dir + "/daiji.json", "utf8"));
  const sk = new spine.Skeleton(data);
  sk.setToSetupPose();
  try { sk.setSkinByName("default"); } catch (e) {}
  const st = new spine.AnimationState(new spine.AnimationStateData(data));
  st.setAnimation(0, data.animations[0].name, true);
  st.update(1.2); st.apply(sk);
  sk.updateWorldTransform();
  const layer = { skeleton: sk, name: "daiji" };
  let tested = 0, passed = 0, uvBad = 0;
  for (const slot of sk.slots) {
    const att = slot.getAttachment();
    if (!att || !att.offset) continue;
    tested++;
    const c = centroidOf(att, slot);
    const hit = hitLayer(layer, c.x, c.y);
    if (hit) passed++;
    if (hit && (hit.u < 0 || hit.u > 1 || hit.v < 0 || hit.v > 1)) uvBad++;
  }
  ok(tested > 0 && passed === tested, "真实皮肤 region 质心均命中（" + passed + "/" + tested + "）");
  ok(uvBad === 0, "UV 无越界");
  const off = new spine.Vector2(), size = new spine.Vector2();
  sk.getBounds(off, size, new Array(2));
  ok(hitLayer(layer, off.x - 5000, off.y - 5000) === null, "远处未命中");
}

console.log(fail ? "结果: 失败 " + fail + " 项" : "结果: 全部成功");
process.exit(fail ? 1 : 0);