window.__E3 = [];
window.addEventListener('error', (e) => window.__E3.push(e.message + ' :' + e.lineno));
window.addEventListener('load', () => {
  setTimeout(run3DTest, 500);
});
async function run3DTest() {
  const log = [];
  const T = (n, ok, x) => log.push((ok ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? ' | ' + x : ''));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms || 150));
  const origCap = Element.prototype.setPointerCapture;
  Element.prototype.setPointerCapture = function (id) {
    try {
      origCap.call(this, id);
    } catch (e) {}
  };
  try {
    try {
      localStorage.removeItem(ITEMS_KEY);
    } catch (e) {}
    state.items = [];
    save = () => {};
    // S13：测试台不得带个人布局（build.mjs 把 plan.layout 剥成 null）——
    // 否则同一套脚本在 mine 与 generic 上起点不同，plan-independence 就被破坏。
    T(
      's13-bench-layout-stripped',
      !(PLAN.layout && (PLAN.layout.items || []).length) && state.items.length === 0,
      'PLAN.layout=' + JSON.stringify(PLAN.layout) + ' items=' + state.items.length
    );
    const _fb = floorPts(),
      _xs = _fb.map((p) => p[0]),
      _ys = _fb.map((p) => p[1]);
    const CX3 = (Math.min(..._xs) + Math.max(..._xs)) / 2,
      CY3 = (Math.min(..._ys) + Math.max(..._ys)) / 2;
    const TP1 = [CX3, CY3 + 2],
      TP2 = [CX3 - 2, CY3 - 1]; // floorPts 中心派生（plan-independent）
    const arm = CATALOG.find((c) => c.model === 'saltsjobaden');
    state.items.push({ uid: uidSeq++, ref: arm.id, x: CX3, y: CY3 + 1, rot: 0 });
    const cl = CATALOG.find((c) => c.id === 'cl-flush');
    state.items.push({ uid: uidSeq++, ref: cl.id, x: CX3, y: CY3 - 3, rot: 0 });
    refresh();
    setView('3d');
    await wait(3000);
    setCamMode('doll');
    three.controls.target.set(CX3, 1, CY3);
    three.cam.position.set(CX3, 14, CY3 + 14);
    three.cam.fov = 45;
    three.cam.updateProjectionMatrix();
    three.controls.update();
    await wait(400);
    const cv = document.querySelector('#c3d'),
      r = cv.getBoundingClientRect();
    const it = state.items[0],
      lamp = state.items[1];
    const proj = (x, y, z) => {
      three.cam.updateMatrixWorld(true);
      const v = new THREE.Vector3(x, y, z).project(three.cam);
      return [r.left + (v.x * 0.5 + 0.5) * r.width, r.top + (-v.y * 0.5 + 0.5) * r.height];
    };
    const PE = (t, x, y, o) =>
      cv.dispatchEvent(
        new PointerEvent(
          t,
          Object.assign(
            {
              bubbles: true,
              cancelable: true,
              clientX: x,
              clientY: y,
              pointerId: 1,
              pointerType: 'mouse',
              button: 0,
              buttons: 1,
              isPrimary: true,
            },
            o || {}
          )
        )
      );
    const uidAt = (x, y) => (pickFurniture({ clientX: x, clientY: y }) || {}).uid;

    let [ax, ay] = proj(it.x, 1.2, it.y);
    T('3d-pick-furniture', uidAt(ax, ay) === it.uid, 'uid=' + uidAt(ax, ay));

    const camP0 = three.cam.position.clone(),
      x0 = it.x,
      y0 = it.y;
    PE('pointerdown', ax, ay);
    await wait(80);
    T('3d-drag-takes-over-camera', three.dragging3D === true && three.controls.enabled === false);
    PE('pointermove', ax + 90, ay + 40);
    await wait(80);
    PE('pointerup', ax + 90, ay + 40);
    await wait(150);
    T(
      '3d-drag-moves-item',
      Math.hypot(it.x - x0, it.y - y0) > 0.5,
      'd=' + Math.hypot(it.x - x0, it.y - y0).toFixed(2) + 'ft'
    );
    T('3d-drag-camera-unmoved', three.cam.position.distanceTo(camP0) < 1e-6);
    T('3d-drag-restores-controls', three.controls.enabled === true && three.dragging3D === false);
    T('3d-drag-selects', selected === it.uid);

    // 拖完立刻再拾取：matrixWorld 必须已刷新（r147 Raycaster 不会自己更新）
    let [bx, by] = proj(it.x, 1.2, it.y);
    T('3d-pick-after-move', uidAt(bx, by) === it.uid, 'uid=' + uidAt(bx, by));

    // 吸顶灯压在家具正上方时，应优先拾取家具
    lamp.x = it.x;
    lamp.y = it.y;
    drawFurniture();
    await wait(150);
    [bx, by] = proj(it.x, 1.2, it.y);
    T('3d-pick-prefers-furniture-over-light', uidAt(bx, by) === it.uid, 'uid=' + uidAt(bx, by));

    // Shift 拖动 = 原地旋转（位置不得改变）
    const rot0 = it.rot || 0,
      px0 = it.x,
      py0 = it.y;
    PE('pointerdown', bx, by, { shiftKey: true });
    await wait(80);
    PE('pointermove', bx + 80, by, { shiftKey: true });
    await wait(80);
    PE('pointerup', bx + 80, by, { shiftKey: true });
    await wait(120);
    T(
      '3d-shift-drag-rotates',
      Math.abs(it.rot - rot0) > 10 && Math.hypot(it.x - px0, it.y - py0) < 0.01,
      'drot=' + (it.rot - rot0).toFixed(1) + '° dpos=' + Math.hypot(it.x - px0, it.y - py0).toFixed(3)
    );

    /* ===== v3.3 新增件：卫生间镜子 / Lunix 沙发 / Honeywell 落地灯 ===== */
    // 镜子数量随户型（mine 3 面 / generic 1 面）→ 断言「投影里有、且 3D 建的数量与投影一致」，不写死
    const nMir = FX.filter((f) => f.t === 'mirror').length;
    T('mirror-in-fx', nMir >= 1, nMir + ' 面镜子（户型自带洁具，数量随户型）');
    T(
      'mirror-3d-built',
      !!three.mirrors && three.mirrors.length === nMir,
      (three.mirrors ? three.mirrors.length : 0) + ' 面进了 3D / 投影 ' + nMir + ' 面'
    );
    if (three.mirrors && three.mirrors.length) {
      const mm = three.mirrors[0].material;
      T(
        'mirror-is-reflective',
        mm.metalness >= 0.95 && mm.roughness <= 0.05,
        'metal=' + mm.metalness + ' rough=' + mm.roughness
      );
      T('mirror-has-env', !!mm.envMap, mm.envMap ? '已烘立方体贴图' : '退回环境贴图');
    }
    const lun = CATALOG.find((c) => c.id === 'lunix-0');
    T(
      'lunix-in-catalog',
      !!lun && CATALOG.filter((c) => c.model === 'lunix').length === 4,
      CATALOG.filter((c) => c.model === 'lunix').length + ' 个配色'
    );
    // 14 块全建：沙发本体 + 散在旁边的 6 块配件，声明的占地必须把它们都框住，
    // 而且不能虚报（填充率太低说明尺寸写大了）
    const lunFit = (() => {
      const g = furn3D({ uid: -11, ref: lun.id, x: 0, y: 0, rot: 0 }, lun);
      g.updateMatrixWorld(true);
      const b = new THREE.Box3().setFromObject(g);
      const sz = new THREE.Vector3(),
        ct = new THREE.Vector3();
      b.getSize(sz);
      b.getCenter(ct);
      disposeOwned(g);
      return { sz, ct, fx: sz.x / cm2ft(lun.w), fz: sz.z / cm2ft(lun.d), fy: sz.y / cm2ft(lun.h), minY: b.min.y };
    })();
    T(
      'lunix-fits-footprint',
      lunFit.fx <= 1.02 && lunFit.fz <= 1.02 && lunFit.fy <= 1.02,
      '填充率 ' +
        [lunFit.fx, lunFit.fz, lunFit.fy].map((v) => (v * 100).toFixed(0) + '%').join('/') +
        '（声明 ' +
        lun.w +
        '×' +
        lun.d +
        '×' +
        lun.h +
        'cm）'
    );
    T(
      'lunix-footprint-not-inflated',
      lunFit.fx >= 0.92 && lunFit.fz >= 0.92,
      '不能虚报占地：' + [lunFit.fx, lunFit.fz].map((v) => (v * 100).toFixed(0) + '%').join('/')
    );
    T(
      'lunix-centered',
      Math.abs(lunFit.ct.x) < 0.03 && Math.abs(lunFit.ct.z) < 0.03,
      '水平重心 (' + lunFit.ct.x.toFixed(2) + ', ' + lunFit.ct.z.toFixed(2) + ')'
    );
    T('lunix-on-floor', lunFit.minY > -0.02, '最低点 y=' + lunFit.minY.toFixed(3) + '（不能沉到地板以下）');
    // SC172 电动功能沙发（Costco，CA-only）：填充率/头枕顶高/左扶手面板/座下可见底座
    const sc172 = CATALOG.find((c) => c.id === 'sc172-0');
    T(
      'sc172-in-catalog',
      !!sc172 &&
        sc172.model === 'sc172' &&
        CATALOG.filter((c) => c.model === 'sc172').length === 1 &&
        sc172.priceCA == 1399.99 &&
        sc172.price == null &&
        !sc172.caNA,
      'CA$1399.99 · 无美价 · 单色'
    );
    const scFit = (() => {
      const g = furn3D({ uid: -114, ref: sc172.id, x: 0, y: 0, rot: 0 }, sc172);
      g.updateMatrixWorld(true);
      const b = new THREE.Box3().setFromObject(g);
      const sz = new THREE.Vector3(),
        ct = new THREE.Vector3();
      b.getSize(sz);
      b.getCenter(ct);
      // 按真实顶点找材质盒（合并后 mesh 的 bbox 可能过估，这里逐顶点算，同 lunix 口径）
      const mats = {};
      g.traverse((o) => {
        if (o.isMesh && o.geometry && o.material) {
          const key = '0x' + o.material.color.getHexString();
          const a = mats[key] || (mats[key] = { x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9, z0: 1e9, z1: -1e9, n: 0 });
          const pos = o.geometry.attributes.position,
            v = new THREE.Vector3();
          for (let i = 0; i < pos.count; i++) {
            v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
            if (v.x < a.x0) a.x0 = v.x;
            if (v.x > a.x1) a.x1 = v.x;
            if (v.y < a.y0) a.y0 = v.y;
            if (v.y > a.y1) a.y1 = v.y;
            if (v.z < a.z0) a.z0 = v.z;
            if (v.z > a.z1) a.z1 = v.z;
            a.n++;
          }
        }
      });
      disposeOwned(g);
      return {
        sz,
        ct,
        b,
        fx: sz.x / cm2ft(sc172.w),
        fz: sz.z / cm2ft(sc172.d),
        fy: sz.y / cm2ft(sc172.h),
        minY: b.min.y,
        mats,
      };
    })();
    T(
      'sc172-fits-footprint',
      scFit.fx >= 0.92 &&
        scFit.fx <= 1.02 &&
        scFit.fz >= 0.92 &&
        scFit.fz <= 1.02 &&
        scFit.fy >= 0.92 &&
        scFit.fy <= 1.02,
      '填充率 ' +
        [scFit.fx, scFit.fz, scFit.fy].map((v) => (v * 100).toFixed(0) + '%').join('/') +
        '（声明 ' +
        sc172.w +
        '×' +
        sc172.d +
        '×' +
        sc172.h +
        'cm）'
    );
    T(
      'sc172-centered',
      Math.abs(scFit.ct.x) < 0.03 && Math.abs(scFit.ct.z) < 0.03,
      '水平重心 (' + scFit.ct.x.toFixed(2) + ', ' + scFit.ct.z.toFixed(2) + ')'
    );
    T('sc172-on-floor', scFit.minY > -0.02, '最低点 y=' + scFit.minY.toFixed(3));
    // 头枕是最高件：顶高必须命中官方总高 104.8（不是扶手、不是背板）
    T(
      'sc172-headrest-top',
      scFit.fy >= 0.995 && scFit.fy <= 1.015,
      'y 顶=' + (scFit.fy * sc172.h).toFixed(1) + 'cm（官方 H104.8，头枕顶）'
    );
    // 香槟金控制面板在左扶手外侧（-x）：金板凸出扶手外缘 + 4 枚按钮（黑）
    const gold = scFit.mats['0x8a8272'],
      btn = scFit.mats['0x4a463e'];
    const halfWft = cm2ft(sc172.w) / 2;
    T(
      'sc172-panel-on-left-arm',
      !!gold &&
        gold.x0 < -halfWft &&
        gold.x1 > -halfWft - cm2ft(2) &&
        gold.y0 * 30.48 > 48 &&
        gold.y1 * 30.48 < 62 &&
        btn &&
        btn.n > 0,
      '金板 x[' +
        (gold ? gold.x0 * 30.48 : '?').toFixed(1) +
        ',' +
        (gold ? gold.x1 * 30.48 : '?').toFixed(1) +
        ']cm（扶手外缘 ' +
        (halfWft * 30.48).toFixed(1) +
        '）· 按钮网格 ' +
        (btn ? btn.n : 0) +
        ' 顶点'
    );
    // 底座：脚贴地，全部底座件（含中央机构盒）都在座底（34cm）之下
    const base = scFit.mats['0x17181a'];
    T(
      'sc172-base-visible',
      !!base && base.y0 > -0.02 && base.y0 < 0.5 && base.y1 * 30.48 < 17 && base.z0 * 30.48 < -22,
      '底座 y[' +
        (base ? base.y0 * 30.48 : 0).toFixed(1) +
        ',' +
        (base ? base.y1 * 30.48 : 0).toFixed(1) +
        ']cm · 后沿 z=' +
        (base ? base.z0 * 30.48 : 0).toFixed(1) +
        'cm（座底 34 之下）'
    );
    // Aldryn 电动躺椅（Costco，US-only）：填充率 / 收合脚踏带在前缘 / 控制面板在左扶手外
    const aldrin = CATALOG.find((c) => c.id === 'aldryn-0');
    T(
      'aldryn-in-catalog',
      !!aldrin &&
        aldrin.model === 'aldryn' &&
        aldrin.kind === 'recliner' &&
        aldrin.price == 599.99 &&
        aldrin.priceCA == null &&
        aldrin.caNA === true,
      'US$599.99 · 加拿大无售 · kind=recliner'
    );
    const adFit = (() => {
      const g = furn3D({ uid: -115, ref: aldrin.id, x: 0, y: 0, rot: 0 }, aldrin);
      g.updateMatrixWorld(true);
      const b = new THREE.Box3().setFromObject(g);
      const sz = new THREE.Vector3(),
        ct = new THREE.Vector3();
      b.getSize(sz);
      b.getCenter(ct);
      const mats = {};
      g.traverse((o) => {
        if (o.isMesh && o.geometry && o.material) {
          const key = '0x' + o.material.color.getHexString();
          const a = mats[key] || (mats[key] = { x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9, z0: 1e9, z1: -1e9, n: 0 });
          const pos = o.geometry.attributes.position,
            v = new THREE.Vector3();
          for (let i = 0; i < pos.count; i++) {
            v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
            if (v.x < a.x0) a.x0 = v.x;
            if (v.x > a.x1) a.x1 = v.x;
            if (v.y < a.y0) a.y0 = v.y;
            if (v.y > a.y1) a.y1 = v.y;
            if (v.z < a.z0) a.z0 = v.z;
            if (v.z > a.z1) a.z1 = v.z;
            a.n++;
          }
        }
      });
      disposeOwned(g);
      return {
        sz,
        ct,
        b,
        fx: sz.x / cm2ft(aldrin.w),
        fz: sz.z / cm2ft(aldrin.d),
        fy: sz.y / cm2ft(aldrin.h),
        minY: b.min.y,
        mats,
      };
    })();
    T(
      'aldryn-fits-footprint',
      adFit.fx >= 0.92 &&
        adFit.fx <= 1.02 &&
        adFit.fz >= 0.92 &&
        adFit.fz <= 1.02 &&
        adFit.fy >= 0.92 &&
        adFit.fy <= 1.02,
      '填充率 ' +
        [adFit.fx, adFit.fz, adFit.fy].map((v) => (v * 100).toFixed(0) + '%').join('/') +
        '（声明 ' +
        aldrin.w +
        '×' +
        aldrin.d +
        '×' +
        aldrin.h +
        'cm）'
    );
    T(
      'aldryn-centered',
      Math.abs(adFit.ct.x) < 0.03 && Math.abs(adFit.ct.z) < 0.03,
      '水平重心 (' + adFit.ct.x.toFixed(2) + ', ' + adFit.ct.z.toFixed(2) + ')'
    );
    T('aldryn-on-floor', adFit.minY > -0.02, '最低点 y=' + adFit.minY.toFixed(3));
    // 收合脚踏带：两扶手之间（|x|<座半宽）且前缘 10cm 内的皮面必须落在座面（48.8cm）以下
    const halfD2 = cm2ft(aldrin.d) / 2,
      halfW2 = cm2ft(aldrin.w) / 2;
    const band = (() => {
      const a = { x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9, z0: 1e9, z1: -1e9, n: 0 };
      const g = furn3D({ uid: -116, ref: aldrin.id, x: 0, y: 0, rot: 0 }, aldrin);
      g.updateMatrixWorld(true);
      const v = new THREE.Vector3();
      g.traverse((o) => {
        if (!o.isMesh || !o.geometry) return;
        const pos = o.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
          // 脚踏带区：带中部高度（座面以下、两扶手之间、前缘 15cm 内）
          if (v.y < cm2ft(10) || v.y > cm2ft(36) || v.z < halfD2 - cm2ft(15) || Math.abs(v.x) > halfW2 - cm2ft(20))
            continue;
          if (v.x < a.x0) a.x0 = v.x;
          if (v.x > a.x1) a.x1 = v.x;
          if (v.y < a.y0) a.y0 = v.y;
          if (v.y > a.y1) a.y1 = v.y;
          if (v.z < a.z0) a.z0 = v.z;
          if (v.z > a.z1) a.z1 = v.z;
          a.n++;
        }
      });
      disposeOwned(g);
      return a;
    })();
    // 脚踏带 = 两圆鼓叠层：前面比壳前缘退约 3cm（bandFront），顶在座面以下
    T(
      'aldryn-front-band-at-front',
      band.n > 0 && band.y1 * 30.48 < 36.5 && band.z1 > halfD2 - cm2ft(4) && band.z1 < halfD2 - cm2ft(2),
      '前带 z[' +
        (band.n ? (band.z0 * 30.48).toFixed(1) : '?') +
        ',' +
        (band.n ? (band.z1 * 30.48).toFixed(1) : '?') +
        ']cm（前缘平面 ' +
        (halfD2 * 30.48).toFixed(1) +
        '，带前面应退约 3）· y[' +
        (band.n ? (band.y0 * 30.48).toFixed(1) : '?') +
        ',' +
        (band.n ? (band.y1 * 30.48).toFixed(1) : '?') +
        ']cm（座面 48.8）'
    );
    // 背垫后倾 12°：顶部（y>90cm）必须命中官方总高，且后缘落在座背平面之后 ≥30cm
    const top = (() => {
      const a = { z0: 1e9, z1: -1e9, y0: 1e9, y1: -1e9, n: 0 };
      const g = furn3D({ uid: -117, ref: aldrin.id, x: 0, y: 0, rot: 0 }, aldrin);
      g.updateMatrixWorld(true);
      const v = new THREE.Vector3();
      g.traverse((o) => {
        if (!o.isMesh || !o.geometry) return;
        const pos = o.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
          if (v.y < cm2ft(90)) continue;
          if (v.z < a.z0) a.z0 = v.z;
          if (v.z > a.z1) a.z1 = v.z;
          if (v.y < a.y0) a.y0 = v.y;
          if (v.y > a.y1) a.y1 = v.y;
          a.n++;
        }
      });
      disposeOwned(g);
      return a;
    })();
    T(
      'aldryn-back-lean-reaches-depth',
      top.n > 0 && top.y1 * 30.48 > 99.5 && top.z0 < -cm2ft(30),
      '顶部皮面顶 y=' +
        (top.n ? (top.y1 * 30.48).toFixed(1) : '?') +
        'cm（声明 100.8）· 后缘 z=' +
        (top.n ? (top.z0 * 30.48).toFixed(1) : '?') +
        'cm（座背平面约 -29.5，应再往后）'
    );
    // 控制面板在左扶手外侧面（-x），与扶手外面齐平（不超出官方宽）
    const plate = adFit.mats['0x4e4a48'];
    T(
      'aldryn-panel-on-left-arm',
      !!plate &&
        plate.x0 < -halfW2 + cm2ft(1.5) &&
        plate.x1 > -halfW2 - cm2ft(1.5) &&
        plate.y0 * 30.48 > 35 &&
        plate.y1 * 30.48 < 50 &&
        plate.z1 > halfD2 - cm2ft(20),
      '面板 x[' +
        (plate ? (plate.x0 * 30.48).toFixed(1) : '?') +
        ',' +
        (plate ? (plate.x1 * 30.48).toFixed(1) : '?') +
        ']cm（扶手外缘 ' +
        (halfW2 * 30.48).toFixed(1) +
        '）· y[' +
        (plate ? (plate.y0 * 30.48).toFixed(1) : '?') +
        ',' +
        (plate ? (plate.y1 * 30.48).toFixed(1) : '?') +
        ']cm'
    );
    // Henredon Murphy 桶形旋转椅（bouclé）：Cream/Gray 共用 model，木底座、向下收窄、waterfall 顶边
    const mp = CATALOG.find((c) => c.id === 'murphy-0'),
      mp1 = CATALOG.find((c) => c.id === 'murphy-1');
    T(
      'murphy-in-catalog',
      !!mp &&
        !!mp1 &&
        mp.model === mp1.model &&
        mp.kind === 'tubChair' &&
        mp.price == 299.99 &&
        mp.priceCA == 449.99 &&
        !!mp.caVar &&
        mp.color !== mp1.color,
      'Cream ' + (mp ? mp.color : '?') + ' / Gray ' + (mp1 ? mp1.color : '?') + ' 共用 model=murphy'
    );
    const mpFit = (() => {
      const sp = mp,
        g = furn3D({ uid: -1, ref: sp.id, x: 0, y: 0, rot: 0 }, sp);
      g.updateMatrixWorld(true);
      const bb = new THREE.Box3(),
        v = new THREE.Vector3(),
        mats = {};
      g.traverse((o) => {
        if (o.isMesh && o.geometry) {
          const key = o.material.color.getHexString();
          const m = mats[key] || (mats[key] = { x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9, z0: 1e9, z1: -1e9 });
          const p = o.geometry.attributes.position;
          for (let i = 0; i < p.count; i++) {
            v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
            bb.expandByPoint(v);
            m.x0 = Math.min(m.x0, v.x);
            m.x1 = Math.max(m.x1, v.x);
            m.y0 = Math.min(m.y0, v.y);
            m.y1 = Math.max(m.y1, v.y);
            m.z0 = Math.min(m.z0, v.z);
            m.z1 = Math.max(m.z1, v.z);
          }
        }
      });
      return { bb, mats };
    })();
    const mpSz = new THREE.Vector3();
    mpFit.bb.getSize(mpSz);
    T(
      'murphy-fits-footprint',
      mpSz.x / cm2ft(mp.w) > 0.92 &&
        mpSz.x / cm2ft(mp.w) < 1.02 &&
        mpSz.z / cm2ft(mp.d) > 0.92 &&
        mpSz.z / cm2ft(mp.d) < 1.02 &&
        mpSz.y / cm2ft(mp.h) > 0.92 &&
        mpSz.y / cm2ft(mp.h) < 1.02,
      'w ' +
        mpSz.x * 30.48 +
        ' / d ' +
        mpSz.z * 30.48 +
        ' / h ' +
        mpSz.y * 30.48 +
        ' vs ' +
        mp.w +
        '/' +
        mp.d +
        '/' +
        mp.h
    );
    const mpC = new THREE.Vector3();
    mpFit.bb.getCenter(mpC);
    T(
      'murphy-centered',
      Math.abs(mpC.x) < 0.02 && Math.abs(mpC.z) < 0.02,
      'center ' + mpC.x.toFixed(3) + ',' + mpC.z.toFixed(3)
    );
    T('murphy-on-floor', mpFit.bb.min.y > -0.02, 'min y ' + mpFit.bb.min.y);
    const wood = mpFit.mats['8b6a45'];
    T(
      'murphy-wood-pedestal',
      !!wood &&
        wood.y0 * 30.48 < 0.6 &&
        wood.y1 * 30.48 > 8 &&
        wood.y1 * 30.48 < 10 &&
        (wood.x1 - wood.x0) * 30.48 > 47 &&
        (wood.x1 - wood.x0) * 30.48 < 52,
      '底座 y[' +
        (wood ? wood.y0 * 30.48 : 0) +
        ',' +
        (wood ? wood.y1 * 30.48 : 0) +
        ']cm 宽 ' +
        (wood ? ((wood.x1 - wood.x0) * 30.48).toFixed(1) : 0) +
        'cm（g6 木盘带 134px/15.24 = 8.8cm 高 · Ø50.2）'
    );
    const mHalfW2 = cm2ft(mp.w) / 2,
      mHalfD2 = cm2ft(mp.d) / 2;
    // 外壳向下收窄：量「最后端 z」而不是宽度 —— 顶边 waterfall 之后，高处的宽度被顶边高度限制，
    // 量宽度会把 taper 和 waterfall 混在一起。最后端 z 只由 taper 决定（θ=0 处）。
    const regBack = (ylo, yhi) => {
      let mn = 1e9;
      const g2 = furn3D({ uid: -2, ref: mp.id, x: 0, y: 0, rot: 0 }, mp);
      g2.updateMatrixWorld(true);
      const v = new THREE.Vector3();
      g2.traverse((o) => {
        if (o.isMesh && o.geometry) {
          const p = o.geometry.attributes.position;
          for (let i = 0; i < p.count; i++) {
            v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
            if (v.y * 30.48 > ylo && v.y * 30.48 < yhi && v.z < 0) mn = Math.min(mn, v.z * 30.48);
          }
        }
      });
      return -mn;
    };
    const dTop = regBack(72, 76),
      dLow = regBack(8.5, 9.5); // 外壳底环就在 pedH=8.8 上，窗口必须含它
    T(
      'murphy-shell-tapers',
      dTop > dLow * 1.15 && dTop < dLow * 1.45,
      '背壳最后端 z：顶 ' + dTop.toFixed(1) + 'cm vs 底 ' + dLow.toFixed(1) + 'cm（拟合 k=0.22 p=1.48 → 37.5 vs 30.6）'
    );
    const g3 = furn3D({ uid: -3, ref: mp.id, x: 0, y: 0, rot: 0 }, mp);
    g3.updateMatrixWorld(true);
    let backTop = -1e9,
      armTop = -1e9,
      frontTop = -1e9,
      seatTop = -1e9,
      ffZ = -1e9,
      ffY0 = 1e9,
      ffY1 = -1e9;
    const v3 = new THREE.Vector3();
    g3.traverse((o) => {
      if (o.isMesh && o.geometry) {
        const p = o.geometry.attributes.position;
        for (let i = 0; i < p.count; i++) {
          v3.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
          const y = v3.y * 30.48,
            z = v3.z * 30.48;
          if (y > 12) {
            if (v3.z < -mHalfD2 * 0.5) backTop = Math.max(backTop, y);
            if (v3.z > mHalfD2 * 0.5) frontTop = Math.max(frontTop, y);
          }
          if (z > 5 && Math.abs(v3.x) > mHalfW2 * 0.85) armTop = Math.max(armTop, y); // 扶手端（θ≈±100..112°）
          if (z > mHalfD2 * 30.48 - 2) {
            ffZ = Math.max(ffZ, z);
            ffY0 = Math.min(ffY0, y);
            ffY1 = Math.max(ffY1, y);
          }
          if (y > 44 && y < 52 && v3.z > 0) seatTop = Math.max(seatTop, y);
        }
      }
    });
    T(
      'murphy-waterfall-top',
      backTop > armTop + 6 && backTop > 74 && backTop < 77 && armTop > 60 && armTop < 70,
      '顶边 waterfall：背 ' + backTop.toFixed(1) + 'cm → 扶手端 ' + armTop.toFixed(1) + 'cm（官方 H 76.46 / 扶手 64.0）'
    );
    T('murphy-open-front', frontTop < 52, '前口最高 ' + frontTop.toFixed(1) + 'cm —— 外壳是马蹄形不闭合，前口只有座垫');
    T(
      'murphy-cushion-protrudes',
      ffZ > mHalfD2 * 30.48 - 2 && ffY0 < 13 && ffY1 > 40,
      '座垫前立面 z=' +
        ffZ.toFixed(1) +
        'cm（足迹最前 ' +
        (mHalfD2 * 30.48).toFixed(1) +
        '）· 高 ' +
        ffY0.toFixed(1) +
        '→' +
        ffY1.toFixed(1) +
        'cm'
    );
    T('murphy-seat-surface', seatTop > 45 && seatTop < 51, '座面最高 ' + seatTop.toFixed(1) + 'cm（官方座高 48.0）');
    // 遮挡：从 45° 仰角前左方向向「应当被座垫盖住的点」（木盘顶面中心）打射线。
    // Raycaster 按 material.side 跳过背面，所以法线朝内（被剔除）时这条会打穿座垫命中木。
    // 参考图里木盘只有前口下方一弯月牙（v2 受光木区 29.1×6.8cm），不是整块可见圆盘。
    const ray = new THREE.Raycaster();
    const camP = new THREE.Vector3(-3.46, 3.46, 3.46); // 45° 仰角、前左
    const tgt = new THREE.Vector3(0, cm2ft(8.8), 0); // 木盘顶面中心
    ray.set(camP, tgt.clone().sub(camP).normalize());
    const hits = ray.intersectObject(g3, true);
    const hm = hits.length ? hits[0].object.material.color.getHexString() : 'none';
    T(
      'murphy-base-hidden-from-45deg',
      hits.length > 0 && hm !== '8b6a45',
      '首个命中材质 ' + hm + '（木=8b6a45）· 距离 ' + (hits.length ? hits[0].distance.toFixed(2) : '-') + 'ft'
    );
    const laett = CATALOG.find((c) => c.id === 'laett-0');
    const laettFit = (() => {
      const g = furn3D({ uid: -113, ref: laett.id, x: 0, y: 0, rot: 0 }, laett);
      g.updateMatrixWorld(true);
      const b = new THREE.Box3().setFromObject(g);
      const sz = new THREE.Vector3(),
        ct = new THREE.Vector3();
      b.getSize(sz);
      b.getCenter(ct);
      disposeOwned(g);
      return { sz, ct, fx: sz.x / cm2ft(laett.w), fz: sz.z / cm2ft(laett.d), fy: sz.y / cm2ft(laett.h), minY: b.min.y };
    })();
    T(
      'laett-fits-footprint',
      laettFit.fx <= 1.02 && laettFit.fz <= 1.02 && laettFit.fy <= 1.02,
      'LÄTT 套装填充率 ' +
        [laettFit.fx, laettFit.fz, laettFit.fy].map((v) => (v * 100).toFixed(0) + '%').join('/') +
        '（声明 ' +
        laett.w +
        '×' +
        laett.d +
        '×' +
        laett.h +
        'cm，桌+2椅）'
    );
    T(
      'laett-centered',
      Math.abs(laettFit.ct.x) < 0.03 && Math.abs(laettFit.ct.z) < 0.03,
      'LÄTT 套装水平重心 (' + laettFit.ct.x.toFixed(2) + ', ' + laettFit.ct.z.toFixed(2) + ')'
    );
    T('laett-on-floor', laettFit.minY > -0.02, 'LÄTT 最低点 y=' + laettFit.minY.toFixed(3));
    const hxy = CATALOG.find((c) => c.id === 'hape-xylo-0');
    const hxyFit = (() => {
      const g = furn3D({ uid: -114, ref: hxy.id, x: 0, y: 0, rot: 0 }, hxy);
      g.updateMatrixWorld(true);
      const b = new THREE.Box3().setFromObject(g);
      const sz = new THREE.Vector3(),
        ct = new THREE.Vector3();
      b.getSize(sz);
      b.getCenter(ct);
      disposeOwned(g);
      return { sz, ct, fx: sz.x / cm2ft(hxy.w), fz: sz.z / cm2ft(hxy.d), fy: sz.y / cm2ft(hxy.h), minY: b.min.y };
    })();
    T(
      'hape-xylo-fits-footprint',
      hxyFit.fx <= 1.02 && hxyFit.fz <= 1.02 && hxyFit.fy <= 1.02,
      'Hape 木琴填充率 ' +
        [hxyFit.fx, hxyFit.fz, hxyFit.fy].map((v) => (v * 100).toFixed(0) + '%').join('/') +
        '（声明 ' +
        hxy.w +
        '×' +
        hxy.d +
        '×' +
        hxy.h +
        'cm）'
    );
    T(
      'hape-xylo-footprint-not-inflated',
      hxyFit.fx >= 0.92 && hxyFit.fz >= 0.92,
      '不能虚报占地：' + [hxyFit.fx, hxyFit.fz].map((v) => (v * 100).toFixed(0) + '%').join('/')
    );
    T(
      'hape-xylo-centered',
      Math.abs(hxyFit.ct.x) < 0.03 && Math.abs(hxyFit.ct.z) < 0.03,
      'Hape 木琴水平重心 (' + hxyFit.ct.x.toFixed(2) + ', ' + hxyFit.ct.z.toFixed(2) + ')'
    );
    T('hape-xylo-on-floor', hxyFit.minY > -0.02, 'Hape 木琴最低点 y=' + hxyFit.minY.toFixed(3));
    const btb = CATALOG.find((c) => c.id === 'bt-board-0');
    const btbFit = (() => {
      const g = furn3D({ uid: -115, ref: btb.id, x: 0, y: 0, rot: 0 }, btb);
      g.updateMatrixWorld(true);
      const b = new THREE.Box3().setFromObject(g);
      const sz = new THREE.Vector3(),
        ct = new THREE.Vector3();
      b.getSize(sz);
      b.getCenter(ct);
      disposeOwned(g);
      return { sz, ct, fx: sz.x / cm2ft(btb.w), fz: sz.z / cm2ft(btb.d), fy: sz.y / cm2ft(btb.h), minY: b.min.y };
    })();
    T(
      'bt-board-fits-footprint',
      btbFit.fx <= 1.02 && btbFit.fz <= 1.02 && btbFit.fy <= 1.02,
      'Blueberry 平衡板填充率 ' +
        [btbFit.fx, btbFit.fz, btbFit.fy].map((v) => (v * 100).toFixed(0) + '%').join('/') +
        '（声明 ' +
        btb.w +
        '×' +
        btb.d +
        '×' +
        btb.h +
        'cm）'
    );
    T(
      'bt-board-footprint-not-inflated',
      btbFit.fx >= 0.92 && btbFit.fz >= 0.92,
      '不能虚报占地：' + [btbFit.fx, btbFit.fz].map((v) => (v * 100).toFixed(0) + '%').join('/')
    );
    T(
      'bt-board-centered',
      Math.abs(btbFit.ct.x) < 0.03 && Math.abs(btbFit.ct.z) < 0.03,
      'Blueberry 平衡板水平重心 (' + btbFit.ct.x.toFixed(2) + ', ' + btbFit.ct.z.toFixed(2) + ')'
    );
    T('bt-board-on-floor', btbFit.minY > -0.02, 'Blueberry 平衡板最低点 y=' + btbFit.minY.toFixed(3));
    const szf = CATALOG.find((c) => c.id === 'lt-sportszone-0');
    const szFit = (() => {
      const g = furn3D({ uid: -116, ref: szf.id, x: 0, y: 0, rot: 0 }, szf);
      g.updateMatrixWorld(true);
      const b = new THREE.Box3().setFromObject(g);
      const sz = new THREE.Vector3(),
        ct = new THREE.Vector3();
      b.getSize(sz);
      b.getCenter(ct);
      disposeOwned(g);
      return { sz, ct, fx: sz.x / cm2ft(szf.w), fz: sz.z / cm2ft(szf.d), fy: sz.y / cm2ft(szf.h), minY: b.min.y };
    })();
    T(
      'sportszone-fits-footprint',
      szFit.fx <= 1.02 && szFit.fz <= 1.02 && szFit.fy <= 1.02,
      'LT 运动站填充率 ' +
        [szFit.fx, szFit.fz, szFit.fy].map((v) => (v * 100).toFixed(0) + '%').join('/') +
        '（声明 ' +
        szf.w +
        '×' +
        szf.d +
        '×' +
        szf.h +
        'cm）'
    );
    T(
      'sportszone-footprint-not-inflated',
      szFit.fx >= 0.92 && szFit.fz >= 0.92,
      '不能虚报占地：' + [szFit.fx, szFit.fz].map((v) => (v * 100).toFixed(0) + '%').join('/')
    );
    T(
      'sportszone-centered',
      Math.abs(szFit.ct.x) < 0.03 && Math.abs(szFit.ct.z) < 0.03,
      'LT 运动站水平重心 (' + szFit.ct.x.toFixed(2) + ', ' + szFit.ct.z.toFixed(2) + ')'
    );
    T('sportszone-on-floor', szFit.minY > -0.02, 'LT 运动站最低点 y=' + szFit.minY.toFixed(3));
    const lwf = CATALOG.find((c) => c.id === 'lt-walker-0');
    const lwFit = (() => {
      const g = furn3D({ uid: -117, ref: lwf.id, x: 0, y: 0, rot: 0 }, lwf);
      g.updateMatrixWorld(true);
      const b = new THREE.Box3().setFromObject(g);
      const sz = new THREE.Vector3(),
        ct = new THREE.Vector3();
      b.getSize(sz);
      b.getCenter(ct);
      disposeOwned(g);
      return { sz, ct, fx: sz.x / cm2ft(lwf.w), fz: sz.z / cm2ft(lwf.d), fy: sz.y / cm2ft(lwf.h), minY: b.min.y };
    })();
    T(
      'lt-walker-fits-footprint',
      lwFit.fx <= 1.02 && lwFit.fz <= 1.02 && lwFit.fy <= 1.02,
      'LT 学步车填充率 ' +
        [lwFit.fx, lwFit.fz, lwFit.fy].map((v) => (v * 100).toFixed(0) + '%').join('/') +
        '（声明 ' +
        lwf.w +
        '×' +
        lwf.d +
        '×' +
        lwf.h +
        'cm）'
    );
    T(
      'lt-walker-footprint-not-inflated',
      lwFit.fx >= 0.92 && lwFit.fz >= 0.92,
      '不能虚报占地：' + [lwFit.fx, lwFit.fz].map((v) => (v * 100).toFixed(0) + '%').join('/')
    );
    T(
      'lt-walker-centered',
      Math.abs(lwFit.ct.x) < 0.03 && Math.abs(lwFit.ct.z) < 0.03,
      'LT 学步车水平重心 (' + lwFit.ct.x.toFixed(2) + ', ' + lwFit.ct.z.toFixed(2) + ')'
    );
    T('lt-walker-on-floor', lwFit.minY > -0.02, 'LT 学步车最低点 y=' + lwFit.minY.toFixed(3));
    const cov = CATALOG.find((c) => c.id === 'cove-0');
    const covFit = (() => {
      const g = furn3D({ uid: -118, ref: cov.id, x: 0, y: 0, rot: 0 }, cov);
      g.updateMatrixWorld(true);
      const b = new THREE.Box3().setFromObject(g);
      const sz = new THREE.Vector3(),
        ct = new THREE.Vector3();
      b.getSize(sz);
      b.getCenter(ct);
      let tri = 0;
      g.traverse((o) => {
        if (o.isMesh && o.geometry && o.geometry.attributes.position) tri += o.geometry.attributes.position.count / 3;
      });
      disposeOwned(g);
      return { sz, ct, fx: sz.x / cm2ft(cov.w), fz: sz.z / cm2ft(cov.d), fy: sz.y / cm2ft(cov.h), minY: b.min.y, tri };
    })();
    T(
      'cove-fits-footprint',
      covFit.fx <= 1.02 && covFit.fz <= 1.02 && covFit.fy <= 1.02,
      'Cascading Cove 填充率 ' +
        [covFit.fx, covFit.fz, covFit.fy].map((v) => (v * 100).toFixed(0) + '%').join('/') +
        '（声明 ' +
        cov.w +
        '×' +
        cov.d +
        '×' +
        cov.h +
        'cm，不含遮阳伞）'
    );
    T(
      'cove-footprint-not-inflated',
      covFit.fx >= 0.92 && covFit.fz >= 0.92,
      '不能虚报占地：' + [covFit.fx, covFit.fz].map((v) => (v * 100).toFixed(0) + '%').join('/')
    );
    T(
      'cove-centered',
      Math.abs(covFit.ct.x) < 0.03 && Math.abs(covFit.ct.z) < 0.03,
      'Cascading Cove 水平重心 (' + covFit.ct.x.toFixed(2) + ', ' + covFit.ct.z.toFixed(2) + ')'
    );
    T('cove-on-floor', covFit.minY > -0.02, 'Cascading Cove 最低点 y=' + covFit.minY.toFixed(3));
    T('cove-tri-ok', covFit.tri > 500 && covFit.tri < 40000, '三角面 ' + covFit.tri.toFixed(0));
    const hw = CATALOG.find((c) => c.id === 'hw-02e');
    T(
      'hw02e-costs-money',
      !isBuiltIn(hw) && !!priceOf(hw, 'usd') && hasLightCtl(hw),
      '计价 ' + fmtPrice(hw, 'usd') + ' 且有调光控件'
    );
    T(
      'hw02e-two-lights',
      (() => {
        const g = furn3D({ uid: -12, ref: hw.id, x: 0, y: 0, rot: 0 }, hw);
        let n = 0;
        g.traverse((o) => {
          if (o.isLight) n++;
        });
        disposeOwned(g);
        return n === 2;
      })(),
      '上下双向发光'
    );

    /* ===== v3.6：9 件座椅重做（原来全在吃 kind 通用回退，只有 120 面） ===== */
    const SEATING = [
      'teodores',
      'odger',
      'tobias',
      'lisabo_ch',
      'bergmund_bar',
      'skogsta_st',
      'franklin',
      'flintan',
      'markus',
    ];
    const seatBad = [],
      seatInfo = [];
    for (const id of SEATING) {
      const sp = CATALOG.find((c) => c.id === id);
      if (!sp) {
        seatBad.push(id + ':条目没了');
        continue;
      }
      if (!sp.model) {
        seatBad.push(id + ':没有专属模型');
        continue;
      }
      if (sp.seatH == null) {
        seatBad.push(id + ':缺 seatH');
        continue;
      }
      const g = furn3D({ uid: -30, ref: sp.id, x: 0, y: 0, rot: 0 }, sp);
      g.updateMatrixWorld(true);
      const b = new THREE.Box3().setFromObject(g);
      const sz = new THREE.Vector3(),
        ct = new THREE.Vector3();
      b.getSize(sz);
      b.getCenter(ct);
      let tri = 0;
      g.traverse((o) => {
        if (o.isMesh && o.geometry && o.geometry.attributes.position) tri += o.geometry.attributes.position.count / 3;
      });
      const fx = sz.x / cm2ft(sp.w),
        fz = sz.z / cm2ft(sp.d),
        fy = sz.y / cm2ft(sp.h);
      const bad = [];
      if (tri < 2000) bad.push('面数 ' + Math.round(tri)); // 通用回退是 120 面
      if (fx < 0.92 || fx > 1.02 || fz < 0.92 || fz > 1.02 || fy < 0.92 || fy > 1.02)
        bad.push('填充率 ' + [fx, fz, fy].map((v) => (v * 100).toFixed(0)).join('/'));
      if (Math.abs(ct.x) > 0.03 || Math.abs(ct.z) > 0.03) bad.push('重心偏');
      if (b.min.y < -0.02) bad.push('沉地板 ' + b.min.y.toFixed(3));
      disposeOwned(g);
      if (bad.length) seatBad.push(id + ':' + bad.join('/'));
      else seatInfo.push(id + ' ' + Math.round(tri));
    }
    T('seating-remodeled', seatBad.length === 0, seatBad.length ? seatBad.join(' | ') : seatInfo.join(' · '));
    T(
      'seating-all-have-seatH',
      SEATING.every((id) => {
        const sp = CATALOG.find((c) => c.id === id);
        return sp && sp.seatH != null;
      }),
      '9 件座椅都补了座高'
    );
    // 新贴图：种子不能撞（撞了两张图会一模一样）
    T(
      'new-textures-registered',
      typeof speckleTexture === 'function' &&
        typeof meshWeaveTexture === 'function' &&
        speckleTexture() !== meshWeaveTexture(),
      '再生木纤维 / 网布 两张新贴图各自独立'
    );

    /* ===== 目录缩略图（v3.1） ===== */
    const sample = [
      'billy',
      'pg_qriser',
      'pg_chestnut',
      'saltsjobaden-0',
      'raskog-0',
      'cl-flush',
      'wk-mat-s-0',
      'storklinta6',
    ];
    const tOK = [],
      tBad = [];
    const coverOf = async (url) => {
      // 按像素判断，不按 PNG 字节数（简单形状压得很小）
      const im = await new Promise((r) => {
        const i = new Image();
        i.onload = () => r(i);
        i.onerror = () => r(null);
        i.src = url;
      });
      if (!im) return -1;
      const c = document.createElement('canvas');
      c.width = im.width;
      c.height = im.height;
      const g2 = c.getContext('2d');
      g2.drawImage(im, 0, 0);
      const d = g2.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 16) n++;
      return n / (d.length / 4);
    };
    const spanOf = async (url) => {
      // 物体在画面里占多长的一条边（取景是否贴合）
      const im = await new Promise((r) => {
        const i = new Image();
        i.onload = () => r(i);
        i.onerror = () => r(null);
        i.src = url;
      });
      if (!im) return 0;
      const c = document.createElement('canvas');
      c.width = im.width;
      c.height = im.height;
      const g2 = c.getContext('2d');
      g2.drawImage(im, 0, 0);
      const d = g2.getImageData(0, 0, c.width, c.height).data;
      let x0 = 1e9,
        x1 = -1,
        y0 = 1e9,
        y1 = -1;
      for (let y = 0; y < c.height; y++)
        for (let x = 0; x < c.width; x++) {
          if (d[(y * c.width + x) * 4 + 3] > 16) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      if (x1 < 0) return 0;
      return Math.max((x1 - x0 + 1) / c.width, (y1 - y0 + 1) / c.height);
    };
    for (const id of sample) {
      const sp = CATALOG.find((c) => c.id === id) || CATALOG.find((c) => c.id.indexOf(id) === 0);
      if (!sp) {
        tBad.push(id + ':无此条目');
        continue;
      }
      const url = furnThumb(sp);
      if (!url) {
        tBad.push(sp.id + ':null');
        continue;
      }
      const cov = await coverOf(url);
      if (cov < 0.04) {
        tBad.push(sp.id + ':几乎空白 ' + (cov * 100).toFixed(1) + '%');
        continue;
      }
      const sp2 = await spanOf(url);
      if (sp2 < 0.7) {
        tBad.push(sp.id + ':取景太松 只占 ' + (sp2 * 100).toFixed(0) + '%');
        continue;
      }
      tOK.push(sp.id + ' ' + (cov * 100).toFixed(0) + '%/' + (sp2 * 100).toFixed(0) + '%');
    }
    T('thumb-renders', tBad.length === 0, tBad.length ? tBad.join(' | ') : tOK.join(' · '));
    // 缩略图不能是全透明/纯色：统计非空像素
    const tsp = CATALOG.find((c) => c.id === 'billy');
    const turl = furnThumb(tsp);
    const tim = await new Promise((r) => {
      const im = new Image();
      im.onload = () => r(im);
      im.onerror = () => r(null);
      im.src = turl;
    });
    if (tim) {
      const tc = document.createElement('canvas');
      tc.width = tim.width;
      tc.height = tim.height;
      const tg = tc.getContext('2d');
      tg.drawImage(tim, 0, 0);
      const td = tg.getImageData(0, 0, tc.width, tc.height).data;
      let opaque = 0,
        lum = 0;
      for (let i = 0; i < td.length; i += 4) {
        if (td[i + 3] > 16) {
          opaque++;
          lum += td[i] * 0.299 + td[i + 1] * 0.587 + td[i + 2] * 0.114;
        }
      }
      const frac = opaque / (td.length / 4);
      T(
        'thumb-has-content',
        frac > 0.05 && frac < 0.95 && lum / Math.max(opaque, 1) > 15,
        '占画面 ' + (frac * 100).toFixed(0) + '% · 平均亮度 ' + (lum / Math.max(opaque, 1)).toFixed(0)
      );
    } else T('thumb-has-content', false, '图片解码失败');
    // 同款不同色的缩略图必须真的不一样（曝过头会把浅色件全推成白）
    const meanOf = async (url) => {
      const im = await new Promise((r) => {
        const i = new Image();
        i.onload = () => r(i);
        i.onerror = () => r(null);
        i.src = url;
      });
      if (!im) return null;
      const c = document.createElement('canvas');
      c.width = im.width;
      c.height = im.height;
      const g2 = c.getContext('2d');
      g2.drawImage(im, 0, 0);
      const d = g2.getImageData(0, 0, c.width, c.height).data;
      let r = 0,
        g3 = 0,
        b = 0,
        n = 0;
      for (let i = 0; i < d.length; i += 4)
        if (d[i + 3] > 128) {
          r += d[i];
          g3 += d[i + 1];
          b += d[i + 2];
          n++;
        }
      return n ? [r / n, g3 / n, b / n] : null;
    };
    const mA = await meanOf(furnThumb(CATALOG.find((c) => c.id === 'wk-mat-s-0'))); // 沙色
    const mB = await meanOf(furnThumb(CATALOG.find((c) => c.id === 'wk-mat-s-1'))); // 石灰色
    if (mA && mB) {
      const dist = Math.hypot(mA[0] - mB[0], mA[1] - mB[1], mA[2] - mB[2]);
      const notWhite = Math.max(mA[0], mA[1], mA[2]) < 246 && Math.max(mB[0], mB[1], mB[2]) < 246;
      T(
        'thumb-color-variants-differ',
        dist > 14 && notWhite,
        '沙色 rgb(' +
          mA.map((v) => v.toFixed(0)) +
          ') vs 石灰 rgb(' +
          mB.map((v) => v.toFixed(0)) +
          ') 距离=' +
          dist.toFixed(0)
      );
    } else T('thumb-color-variants-differ', false, '取样失败');
    T('thumb-cached', _thumbCache.size >= sample.length, _thumbCache.size + ' 张已缓存');

    /* ===== 全目录：建模不抛错 + 材质都带贴图（v3.1） ===== */
    const bad = [],
      noMap = [],
      noNrm = [];
    let totalTri = 0,
      checked = 0;
    const heavy = [];
    for (const c of CATALOG) {
      const probe = { uid: 999000 + checked, ref: c.id, x: 12, y: 12, rot: 0 };
      let gg = null;
      try {
        gg = furn3D(probe, c);
      } catch (e) {
        bad.push(c.id + ':' + e.message);
        continue;
      }
      if (!gg) {
        bad.push(c.id + ':null');
        continue;
      }
      let meshes = 0,
        withMap = 0,
        withNrm = 0,
        tri = 0;
      gg.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        const m = Array.isArray(o.material) ? o.material[0] : o.material;
        meshes++;
        if (m.map) withMap++;
        if (m.normalMap) withNrm++;
        if (o.geometry && o.geometry.attributes.position) tri += o.geometry.attributes.position.count / 3;
      });
      totalTri += tri;
      checked++;
      heavy.push([c.id, tri]);
      if (meshes && withMap === 0 && !isLight(c)) noMap.push(c.id);
      if (meshes && withNrm === 0 && !isLight(c)) noNrm.push(c.id);
      disposeOwned(gg);
    }
    T(
      'catalog-all-build',
      bad.length === 0,
      checked + ' 件 · 失败 ' + bad.length + (bad.length ? ': ' + bad.slice(0, 3).join(' | ') : '')
    );
    T(
      'catalog-all-textured',
      noMap.length === 0,
      noMap.length ? '无贴图: ' + noMap.slice(0, 8).join(',') : checked + ' 件全部带贴图'
    );
    T(
      'catalog-all-normalmapped',
      noNrm.length <= 2,
      noNrm.length ? '无法线贴图: ' + noNrm.slice(0, 8).join(',') : '全部带法线贴图'
    );
    heavy.sort((a, b) => b[1] - a[1]);
    T('catalog-tri-avg', totalTri / checked < 12000, '平均 ' + Math.round(totalTri / checked) + ' 三角形/件');
    T(
      'catalog-tri-max',
      heavy.length === 0 || heavy[0][1] < 40000,
      '最重: ' +
        heavy
          .slice(0, 5)
          .map((h) => h[0] + ' ' + Math.round(h[1]))
          .join(' · ')
    );
    T(
      'catalog-climbers',
      CATALOG.filter((c) => c.kind === 'climber').length >= 13,
      CATALOG.filter((c) => c.kind === 'climber').length + ' 款爬爬架'
    );

    /* ===== 双击 = 进室内视角（2D 和俯瞰都要支持）
       S10：目标点从 floorPts() 中心派生（plan-independent：generic/mine 两个户型同一套脚本） ===== */
    setView('2d');
    await wait(400);
    const svgEl2 = document.querySelector('#svg2d');
    const ctm = svgEl2.getScreenCTM();
    const toScreen = (fx, fz) => {
      const p = new DOMPoint(fx * S, fz * S).matrixTransform(ctm);
      return [p.x, p.y];
    };
    const [dx1, dy1] = toScreen(TP1[0], TP1[1]);
    svgEl2.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: dx1, clientY: dy1 }));
    await wait(1400);
    T(
      'dblclick-2d-enters-fp',
      state.view === 'fp' && three.camMode === 'fp',
      'view=' + state.view + ' cam=' + three.camMode
    );
    T(
      'dblclick-2d-lands-there',
      Math.hypot(three.cam.position.x - TP1[0], three.cam.position.z - TP1[1]) < 1.2,
      '站位 (' +
        three.cam.position.x.toFixed(1) +
        ', ' +
        three.cam.position.z.toFixed(1) +
        ') 目标 (' +
        TP1[0].toFixed(1) +
        ', ' +
        TP1[1].toFixed(1) +
        ')'
    );

    // 俯瞰视角双击地面
    setView('doll');
    await wait(900);
    setCamMode('doll');
    three.controls.target.set(TP2[0], 0, TP2[1]);
    three.cam.position.set(TP2[0], 16, TP2[1] + 0.01);
    three.cam.fov = 45;
    three.cam.updateProjectionMatrix();
    three.controls.update();
    await wait(300);
    const cv2 = document.querySelector('#c3d'),
      r2 = cv2.getBoundingClientRect();
    three.cam.updateMatrixWorld(true);
    const tp = new THREE.Vector3(TP2[0], 0, TP2[1]).project(three.cam);
    const sx2 = r2.left + (tp.x * 0.5 + 0.5) * r2.width,
      sy2 = r2.top + (-tp.y * 0.5 + 0.5) * r2.height;
    cv2.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: sx2, clientY: sy2 }));
    await wait(900);
    T(
      'dblclick-doll-enters-fp',
      state.view === 'fp' && three.camMode === 'fp',
      'view=' + state.view + ' cam=' + three.camMode
    );
    T(
      'dblclick-doll-lands-there',
      Math.hypot(three.cam.position.x - TP2[0], three.cam.position.z - TP2[1]) < 1.5,
      '站位 (' +
        three.cam.position.x.toFixed(1) +
        ', ' +
        three.cam.position.z.toFixed(1) +
        ') 目标 (' +
        TP2[0].toFixed(1) +
        ', ' +
        TP2[1].toFixed(1) +
        ')'
    );

    // 全局开关灯（室内视角，灯具此时才满强度）
    setCamMode('fp');
    await wait(400);
    const lsum = () => {
      let s = 0;
      three.furnGroup.traverse((o) => {
        if (o.isLight) s += o.intensity;
      });
      return s;
    };
    const esum = () => {
      let s = 0;
      three.furnGroup.traverse((o) => {
        if (o.isMesh && o.material && o.material.userData && o.material.userData.emisBase != null)
          s += o.material.emissiveIntensity;
      });
      return s;
    };
    setLights(true);
    await wait(200);
    const ion = lsum(),
      eon = esum();
    T('3d-lamp-toggle-visible', getComputedStyle(document.querySelector('#lampSeg')).display !== 'none');
    setLights(false);
    await wait(200);
    T('3d-lights-off-zero-intensity', lsum() === 0, 'on=' + ion.toFixed(1) + ' off=' + lsum());
    T('3d-lights-off-no-emissive', esum() === 0, 'on=' + eon.toFixed(1));
    setLights(true);
    await wait(200);
    T('3d-lights-on-restores', Math.abs(lsum() - ion) < 1e-6, ion.toFixed(1));
    // ===== S2：窗户 3D（款式 + 框色；断言对 mergeByMaterial 感知：数白框顶点总量，不数 mesh） =====
    const bw = DOC.windows.find((w) => !w.fullHeight && !w.steel);
    T('t3d-win-doc', !!bw && bw.style === 'fixed', bw && bw.id);
    const whiteVerts = () => {
      let n = 0;
      three.scene.traverse((o) => {
        if (o.isMesh && o.material && o.material.color && o.material.color.getHex() === 0xf2f1ec)
          n += o.geometry.attributes.position.count;
      });
      return n;
    };
    const vFixed = whiteVerts();
    bw.style = 'casement';
    bw.frame = '#f2f1ec';
    bw.steel = false;
    buildStatic3D();
    await wait(100);
    const vCas = whiteVerts();
    T('t3d-win-casement-more-frame', vCas >= 150 && vCas > vFixed + 50, 'fixed=' + vFixed + ' casement=' + vCas);
    bw.style = 'awning';
    buildStatic3D();
    await wait(100);
    const vAwn = whiteVerts();
    T('t3d-win-awning-fewer-frame', vAwn > 0 && vAwn < vCas, 'awning=' + vAwn);
    bw.style = 'fixed';
    bw.frame = '#1c2528';
    buildStatic3D();
    await wait(100);
    T('t3d-win-restore-dark', whiteVerts() === 0, 'after=' + whiteVerts());

    // ===== S4a: 环境预设 + 昼夜持久化 =====
    T(
      's4-env-in-doc',
      DOC.env && typeof DOC.env.preset === 'string' && (DOC.env.mode === 'day' || DOC.env.mode === 'night'),
      JSON.stringify(DOC.env)
    );
    const s4t1 = panorama('suburban', false),
      s4t2 = panorama('suburban', false);
    T('s4-pano-cache', s4t1 === s4t2, 'cache');
    const s4t3 = panorama('seaview', true),
      s4t4 = panorama('seaview', true);
    T(
      's4-pano-distinct',
      s4t3 === s4t4 && s4t3 !== s4t1 && s4t1 !== panorama('seattle-city', false),
      '3 presets distinct'
    );
    T('s4-pano-size', s4t1.image.width === 2048 && s4t1.image.height === 1024, '2048x1024');
    // 确定性：清缓存重新生成，抽 3 个像素比对（同种子 → 同像素）
    const _g = s4t1.image.getContext('2d');
    const px = (x, y) => {
      const d = _g.getImageData(x, y, 1, 1).data;
      return [d[0], d[1], d[2]];
    };
    const p0 = [px(100, 100), px(1000, 500), px(1900, 900)];
    delete _skyCache['suburband'];
    const s4t5 = panorama('suburban', false);
    const _g5 = s4t5.image.getContext('2d');
    const px5 = (x, y) => {
      const d = _g5.getImageData(x, y, 1, 1).data;
      return [d[0], d[1], d[2]];
    };
    T(
      's4-pano-deterministic',
      JSON.stringify([px5(100, 100), px5(1000, 500), px5(1900, 900)]) === JSON.stringify(p0),
      're-gen identical'
    );
    setDayNight(true);
    await wait(100);
    T(
      's4-dn-persist',
      DOC.env.mode === 'night' &&
        three.night === true &&
        JSON.parse(localStorage.getItem(DOC_KEY)).env.mode === 'night',
      JSON.stringify(DOC.env)
    );
    setDayNight(false);
    await wait(100);
    T(
      's4-dn-restore',
      DOC.env.mode === 'day' && three.night === false && JSON.parse(localStorage.getItem(DOC_KEY)).env.mode === 'day'
    );
    setPreset('suburban');
    await wait(100);
    T(
      's4-preset-persist',
      DOC.env.preset === 'suburban' &&
        three.preset === 'suburban' &&
        JSON.parse(localStorage.getItem(DOC_KEY)).env.preset === 'suburban' &&
        three.panorama === panorama('suburban', false),
      JSON.stringify(DOC.env)
    );
    T(
      's4-preset-btn',
      document.querySelector('#envSub').classList.contains('on') &&
        !document.querySelector('#envCity').classList.contains('on')
    );
    setPreset('seaview');
    await wait(100);
    T(
      's4-preset-sea',
      three.panorama === panorama('seaview', false) && document.querySelector('#envSea').classList.contains('on')
    );
    setPreset('seattle-city');
    setDayNight(false);
    await wait(100);
    T(
      's4-restore-default',
      DOC.env.preset === 'seattle-city' &&
        DOC.env.mode === 'day' &&
        !three.night &&
        JSON.parse(localStorage.getItem(DOC_KEY)).env.preset === 'seattle-city'
    );
    // ===== S6：3D 洁具（每件一个 Group；rot 绕占地中心）=====
    {
      const f0 = DOC.fixtures[0];
      const cx0 = (f0.x1 + f0.x2) / 2,
        cz0 = (f0.y1 + f0.y2) / 2;
      let g0 = null;
      three.staticGroup.children.forEach((o) => {
        if (o.isGroup && Math.abs(o.position.x - cx0) < 0.01 && Math.abs(o.position.z - cz0) < 0.01) g0 = o;
      });
      T('s6-fx-3d-builtin-flat', !g0, g0 ? 'unexpected group n=' + g0.children.length : 'flat (no group) as expected');
      DOC.fixtures.push({ id: 'f98', t: 'toilet', x1: 30, y1: 20, x2: 32.3, y2: 21.3, rot: 30, src: 'user' });
      geoChanged();
      setView('2d');
      setView('3d');
      await wait(400);
      let g1 = null;
      three.staticGroup.children.forEach((o) => {
        if (o.isGroup && Math.abs(o.position.x - 31.15) < 0.01 && Math.abs(o.position.z - 20.65) < 0.01) g1 = o;
      });
      const expRot = (-30 * Math.PI) / 180;
      T(
        's6-fx-3d-rot',
        !!g1 && Math.abs(g1.rotation.y - expRot) < 1e-4,
        g1 ? 'rot=' + g1.rotation.y.toFixed(4) + ' expect=' + expRot.toFixed(4) : 'no group'
      );
      if (g1) {
        g1.updateMatrixWorld(true);
        const bb = new THREE.Box3().setFromObject(g1);
        const cc = new THREE.Vector3();
        bb.getCenter(cc);
        T(
          's6-fx-3d-rot-center',
          Math.hypot(cc.x - 31.15, cc.z - 20.65) < 0.05,
          'center=' + cc.x.toFixed(2) + ',' + cc.z.toFixed(2)
        );
      } else T('s6-fx-3d-rot-center', false, 'no group');
      DOC.fixtures = DOC.fixtures.filter((f) => f.id !== 'f98');
      geoChanged();
      setView('2d');
      setView('3d');
      await wait(300);
    }
    // ===== 找 bug（B2）：旋转镜子的反射 probe 偏移方向必须随 rot 转，偏移点要落在镜体外 =====
    {
      DOC.fixtures.push({ id: 'f99', t: 'mirror', x1: 10, y1: 10, x2: 12, y2: 10.3, rot: 90, src: 'user' });
      geoChanged();
      setView('2d');
      setView('3d');
      await wait(400);
      const mm = three.mirrors && three.mirrors[mirrorsIdx(three.mirrors)];
      function mirrorsIdx(list) {
        return list.length - 1;
      } // f99 是最后 push 的
      let b2ok = false,
        b2info = 'no mirror mesh';
      if (mm) {
        mm.updateMatrixWorld(true);
        const n = mm.userData.mirrorN || [];
        const nOk = Math.abs(n[0] + 1) < 1e-6 && Math.abs(n[1]) < 1e-6 && Math.abs(n[2]) < 1e-6; // S 面旋转 90° → 指向 -x
        const wp = new THREE.Vector3();
        mm.getWorldPosition(wp);
        const pp = wp.clone().add(new THREE.Vector3(n[0] * 0.12, 0, n[2] * 0.12)); // installMirrorProbes 的偏移点
        const bb = new THREE.Box3().setFromObject(mm);
        const outside = pp.x < bb.min.x || pp.x > bb.max.x || pp.z < bb.min.z || pp.z > bb.max.z;
        b2ok = nOk && outside;
        b2info =
          'mirrorN=' +
          JSON.stringify(n.map((v) => +v.toFixed(3))) +
          ' p=' +
          [pp.x.toFixed(2), pp.z.toFixed(2)] +
          ' bbox=' +
          [bb.min.x.toFixed(2), bb.max.x.toFixed(2), bb.min.z.toFixed(2), bb.max.z.toFixed(2)];
      }
      T('hunt-b2-mirror-probe-n', b2ok, b2info);
      DOC.fixtures = DOC.fixtures.filter((f) => f.id !== 'f99');
      geoChanged();
      setView('2d');
      setView('3d');
      await wait(300);
    }
    // ===== S12：用户画的台面 run（3D 柜体 + 台面石板）=====
    // 按材质分桶会把 mesh 合并（parameters 消失、position 不可靠），所以用顶点数 + 桶包围盒。
    {
      const vByColor = (hex) => {
        let v = 0;
        three.staticGroup.traverse((o) => {
          if (o.isMesh && o.material && o.material.color && o.material.color.getHex() === hex)
            v += o.geometry.attributes.position.count;
        });
        return v;
      };
      const bbByColor = (hex) => {
        const b = new THREE.Box3();
        three.staticGroup.traverse((o) => {
          if (o.isMesh && o.material && o.material.color && o.material.color.getHex() === hex) b.expandByObject(o);
        });
        return b;
      };
      const has = (b, p) =>
        p[0] >= b.min.x - 0.02 &&
        p[0] <= b.max.x + 0.02 &&
        p[1] >= b.min.y - 0.02 &&
        p[1] <= b.max.y + 0.02 &&
        p[2] >= b.min.z - 0.02 &&
        p[2] <= b.max.z + 0.02;
      const CAB = 0xffffff,
        TOP = 0xe9e7e2,
        STEEL = 0xc9ccd0;
      const v0 = vByColor(CAB),
        t0 = vByColor(TOP),
        s0 = vByColor(STEEL);
      const r12 = pushUserRun(
        [
          [20, 12],
          [26, 12],
        ],
        1.97,
        2.95
      );
      buildStatic3D();
      await wait(120);
      T('s12-3d-cabinet-box', vByColor(CAB) - v0 === 24, '柜体顶点增量 ' + (vByColor(CAB) - v0) + '（BoxGeometry=24）');
      // 按材质合并会把单成员桶也重排（顶点数不保证恰好 24），所以断言增量 ≥24 + 包围盒落在内侧
      T(
        's12-3d-countertop-slab',
        vByColor(TOP) - t0 >= 24,
        '台面石板顶点增量 ' + (vByColor(TOP) - t0) + '（合并桶影响精确计数）'
      );
      const bbT = bbByColor(TOP);
      const inRoom = [23, 2.975, 12 + 1.97 / 2],
        inWall = [23, 2.975, 12 - 1.97 / 2];
      const noKitchen = !(planOf('kitchen') || []).length;
      T(
        's12-3d-band-on-room-side',
        has(bbT, inRoom) && (!noKitchen || !has(bbT, inWall)),
        '台面桶 bbox z=[' +
          bbT.min.z.toFixed(2) +
          ',' +
          bbT.max.z.toFixed(2) +
          '] · 地板中心 z=' +
          floorCentroid()[1].toFixed(1) +
          ' · 厨房数据 ' +
          (noKitchen ? '无（可判两侧）' : '有（只验内侧）')
      );
      r12.modules = [{ at: 1.0, type: 'fridge', w: 2.0 }];
      buildStatic3D();
      await wait(120);
      T('s12-3d-fridge-module', vByColor(STEEL) - s0 === 24, '钢模块顶点增量 ' + (vByColor(STEEL) - s0));
      DOC.runs = DOC.runs.filter((x) => x.id !== r12.id);
      geoChanged();
      buildStatic3D();
      await wait(120);
      T(
        's12-3d-cleared',
        vByColor(CAB) === v0 && vByColor(TOP) === t0 && vByColor(STEEL) === s0,
        'cab ' + (vByColor(CAB) - v0) + ' top ' + (vByColor(TOP) - t0) + ' steel ' + (vByColor(STEEL) - s0)
      );
    }
    // ===== S12：钢框窗（窗实体的 steel 标志）→ 3D 黑钢梁 =====
    {
      const BLACK = 0x17181b;
      const bbB = () => {
        const b = new THREE.Box3();
        three.staticGroup.traverse((o) => {
          if (o.isMesh && o.material && o.material.color && o.material.color.getHex() === BLACK) b.expandByObject(o);
        });
        return b;
      };
      const has = (b, p) =>
        p[0] >= b.min.x - 0.02 &&
        p[0] <= b.max.x + 0.02 &&
        p[1] >= b.min.y - 0.02 &&
        p[1] <= b.max.y + 0.02 &&
        p[2] >= b.min.z - 0.02 &&
        p[2] <= b.max.z + 0.02;
      const w12 = pushUserWindow(20, 20, 26, 20, 9);
      w12.steel = true;
      buildStatic3D();
      await wait(120);
      const bb1 = bbB(),
        mid = [23, CEIL_H / 2, 20];
      T(
        's12-3d-steel-post-at-window',
        has(bb1, mid),
        '黑梁桶 x[' +
          bb1.min.x.toFixed(2) +
          ',' +
          bb1.max.x.toFixed(2) +
          '] y[' +
          bb1.min.y.toFixed(2) +
          ',' +
          bb1.max.y.toFixed(2) +
          '] z[' +
          bb1.min.z.toFixed(2) +
          ',' +
          bb1.max.z.toFixed(2) +
          '] · 窗中点 (23, ' +
          (CEIL_H / 2).toFixed(1) +
          ', 20)'
      );
      DOC.windows = DOC.windows.filter((x) => x.id !== w12.id);
      buildStatic3D();
      await wait(120);
      const bb2 = bbB();
      T(
        's12-3d-steel-removed',
        !(bb2.max.x >= 22.9 && bb2.min.x <= 23.1 && bb2.min.z <= 20.02 && bb2.max.z >= 19.98),
        '移除后 x[' +
          bb2.min.x.toFixed(2) +
          ',' +
          bb2.max.x.toFixed(2) +
          '] z[' +
          bb2.min.z.toFixed(2) +
          ',' +
          bb2.max.z.toFixed(2) +
          ']'
      );
    }
    // ===== bug 猎 #9：导入户型的柱（column 实体）必须在 3D 立起来 =====
    // 导入的实心块填充色是管线固定的 #8a919c，不是内置户型的 #0c0d0f/#15171a。
    // 旧代码只按填充色认结构块 → 导入的柱子 2D 有、3D 没有（探针实测 wallish=0）。
    {
      const WALL = 0xd8d5d0; // matWall
      const vWall = () => {
        let v = 0;
        three.staticGroup.traverse((o) => {
          if (o.isMesh && o.material && o.material.color && o.material.color.getHex() === WALL)
            v += o.geometry.attributes.position.count;
        });
        return v;
      };
      // 水平射线（在接近层高的地方）：柱在不在，一测就知（比包围盒可靠）
      const rc = new THREE.Raycaster();
      const rayDist = () => {
        three.staticGroup.updateMatrixWorld(true);
        rc.set(new THREE.Vector3(CX3 - 2, CEIL_H * 0.9, CY3), new THREE.Vector3(1, 0, 0));
        const h = rc.intersectObject(three.staticGroup, true);
        return h.length ? h[0].distance : Infinity;
      };
      const w0 = vWall();
      const d0 = rayDist();
      const half = 0.5;
      const s9 = {
        id: SCHEMA.Project.nextId(DOC, 'solid'),
        name: '柱',
        geom: {
          t: 'poly',
          pts: [
            [CX3 - half, CY3 - half],
            [CX3 + half, CY3 - half],
            [CX3 + half, CY3 + half],
            [CX3 - half, CY3 + half],
          ],
        },
        fill: '#8a919c', // 导入管线的填充色（不是内置结构块的填充色）
        column: true, // 图纸把它读成柱 → 3D 必须立到顶
        src: 'user',
        userIndex: nextUserIndex('solids'),
      };
      DOC.solids.push(s9);
      buildStatic3D();
      await wait(150);
      const dw = vWall() - w0;
      const d1 = rayDist();
      T(
        's9-3d-imported-column-extrudes',
        dw >= 30 && Math.abs(d1 - 1.5) < 0.2 && d1 < d0,
        '墙材质顶点增量 ' + dw + ' · 射线命中距离 ' + d1.toFixed(2) + '（期望 1.50，无柱时 ' + d0.toFixed(2) + '）'
      );
      DOC.solids = DOC.solids.filter((x) => x.id !== s9.id);
      buildStatic3D();
      await wait(150);
      const dw2 = vWall() - w0;
      const d2 = rayDist();
      // 移除后必须回到加柱之前的读数（不同户型在这条射线上本来就有别的东西，比如窗头带）
      T(
        's9-3d-imported-column-cleared',
        dw2 === 0 && Math.abs(d2 - d0) < 0.05,
        '移除后增量 ' + dw2 + ' · 射线 ' + d2.toFixed(2) + '（加柱前 ' + d0.toFixed(2) + '）'
      );
    }
    T('t3d-bench-done', true, __E3.length + ' tests', 'done');
  } catch (e) {
    log.push('EXC ' + e.message + ' | ' + (e.stack || '').split('\n')[1]);
  }
  log.push('ERRS: ' + JSON.stringify(window.__E3));
  const pre = document.createElement('pre');
  pre.id = 't3d';
  pre.textContent = log.join('\n');
  document.body.appendChild(pre);
}
