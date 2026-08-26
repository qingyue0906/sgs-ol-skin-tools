const fs = require("fs");
const code = fs.readFileSync("web/spine-webgl.js", "utf8");
const spine = new Function(code + "; return spine;")();
const dir = "output/skins/74002";
for (const n of ["daiji", "beijing", "qianjing"]) {
  const atlasText = fs.readFileSync(dir + "/" + n + ".atlas", "utf8");
  const stubTex = {
    getImage: () => ({ width: 2048, height: 2048 }),
    setFilters: () => {},
    setWraps: () => {}
  };
  const atlas = new spine.TextureAtlas(atlasText);
  for (const page of atlas.pages) page.setTexture(stubTex);
  const loader = new spine.AtlasAttachmentLoader(atlas);
  const json = new spine.SkeletonJson(loader);
  const data = json.readSkeletonData(fs.readFileSync(dir + "/" + n + ".json", "utf8"));
  const anims = data.animations.map((a) => a.name);
  console.log(n + ": spine格式版本=" + data.version + ", 骨骼数=" + data.bones.length +
    ", 槽位数=" + data.slots.length + ", 皮肤数=" + data.skins.length +
    ", 动画数=" + anims.length + ", 动画=" + anims.join(","));
  const sk = new spine.Skeleton(data);
  sk.setToSetupPose();
  try { sk.setSkinByName("default"); console.log(n + ": 皮肤default OK"); } catch (e) { console.log(n + ": 无default皮肤, 跳过"); }
  const st = new spine.AnimationState(new spine.AnimationStateData(data));
  st.setAnimation(0, anims[0], true);
  st.update(0.5); st.apply(sk);
  sk.updateWorldTransform();
  const off = new spine.Vector2(), size = new spine.Vector2();
  sk.getBounds(off, size, new Array(2));
  console.log(n + ": 动画[" + anims[0] + "] 渲染边界 OK: " +
    Math.round(size.x) + "x" + Math.round(size.y));
}
console.log("全部解析成功");