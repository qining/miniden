/* E22 户型构建 bench（plan-independent，入库，CI 也跑）
 *
 * 为什么有这一份：2D「从户型构建开始」的覆盖面（画墙 / 柱 / 门与门垛联动 / 洁具放置 /
 * 导入后编辑 / 编辑→3D 一致性）此前只存在于 private/bench/t_walledit.js —— 它含真实户型
 * 坐标断言，CI（generic、无 private/）从来不跑。也就是说公开入口那一侧，
 * 用户最先做的事（画墙、开门、放洁具）没有任何自动化断言。
 *
 * 这一份的口径：
 *   - 所有坐标运行时派生（floorPts() 包围盒、effWalls()/effDoors()/effFixtures() 的真实几何），
 *     不写死任何户型数字 → 同一份脚本跑 mine 与 generic 两个户型（AGENTS §3 plan-independence）
 *   - 断言一律「相对量」：数量 +1、位移 ≈ 目标、契约（长边平行墙 / 法向距离 = 墙半厚 + 件半深）
 *   - 每段结束复位（restoreBuiltins + 清用户实体），段与段之间不泄漏
 *   - 导入用入库的合成 fixture tests/fixtures/apartment-mm.dxf（无个人数据）
 */
window.__ERRS = [];
window.addEventListener('error', (e) => window.__ERRS.push(e.message + ' :' + e.lineno));
window.addEventListener('load', () => {
  setTimeout(runPBTest, 300);
});

async function runPBTest() {
  const log = [];
  const T = (name, ok, extra) =>
    log.push((ok ? 'PASS' : 'FAIL') + ' ' + name + (extra !== undefined ? ' | ' + extra : ''));
  const I = (name, extra) => log.push('INFO ' + name + (extra !== undefined ? ' | ' + extra : ''));
  const tick = () => new Promise((r) => setTimeout(r, 60));
  const origCap = Element.prototype.setPointerCapture;
  Element.prototype.setPointerCapture = function (id) {
    try {
      origCap.call(this, id);
    } catch (e) {}
  };
  const pbSvg = document.querySelector('#svg2d');
  const Q = (s) => document.querySelector(s);
  // 图纸坐标(ft) → 屏幕坐标。viewBox 单位 = ft × S（AGENTS §5.1）
  const SPT = (fx, fy) => {
    const ctm = pbSvg.getScreenCTM();
    const p = new DOMPoint(fx * S, fy * S).matrixTransform(ctm);
    return [p.x, p.y];
  };
  const fire = (type, cx, cy, extra) => {
    const tgt = document.elementFromPoint(cx, cy) || pbSvg;
    tgt.dispatchEvent(
      new PointerEvent(
        type,
        Object.assign(
          {
            clientX: cx,
            clientY: cy,
            bubbles: true,
            cancelable: true,
            pointerId: 1,
            isPrimary: true,
            button: 0,
            buttons: 1,
          },
          extra || {}
        )
      )
    );
    return tgt;
  };
  const key = (k, tgt, sh) =>
    (tgt || document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, shiftKey: !!sh })
    );
  const clickEl = async (sel) => {
    const el = Q(sel);
    if (el) el.click();
    await tick();
    return !!el;
  };
  // 上下文控件组的可见性：读计算样式而不是 inline style（E24 后同格叠放 + .on 类）
  const vis = (sel) => {
    const el = Q(sel);
    return el ? getComputedStyle(el).visibility : 'missing';
  };
  // 屏幕像素 → ft（拖动阈值与位移都按屏幕像素算）
  const pxPerFtNow = () => pbSvg.getScreenCTM().a * S;
  const tap = async (fx, fy) => {
    const [x, y] = SPT(fx, fy);
    fire('pointerdown', x, y);
    await tick();
    fire('pointerup', x, y);
    await tick();
  };
  const dragBy = async (cx, cy, dxpx, dypx) => {
    fire('pointerdown', cx, cy);
    await tick();
    fire('pointermove', cx + dxpx, cy + dypx);
    await tick();
    await tick();
    fire('pointerup', cx + dxpx, cy + dypx);
    await tick();
  };

  /* ---------- 派生锚点（不写死任何户型数字） ---------- */
  const pbFp = floorPts();
  const pbXs = pbFp.map((p) => p[0]);
  const pbYs = pbFp.map((p) => p[1]);
  const BX0 = Math.min.apply(null, pbXs),
    BX1 = Math.max.apply(null, pbXs),
    BY0 = Math.min.apply(null, pbYs),
    BY1 = Math.max.apply(null, pbYs);
  const distSeg = (px, py, s) => {
    const dx = s.x2 - s.x1,
      dy = s.y2 - s.y1,
      L2 = dx * dx + dy * dy;
    if (L2 < 1e-9) return Math.hypot(px - s.x1, py - s.y1);
    const t = Math.max(0, Math.min(1, ((px - s.x1) * dx + (py - s.y1) * dy) / L2));
    return Math.hypot(px - (s.x1 + dx * t), py - (s.y1 + dy * t));
  };
  // 离已有几何最远的内部点：新构件画在这里，吸附不会把测试变成「测吸附」
  const pbClearance = (px, py) => {
    let d = 1e9;
    for (const s of effWalls()) if (s.t === 'w' || s.t === 'i') d = Math.min(d, distSeg(px, py, s));
    for (const f of effFixtures()) {
      const cx = (f.x1 + f.x2) / 2,
        cy = (f.y1 + f.y2) / 2;
      d = Math.min(d, Math.max(0, Math.hypot(px - cx, py - cy) - Math.max(f.x2 - f.x1, f.y2 - f.y1) / 2));
    }
    for (const s of effFixed()) {
      const pl = s.poly || [];
      for (const q of pl) d = Math.min(d, Math.hypot(px - q[0], py - q[1]));
    }
    return d;
  };
  const pbFree = (() => {
    let best = null,
      bs = -1;
    const stepX = (BX1 - BX0) / 14,
      stepY = (BY1 - BY0) / 14;
    for (let gx = BX0 + stepX; gx <= BX1 - stepX; gx += stepX)
      for (let gy = BY0 + stepY; gy <= BY1 - stepY; gy += stepY) {
        const d = pbClearance(gx, gy);
        if (d > bs) {
          bs = d;
          best = [gx, gy];
        }
      }
    return best || [(BX0 + BX1) / 2, (BY0 + BY1) / 2];
  })();
  const pbFreeClear = pbClearance(pbFree[0], pbFree[1]);
  // 一条够长、且中点附近没有洁具/门的内置墙（否则点击会选中洁具而不是墙）
  const pbWall = (() => {
    let best = null,
      bs = -1;
    for (const s of effWalls()) {
      if (s.t !== 'w') continue;
      const L = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
      if (L < 3) continue;
      const mx = (s.x1 + s.x2) / 2,
        my = (s.y1 + s.y2) / 2;
      let cl = pbClearance(mx, my);
      for (const d of effDoors()) cl = Math.min(cl, distSeg(mx, my, d));
      if (cl > bs) {
        bs = cl;
        best = s;
      }
    }
    return best || effWalls().filter((s) => s.t === 'w')[0];
  })();
  // 一扇室内门（优先平开、宽 1.5~3.5ft；没有就退而取最宽的）
  const pbDoor0 = (() => {
    let pref = null,
      alt = null,
      bl = 0;
    for (const d of effDoors()) {
      const L = Math.hypot(d.x2 - d.x1, d.y2 - d.y1);
      if (L > bl) {
        bl = L;
        alt = d;
      }
      const e = entById(d._id);
      if (!pref && L >= 1.5 && L <= 3.5 && (!e || e.kind === 'swing')) pref = d;
    }
    return pref || alt;
  })();
  const pbDoorLen = pbDoor0 ? Math.hypot(pbDoor0.x2 - pbDoor0.x1, pbDoor0.y2 - pbDoor0.y1) : 0;
  const pbDoorU = pbDoor0 ? [(pbDoor0.x2 - pbDoor0.x1) / pbDoorLen, (pbDoor0.y2 - pbDoor0.y1) / pbDoorLen] : [1, 0];
  // 一件内置洁具（「内置不可删」的对照）
  const pbFx0 = (() => {
    let best = null,
      ba = 0;
    for (const f of DOC.fixtures) {
      if (f.src === 'user') continue;
      const a = Math.abs((f.x2 - f.x1) * (f.y2 - f.y1));
      if (a > ba) {
        ba = a;
        best = f;
      }
    }
    return best;
  })();

  const pbFresh = () => freshDoc();
  const builtinDirty = () => {
    const f = pbFresh();
    let n = 0;
    for (const arr of ['walls', 'windows', 'doors', 'solids'])
      for (const e of DOC[arr])
        if (e.src === 'user') continue;
        else {
          const b = f[arr].find((x) => x.id === e.id);
          if (!b || JSON.stringify(e) !== JSON.stringify(b)) n++;
        }
    for (const e of DOC.fixtures) {
      if (e.src === 'user') continue;
      const b = f.fixtures.find((x) => x.id === e.id);
      if (!b || JSON.stringify(e) !== JSON.stringify(b)) n++;
    }
    return n;
  };
  const userCounts = () => ({
    w: DOC.walls.filter((e) => e.src === 'user').length,
    s: DOC.solids.filter((e) => e.src === 'user').length,
    d: DOC.doors.filter((e) => e.src === 'user').length,
    f: DOC.fixtures.filter((e) => e.src === 'user').length,
  });
  const pbReset = async () => {
    DOC.walls = DOC.walls.filter((e) => e.src !== 'user');
    DOC.solids = DOC.solids.filter((e) => e.src !== 'user');
    DOC.doors = DOC.doors.filter((e) => e.src !== 'user');
    DOC.fixtures = DOC.fixtures.filter((e) => e.src !== 'user');
    restoreBuiltins();
    wallEdit.sel = null;
    wallEdit.dEndSel = null;
    geoChanged();
    await tick();
  };
  const enterEdit = async () => {
    if (!wallEdit.on) {
      Q('#btnWallEdit').click();
      await tick();
    }
  };
  const setTool = async (t) => {
    await enterEdit();
    Q('#wtoolSeg button[data-t="' + t + '"]').click();
    await tick();
  };
  // 3D 重建是异步的（setView → init3D/buildStatic3D 在 setTimeout 里），要轮询
  const wait3D = async (maxTicks) => {
    for (let i = 0; i < (maxTicks || 40); i++) {
      if (three && three.staticGroup && !geoDirty3D) return true;
      await tick();
    }
    return false;
  };
  // 3D：从天花板上方垂直打射线（新构件在 pbFree 附近，周围没有别的构件）。
  // 起点必须在构件顶面之上：从构件内部起射会命中自己的底盖背面 → Raycaster 按
  // material.side 剔背面 → 「没有命中」假红。天花板 FrontSide 朝下 → 向下射线剔掉它的背面，
  // 不会先挡住构件顶面。
  const rayDown = (fx, fy, fromY) => {
    if (!three || !three.staticGroup) return null;
    three.staticGroup.updateMatrixWorld(true);
    const rc = new THREE.Raycaster();
    rc.set(new THREE.Vector3(fx, fromY == null ? CEIL_H + 1.5 : fromY, fy), new THREE.Vector3(0, -1, 0));
    const hits = rc.intersectObjects(three.staticGroup.children, true);
    return hits.length ? hits[0] : null;
  };
  const staticVerts = () => {
    let n = 0;
    if (!three || !three.staticGroup) return 0;
    three.staticGroup.traverse((o) => {
      if (o.isMesh && o.geometry && o.geometry.attributes && o.geometry.attributes.position)
        n += o.geometry.attributes.position.count;
    });
    return n;
  };

  try {
    /* ===== 0. 进入编辑模式：模式可见性 ===== */
    Q('#btnWallEdit').click();
    await tick();
    T('pb-edit-mode-on', wallEdit.on === true, 'on=' + wallEdit.on);
    T('pb-sidebar-lock', document.body.classList.contains('wall-editing'), 'body class');
    const pbBarR = Q('#wallbar').getBoundingClientRect();
    T(
      'pb-toolbar-visible',
      pbBarR.width >= 200 && pbBarR.height >= 20 && pbBarR.height <= 90,
      Math.round(pbBarR.width) + 'x' + Math.round(pbBarR.height)
    );
    T(
      'pb-tool-mode-visible',
      !!Q('#wtoolSeg button.on') || !!Q('#wtoolSeg button[aria-pressed="true"]'),
      'active=' + (Q('#wtoolSeg button.on') || Q('#wtoolSeg button[aria-pressed="true"]') || { dataset: {} }).dataset.t
    );
    I(
      'pb-plan-anchor',
      'bbox ' +
        BX0.toFixed(1) +
        ',' +
        BY0 +
        ' → ' +
        BX1.toFixed(1) +
        ',' +
        BY1.toFixed(1) +
        ' · free ' +
        pbFree[0].toFixed(2) +
        ',' +
        pbFree[1].toFixed(2) +
        ' (clear ' +
        pbFreeClear.toFixed(2) +
        'ft)'
    );

    /* ===== 1. 选中 / 命中 / 抖动点击不脏内置 ===== */
    const [whx, why] = SPT((pbWall.x1 + pbWall.x2) / 2, (pbWall.y1 + pbWall.y2) / 2);
    fire('pointermove', whx, why, { buttons: 0 });
    await tick();
    T('pb-hover-highlight', wallEdit.hoverSel != null, JSON.stringify(wallEdit.hoverSel));
    fire('pointerdown', whx, why);
    await tick();
    fire('pointermove', whx + 1, why + 1);
    await tick();
    fire('pointerup', whx + 1, why + 1);
    await tick();
    T('pb-select-wall', !!(wallEdit.sel && wallEdit.sel.kind === 'w'), JSON.stringify(wallEdit.sel));
    T('pb-jitter-click-no-dirty', builtinDirty() === 0, 'dirty=' + builtinDirty());
    T(
      'pb-selection-feedback',
      !!document.querySelector('#wedit polygon') && !!document.querySelector('#wedit text'),
      'polygon=' +
        document.querySelectorAll('#wedit polygon').length +
        ' text=' +
        document.querySelectorAll('#wedit text').length
    );
    await pbReset();

    /* ===== 2. 拖整段（Esc 回滚）/ 拖端点（生效） ===== */
    {
      const [ax, ay] = SPT((pbWall.x1 + pbWall.x2) / 2, (pbWall.y1 + pbWall.y2) / 2);
      fire('pointerdown', ax, ay);
      await tick();
      fire('pointermove', ax + 40, ay + 3);
      await tick();
      await tick();
      key('Escape');
      await tick();
      const sel = wallEdit.sel ? entById(wallEdit.sel.id) : null;
      const fr = sel ? pbFresh().walls.find((x) => x.id === sel.id) : null;
      T(
        'pb-drag-esc-rollback',
        !sel || !fr || JSON.stringify(sel.geom) === JSON.stringify(fr.geom),
        sel ? JSON.stringify(sel.geom) : 'null'
      );
      fire('pointerup', ax + 40, ay + 3);
      await tick();
      await pbReset();
      T('pb-reset-restores-builtin', builtinDirty() === 0 && userCounts().w === 0, 'dirty=' + builtinDirty());
      // 端点手柄：恒定屏幕尺寸
      await tap((pbWall.x1 + pbWall.x2) / 2, (pbWall.y1 + pbWall.y2) / 2);
      const h = document.querySelector('.wEnd');
      let epOK = false,
        epInfo = 'no handle';
      if (h) {
        const hr = h.getBoundingClientRect();
        epInfo = 'handle ' + Math.round(hr.width) + 'x' + Math.round(hr.height) + 'px';
        const d0 = builtinDirty();
        await dragBy(hr.x + hr.width / 2, hr.y + hr.height / 2, 30, 2);
        epOK = builtinDirty() > d0;
      }
      T('pb-drag-endpoint-works', epOK, epInfo + ' dirty=' + builtinDirty());
      await pbReset();
    }

    /* ===== 3. 画墙：右键不加点 / Backspace 撤点 / Enter 提交 ===== */
    {
      await setTool('wall');
      Q('#wType').value = 'w';
      const n0 = userCounts().w;
      const hitsBefore = document.querySelectorAll('#wedit .wHit').length;
      const [ax, ay] = SPT(pbFree[0], pbFree[1]);
      fire('pointerdown', ax, ay, { button: 2, buttons: 2 });
      await tick();
      T('pb-rightclick-no-point', wallEdit.drawPts.length === 0, wallEdit.drawPts.length);
      fire('pointerup', ax, ay, { button: 2, buttons: 0 });
      await tick();
      await tap(pbFree[0], pbFree[1]);
      await tap(pbFree[0] + 3, pbFree[1]);
      key('Backspace');
      await tick();
      T('pb-backspace-pops-point', wallEdit.drawPts.length === 1, wallEdit.drawPts.length);
      await tap(pbFree[0] + 3, pbFree[1]);
      const btnWall = Q('#wtoolSeg button[data-t="wall"]');
      btnWall.focus();
      key('Enter', btnWall);
      await tick();
      const n1 = userCounts().w;
      T('pb-enter-commits-wall', n1 === n0 + 1, 'userWalls ' + n0 + ' → ' + n1);
      const nw = DOC.walls.filter((e) => e.src === 'user').slice(-1)[0];
      T('pb-new-wall-kind', !!nw && nw.kind === 'wall', nw ? nw.kind : '-');
      const nl = nw ? Math.hypot(nw.geom.x2 - nw.geom.x1, nw.geom.y2 - nw.geom.y1) : 0;
      T('pb-new-wall-length-sane', nl > 1.5 && nl < 5, nl.toFixed(2) + 'ft（目标 3ft，吸附容差内）');
      // 新实体必须有命中区（否则选不中也删不掉 —— bug 猎 #9 的同类）
      drawWallEdit();
      await tick();
      const hitNow = document.querySelectorAll('#wedit .wHit').length;
      T('pb-new-wall-has-hit-region', hitNow > hitsBefore, 'wHit ' + hitsBefore + ' → ' + hitNow);
      await setTool('select');
      await tap((nw.geom.x1 + nw.geom.x2) / 2, (nw.geom.y1 + nw.geom.y2) / 2);
      T('pb-new-wall-reselect', !!(wallEdit.sel && wallEdit.sel.id === nw.id), JSON.stringify(wallEdit.sel));
      // Delete 删掉它
      const nBefore = DOC.walls.length;
      key('Delete');
      await tick();
      T('pb-delete-wall', DOC.walls.length === nBefore - 1 && userCounts().w === n0, 'n=' + DOC.walls.length);
      await pbReset();
    }

    /* ===== 4. 画柱（闭合多边形）→ 2D 命中 + 3D 立起来 ===== */
    {
      await setTool('poly');
      // 3D：柱必须立到顶（从上方打射线必须被挡住）
      // 基线顶点数要在画柱之前取（重建是异步的，画完再切 3D 时 vBefore 已经含新柱）
      setView('3d');
      await wait3D();
      const vBefore = staticVerts();
      setView('2d');
      await tick();
      await enterEdit();
      const s0 = userCounts().s;
      const c = pbFree,
        r = 0.9;
      const corners = [
        [c[0] - r, c[1] - r],
        [c[0] + r, c[1] - r],
        [c[0] + r, c[1] + r],
        [c[0] - r, c[1] + r],
      ];
      for (const p of corners) await tap(p[0], p[1]);
      await tap(corners[0][0], corners[0][1]); // 回到起点 = 闭合
      const s1 = userCounts().s;
      T('pb-poly-closes-solid', s1 === s0 + 1, 'userSolids ' + s0 + ' → ' + s1);
      const ns = DOC.solids.filter((e) => e.src === 'user').slice(-1)[0];
      drawWallEdit();
      await tick();
      const pHit = document.querySelectorAll('#wedit .pHit').length;
      T(
        'pb-new-solid-hittable',
        pHit >= 1 && !!(wallEdit.sel && wallEdit.sel.id === ns.id),
        'pHit=' + pHit + ' sel=' + JSON.stringify(wallEdit.sel)
      );
      // 3D：柱必须立到顶（从上方打射线必须被挡住）
      setView('3d');
      await wait3D();
      const hit = rayDown(c[0], c[1]);
      T(
        'pb-solid-in-3d',
        !!hit && Math.hypot(hit.point.x - c[0], hit.point.z - c[1]) < 1.2 && hit.point.y > 1.0,
        hit
          ? 'hit y=' + hit.point.y.toFixed(2) + ' dxz=' + Math.hypot(hit.point.x - c[0], hit.point.z - c[1]).toFixed(2)
          : '无射线命中（3D 里没有这根柱）'
      );
      T('pb-3d-vertex-grew', staticVerts() > vBefore, 'verts ' + vBefore + ' → ' + staticVerts());
      setView('2d');
      await tick();
      await enterEdit();
      await pbReset();
      setView('3d');
      await wait3D();
      const hitAfter = rayDown(c[0], c[1]);
      T(
        'pb-solid-removed-from-3d',
        !hitAfter || hitAfter.point.y < 1.0,
        hitAfter ? '仍命中 y=' + hitAfter.point.y.toFixed(2) : '干净'
      );
      setView('2d');
      await tick();
      await enterEdit();
    }

    /* ===== 5. 门系统：选中 / 款式 / 联动 / 调宽 / 方向键 ===== */
    {
      await setTool('door');
      const d0 = userCounts().d;
      await tap((pbDoor0.x1 + pbDoor0.x2) / 2, (pbDoor0.y1 + pbDoor0.y2) / 2);
      T(
        'pb-door-tool-selects-existing',
        !!(wallEdit.sel && wallEdit.sel.kind === 'door') && userCounts().d === d0,
        JSON.stringify(wallEdit.sel)
      );
      const dEnt = () => (wallEdit.sel && wallEdit.sel.kind === 'door' ? entById(wallEdit.sel.id) : null);
      const before = JSON.stringify(dEnt());
      await clickEl('#dKind');
      const kOK = dEnt() && dEnt().kind !== JSON.parse(before).kind;
      T('pb-door-kind-toggle', !!kOK, dEnt() ? dEnt().kind : '-');
      await clickEl('#dSide');
      const eNow = dEnt();
      const eFr = pbFresh().doors.find((x) => x.id === eNow.id);
      T(
        'pb-door-mutation-persists-to-doc',
        JSON.stringify(eNow) !== before && JSON.stringify(eNow) !== JSON.stringify(eFr),
        'kind=' + eNow.kind + ' side=' + eNow.side
      );
      await pbReset();

      // 整体滑动：门动 → 门垛联动。注意 door 工具点已有门是「选中后早退」（app.html
      // wallEditDown 的 tool==='door' 分支），拖移动只在 select 工具下成立。
      const ppf = pxPerFtNow();
      await setTool('select');
      const [dhx, dhy] = SPT((pbDoor0.x1 + pbDoor0.x2) / 2, (pbDoor0.y1 + pbDoor0.y2) / 2);
      await tap((pbDoor0.x1 + pbDoor0.x2) / 2, (pbDoor0.y1 + pbDoor0.y2) / 2);
      const dSelId = wallEdit.sel && wallEdit.sel.id;
      const g0 = dEnt() ? { ...dEnt().geom } : null;
      await dragBy(dhx, dhy, ppf * pbDoorU[0], ppf * pbDoorU[1]);
      const mv = dSelId ? entById(dSelId) : null;
      const moved = mv ? Math.hypot(mv.geom.x1 - g0.x1, mv.geom.y1 - g0.y1) : 0;
      T('pb-door-slide-follows-pointer', moved > 0.4 && moved < 1.7, 'moved ' + moved.toFixed(2) + 'ft（目标 1ft）');
      T('pb-door-slide-linkage', builtinDirty() >= 1, 'dirty=' + builtinDirty() + '（门 + 门垛/开口）');
      // Esc 中途回滚
      const g1 = { ...mv.geom };
      fire('pointerdown', dhx + ppf * pbDoorU[0], dhy + ppf * pbDoorU[1]);
      await tick();
      fire('pointermove', dhx + 2 * ppf * pbDoorU[0], dhy + 2 * ppf * pbDoorU[1]);
      await tick();
      await tick();
      key('Escape');
      await tick();
      fire('pointerup', dhx + 2 * ppf * pbDoorU[0], dhy + 2 * ppf * pbDoorU[1]);
      await tick();
      const mv2 = dSelId ? entById(dSelId) : null;
      T(
        'pb-door-esc-rollback',
        !!mv2 && Math.hypot(mv2.geom.x1 - g1.x1, mv2.geom.y1 - g1.y1) < 1e-6,
        mv2 ? mv2.geom.x1.toFixed(2) + ' vs ' + g1.x1.toFixed(2) : 'null'
      );
      await pbReset();

      // 拖端点调宽（+1ft，沿门轴方向）
      await tap((pbDoor0.x1 + pbDoor0.x2) / 2, (pbDoor0.y1 + pbDoor0.y2) / 2);
      const wBefore = Math.hypot(pbDoor0.x2 - pbDoor0.x1, pbDoor0.y2 - pbDoor0.y1);
      const ends = document.querySelectorAll('.dEnd');
      let wDrag = -1;
      if (ends.length >= 2) {
        const r2 = ends[1].getBoundingClientRect();
        await dragBy(r2.x + r2.width / 2, r2.y + r2.height / 2, ppf * pbDoorU[0], ppf * pbDoorU[1]);
        const dNow = dEnt();
        wDrag = dNow ? Math.hypot(dNow.geom.x2 - dNow.geom.x1, dNow.geom.y2 - dNow.geom.y1) : -1;
      }
      T(
        'pb-door-width-by-endpoint',
        wDrag > 0 && Math.abs(wDrag - (wBefore + 1)) < 0.5,
        wBefore.toFixed(2) + ' → ' + wDrag.toFixed(2) + 'ft（目标 ' + (wBefore + 1).toFixed(2) + '）'
      );
      await pbReset();

      // 数值改宽（cm）：铰链端固定，联动开口
      await tap((pbDoor0.x1 + pbDoor0.x2) / 2, (pbDoor0.y1 + pbDoor0.y2) / 2);
      const wIn = Q('#dWidth');
      T('pb-width-input-populated', !!wIn && +wIn.value > 0, wIn ? wIn.value + Q('#dwU').textContent : 'no input');
      {
        const b0 = dEnt(),
          bx1 = b0.geom.x1,
          by1 = b0.geom.y1,
          bw = Math.hypot(b0.geom.x2 - b0.geom.x1, b0.geom.y2 - b0.geom.y1);
        wIn.value = String(Math.round(bw * 30.48) + 20);
        wIn.dispatchEvent(new Event('change', { bubbles: true }));
        await tick();
        const a0 = dEnt(),
          aw = Math.hypot(a0.geom.x2 - a0.geom.x1, a0.geom.y2 - a0.geom.y1);
        T(
          'pb-width-input-applies',
          aw > bw + 0.1 && Math.abs(aw - (bw + 20 / 30.48)) < 0.25,
          (bw * 30.48).toFixed(0) + ' → ' + (aw * 30.48).toFixed(0) + 'cm（目标 ' + (bw * 30.48 + 20).toFixed(0) + '）'
        );
        T('pb-width-hinge-held', Math.hypot(a0.geom.x1 - bx1, a0.geom.y1 - by1) < 1e-6, '铰链端不动');
        T('pb-width-linkage', builtinDirty() >= 1, 'dirty=' + builtinDirty());
      }
      await pbReset();

      // 方向键微调的安全边界：内置门的门垛联动可能把 1cm 完全夹住（新垛 < STUB_MIN）。
      // 这里不断言「一定能动」，而是断言「无论哪个组合都不会夹出超过 1cm 的位移、
      // 也不会把门压到 DOOR_MIN 以下」——键盘与鼠标共用同一套 range 夹取（§5.1.1 第⑨轮）。
      await tap((pbDoor0.x1 + pbDoor0.x2) / 2, (pbDoor0.y1 + pbDoor0.y2) / 2);
      await clickEl('#dEndBtn');
      T(
        'pb-endpoint-select-btn',
        wallEdit.dEndSel === 0 && document.querySelectorAll('.dEnd').length === 2,
        'dEndSel=' + wallEdit.dEndSel
      );
      {
        let worst = 0,
          minW = 1e9,
          movedOnce = 0;
        // entById() 返回的是文档实体本身（不是快照），前后对比必须先取成数字
        const snap = () => {
          const e = dEnt();
          return { x1: e.geom.x1, y1: e.geom.y1, x2: e.geom.x2, y2: e.geom.y2 };
        };
        for (const endSel of [0, 1]) {
          let guard = 0;
          while (wallEdit.dEndSel !== endSel && guard++ < 4) await clickEl('#dEndBtn');
          for (const k of ['ArrowRight', 'ArrowLeft']) {
            const b = snap();
            const ei = endSel === 0 ? 'x1' : 'x2',
              ej = endSel === 0 ? 'y1' : 'y2';
            key(k);
            await tick();
            const a = snap();
            const dd = Math.hypot(a[ei] - b[ei], a[ej] - b[ej]);
            const w = Math.hypot(a.x2 - a.x1, a.y2 - a.y1);
            minW = Math.min(minW, w);
            worst = Math.max(worst, dd);
            if (Math.abs(dd - 1 / 30.48) < 1e-6) movedOnce = dd;
          }
        }
        T(
          'pb-door-nudge-clamp-safe',
          worst <= 1 / 30.48 + 1e-9 && minW >= DOOR_MIN - 1e-9,
          '最大位移 ' +
            (worst * 30.48).toFixed(2) +
            'cm ≤ 1cm · 最窄 ' +
            (minW * 30.48).toFixed(1) +
            'cm ≥ DOOR_MIN ' +
            (DOOR_MIN * 30.48).toFixed(0) +
            'cm'
        );
        I('pb-door-nudge-1cm-possible', movedOnce > 0 ? 'yes' : 'no（这份户型上这扇门 1cm 微调全被门垛夹住）');
      }
      while (wallEdit.dEndSel !== null) await clickEl('#dEndBtn');
      T('pb-endpoint-btn-cycles-off', wallEdit.dEndSel === null, String(wallEdit.dEndSel));
      await pbReset();

      // 关键回归：加门工具模式下也能拖端点（工具分支不得早退）
      await setTool('door');
      await tap((pbDoor0.x1 + pbDoor0.x2) / 2, (pbDoor0.y1 + pbDoor0.y2) / 2);
      {
        const ends2 = document.querySelectorAll('.dEnd');
        let ok = false,
          info = 'no .dEnd';
        if (ends2.length >= 2) {
          const r3 = ends2[1].getBoundingClientRect();
          const w0 = Math.hypot(dEnt().geom.x2 - dEnt().geom.x1, dEnt().geom.y2 - dEnt().geom.y1);
          await dragBy(r3.x + r3.width / 2, r3.y + r3.height / 2, ppf * pbDoorU[0], ppf * pbDoorU[1]);
          const w1 = Math.hypot(dEnt().geom.x2 - dEnt().geom.x1, dEnt().geom.y2 - dEnt().geom.y1);
          ok = Math.abs(w1 - (w0 + 1)) < 0.5;
          info = w0.toFixed(2) + ' → ' + w1.toFixed(2);
        }
        T('pb-endpoint-drag-in-door-tool', ok, info);
      }
      await pbReset();

      // 用户自己画开口 → 在开口上加门
      {
        await setTool('wall');
        Q('#wType').value = 'd';
        const dd0 = userCounts().d;
        await tap(pbFree[0] - 2, pbFree[1] + 2.5);
        await tap(pbFree[0] + 2, pbFree[1] + 2.5);
        key('Enter');
        await tick();
        const open = DOC.walls.filter((e) => e.src === 'user').slice(-1)[0];
        T('pb-user-opening-added', !!open && open.kind === 'opening', open ? open.kind : '-');
        await setTool('door');
        await tap((open.geom.x1 + open.geom.x2) / 2, (open.geom.y1 + open.geom.y2) / 2);
        T('pb-door-on-user-opening', userCounts().d === dd0 + 1, 'userDoors ' + dd0 + ' → ' + userCounts().d);
        // 用户门 + 用户开口 = 没有既有门垛约束 → 方向键微调在这里能逐厘米验证
        // （内置门的 1cm 微调常被 STUB_MIN 夹住，上面只断言安全边界）
        {
          const uDoor = () => entById(wallEdit.sel && wallEdit.sel.id);
          const u = uDoor();
          const uL = Math.hypot(u.geom.x2 - u.geom.x1, u.geom.y2 - u.geom.y1);
          const uU = [(u.geom.x2 - u.geom.x1) / uL, (u.geom.y2 - u.geom.y1) / uL];
          const e1 = document.querySelectorAll('.dEnd')[1];
          if (e1) {
            const rr = e1.getBoundingClientRect();
            await dragBy(rr.x + rr.width / 2, rr.y + rr.height / 2, -pxPerFtNow() * uU[0], -pxPerFtNow() * uU[1]);
          }
          const u2 = uDoor();
          const u2L = Math.hypot(u2.geom.x2 - u2.geom.x1, u2.geom.y2 - u2.geom.y1);
          T(
            'pb-user-door-shortened-leaves-slack',
            u2L < uL - 0.5 && u2L >= DOOR_MIN,
            uL.toFixed(2) + ' → ' + u2L.toFixed(2) + 'ft'
          );
          await clickEl('#dEndBtn');
          let guard2 = 0;
          while (wallEdit.dEndSel !== 1 && guard2++ < 4) await clickEl('#dEndBtn');
          T('pb-user-door-end-active', wallEdit.dEndSel === 1, String(wallEdit.dEndSel));
          const b4 = uDoor();
          const preX2 = b4.geom.x2,
            preY2 = b4.geom.y2;
          key('ArrowLeft');
          await tick();
          const a4 = uDoor();
          const dd4 = Math.hypot(a4.geom.x2 - preX2, a4.geom.y2 - preY2);
          T(
            'pb-arrow-moves-active-end-1cm',
            Math.abs(dd4 - 1 / 30.48) < 1e-6,
            '激活端动 ' + (dd4 * 30.48).toFixed(2) + 'cm'
          );
          while (wallEdit.dEndSel !== null) await clickEl('#dEndBtn');
          const b5 = uDoor(),
            b5m = [(b5.geom.x1 + b5.geom.x2) / 2, (b5.geom.y1 + b5.geom.y2) / 2],
            b5w = Math.hypot(b5.geom.x2 - b5.geom.x1, b5.geom.y2 - b5.geom.y1);
          key('ArrowRight', null, true);
          await tick();
          const a5 = uDoor(),
            md5 = Math.hypot((a5.geom.x1 + a5.geom.x2) / 2 - b5m[0], (a5.geom.y1 + a5.geom.y2) / 2 - b5m[1]),
            a5w = Math.hypot(a5.geom.x2 - a5.geom.x1, a5.geom.y2 - a5.geom.y1);
          T(
            'pb-arrow-shift-slides-whole-door',
            Math.abs(a5w - b5w) < 1e-6 && Math.abs(md5 - 5 / 30.48) < 1e-6,
            '宽不变 ' + a5w.toFixed(3) + ' · 中心动 ' + (md5 * 30.48).toFixed(2) + 'cm（Shift=5cm）'
          );
        }
        // 门在 3D 里存在：门洞上方有门洞过梁（t==='d' → wallMesh 高 CEIL_H-6.8）。
        // 从天花板上方往下打射线：天花板 FrontSide 朝下 → 背面被剔 → 第一个命中就是过梁顶。
        setView('3d');
        await wait3D();
        const dmid = (() => {
          const e = entById(wallEdit.sel && wallEdit.sel.id);
          return e ? [(e.geom.x1 + e.geom.x2) / 2, (e.geom.y1 + e.geom.y2) / 2] : null;
        })();
        const dhit = dmid ? rayDown(dmid[0], dmid[1]) : null;
        T(
          'pb-door-in-3d',
          !!dhit && dhit.point.y > 6.0 && Math.hypot(dhit.point.x - dmid[0], dhit.point.z - dmid[1]) < 1.0,
          dhit
            ? '过梁顶 y=' +
                dhit.point.y.toFixed(2) +
                ' dxz=' +
                Math.hypot(dhit.point.x - dmid[0], dhit.point.z - dmid[1]).toFixed(2)
            : '3D 里这个门洞没有过梁'
        );
        setView('2d');
        await tick();
        await enterEdit();
        await pbReset();
        // 方向键微调内置墙：1cm 逐厘米（墙不受门垛约束）
        {
          await setTool('select');
          await tap((pbWall.x1 + pbWall.x2) / 2, (pbWall.y1 + pbWall.y2) / 2);
          const w0 = entById(wallEdit.sel.id).geom;
          const wx0 = w0.x1,
            wy0 = w0.y1;
          key('ArrowRight');
          await tick();
          const w1 = entById(wallEdit.sel.id).geom;
          const dx1 = w1.x1 - wx0,
            dy1 = w1.y1 - wy0;
          key('ArrowUp');
          await tick();
          const w2 = entById(wallEdit.sel.id).geom;
          T(
            'pb-arrow-nudges-wall-1cm',
            Math.abs(dx1 - 1 / 30.48) < 1e-6 && Math.abs(dy1) < 1e-9 && Math.abs(w2.y1 - wy0 + 1 / 30.48) < 1e-6,
            'dx=' +
              (dx1 * 30.48).toFixed(2) +
              'cm dy=' +
              (dy1 * 30.48).toFixed(2) +
              'cm → 再上移 dy=' +
              ((w2.y1 - wy0) * 30.48).toFixed(2) +
              'cm'
          );
          await pbReset();
        }
      }
    }

    /* ===== 6. 洁具工具：放置 / 贴墙契约 / 拖动 / 微调 / 删除权限 ===== */
    {
      fit2DToContent();
      drawWallEdit();
      await tick();
      await setTool('fx');
      T(
        'pb-fx-tool-on',
        wallEdit.tool === 'fx' && vis('#fxCtl') === 'visible',
        'tool=' + wallEdit.tool + ' fxCtl=' + vis('#fxCtl')
      );
      const fxN = () => DOC.fixtures.length;
      const uFx = () => DOC.fixtures.filter((f) => f.src === 'user').length;
      const n0 = fxN(),
        u0 = uFx();
      // 自由放置（离已有几何最远的点 → 附近无墙 → 不吸附）
      Q('#fxType').value = 'toilet';
      await tap(pbFree[0], pbFree[1]);
      const placed = DOC.fixtures[DOC.fixtures.length - 1];
      const pcx = placed ? (placed.x1 + placed.x2) / 2 : 0,
        pcy = placed ? (placed.y1 + placed.y2) / 2 : 0;
      T(
        'pb-fx-place-float',
        fxN() === n0 + 1 &&
          uFx() === u0 + 1 &&
          !!placed &&
          placed.t === 'toilet' &&
          placed.src === 'user' &&
          placed.rot == null &&
          Math.hypot(pcx - pbFree[0], pcy - pbFree[1]) < 0.05,
        placed ? JSON.stringify(placed) : 'null'
      );
      T(
        'pb-fx-selected-after-place',
        !!(wallEdit.sel && wallEdit.sel.kind === 'fx' && wallEdit.sel.id === placed.id),
        JSON.stringify(wallEdit.sel)
      );
      // 贴墙契约：镜子吸附到最近实墙（长边平行、法向距离 = 墙半厚 + 件半深）
      Q('#fxType').value = 'mirror';
      {
        // 找一条内置墙，在它内侧 0.6ft 处点击；候选里选「离其它几何最远」的（避开已有洁具）
        let target = null,
          bestD = -1;
        for (const s of effWalls()) {
          if (s.t !== 'w' && s.t !== 'i') continue;
          const L = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
          if (L < 3) continue;
          const ux = (s.x2 - s.x1) / L,
            uy = (s.y2 - s.y1) / L;
          const mx = (s.x1 + s.x2) / 2,
            my = (s.y1 + s.y2) / 2;
          const cxm = (BX0 + BX1) / 2,
            cym = (BY0 + BY1) / 2;
          const sgn = Math.sign(cxm * -uy + cym * ux - (mx * -uy + my * ux)) || 1;
          for (const tt of [0.3, 0.5, 0.7]) {
            const px = s.x1 + ux * L * tt + -uy * sgn * 0.6,
              py = s.y1 + uy * L * tt + ux * sgn * 0.6;
            const cd = pbClearance(px, py);
            if (cd > bestD) {
              bestD = cd;
              target = { s, px, py };
            }
          }
        }
        let snapOK = false,
          snapInfo = 'no candidate wall';
        if (target) {
          await tap(target.px, target.py);
          const mir = DOC.fixtures[DOC.fixtures.length - 1];
          if (mir && mir.t === 'mirror') {
            const cxm2 = (mir.x1 + mir.x2) / 2,
              cym2 = (mir.y1 + mir.y2) / 2;
            const s = target.s,
              L = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
            const ux = (s.x2 - s.x1) / L,
              uy = (s.y2 - s.y1) / L;
            const tp = (cxm2 - s.x1) * ux + (cym2 - s.y1) * uy;
            const dWall = Math.hypot(cxm2 - (s.x1 + ux * tp), cym2 - (s.y1 + uy * tp));
            const docE = entById(s._id);
            const th = docE && docE.thick != null ? docE.thick : (s.wd || 6.5) / SC;
            const expect = (th + FX_DEFS.mirror.d) / 2;
            // rot 契约：长边（本地 x 轴）平行墙 → rot = 墙角归一到 [0,180) 后取整
            let wa = (Math.atan2(uy, ux) * 180) / Math.PI;
            wa = ((wa % 360) + 360) % 360;
            if (wa >= 180) wa -= 180;
            const rotOK = Math.abs((mir.rot || 0) - Math.round(wa)) < 0.6;
            // 尺寸契约：文档矩形 = FX_DEFS 的 w×d（哪个轴取决于 rot）
            const wx = Math.abs(mir.x2 - mir.x1),
              wy = Math.abs(mir.y2 - mir.y1);
            const dimOK =
              (Math.abs(wx - FX_DEFS.mirror.w) < 1e-6 && Math.abs(wy - FX_DEFS.mirror.d) < 1e-6) ||
              (Math.abs(wx - FX_DEFS.mirror.d) < 1e-6 && Math.abs(wy - FX_DEFS.mirror.w) < 1e-6);
            snapOK = rotOK && dWall > 0.05 && Math.abs(dWall - expect) < 0.05 && dimOK;
            snapInfo =
              'wall=' +
              s._id +
              ' 墙角=' +
              wa.toFixed(1) +
              ' rot=' +
              (mir.rot || 0) +
              ' dWall=' +
              dWall.toFixed(3) +
              ' expect=' +
              expect.toFixed(3) +
              ' rect=' +
              wx.toFixed(2) +
              'x' +
              wy.toFixed(2);
          }
        }
        T('pb-fx-wall-snap-contract', snapOK, snapInfo);
      }
      // 拖移（位移 = 屏幕位移 / pxPerFt）
      {
        const fT = DOC.fixtures.filter((f) => f.t === 'toilet' && f.src === 'user')[0];
        const c0 = [(fT.x1 + fT.x2) / 2, (fT.y1 + fT.y2) / 2];
        const [tx, ty] = SPT(c0[0], c0[1]);
        const ppf2 = pxPerFtNow();
        await dragBy(tx, ty, 30, 20);
        const c1 = [(fT.x1 + fT.x2) / 2, (fT.y1 + fT.y2) / 2];
        const err = Math.hypot(c1[0] - c0[0] - 30 / ppf2, c1[1] - c0[1] - 20 / ppf2);
        T(
          'pb-fx-drag-matches-pointer',
          err < 0.1 && Math.hypot(c1[0] - c0[0], c1[1] - c0[1]) > 0.5,
          'd=(' + (c1[0] - c0[0]).toFixed(2) + ',' + (c1[1] - c0[0] - 0).toFixed(2) + ') err=' + err.toFixed(3)
        );
        // Esc 回滚
        fire('pointerdown', tx, ty);
        await tick();
        fire('pointermove', tx - 25, ty);
        await tick();
        await tick();
        key('Escape');
        await tick();
        fire('pointerup', tx - 25, ty);
        await tick();
        const c2 = [(fT.x1 + fT.x2) / 2, (fT.y1 + fT.y2) / 2];
        T(
          'pb-fx-esc-rollback',
          Math.hypot(c2[0] - c1[0], c2[1] - c1[1]) < 1e-6,
          'd=' + Math.hypot(c2[0] - c1[0], c2[1] - c1[1]).toExponential(1)
        );
        // 旋转输入
        const fxR = Q('#fxRot');
        fxR.value = '45';
        fxR.dispatchEvent(new Event('change'));
        await tick();
        T(
          'pb-fx-rot-input',
          fT.rot === 45 && !!document.querySelector('#wedit g[transform*="rotate(45"]'),
          'rot=' + fT.rot
        );
        // 方向键微调 1cm
        const fx0x = fT.x1;
        key('ArrowRight');
        await tick();
        T(
          'pb-fx-arrow-nudge-1cm',
          Math.abs(fT.x1 - fx0x - 1 / 30.48) < 0.002,
          'dx=' + (fT.x1 - fx0x).toFixed(4) + 'ft'
        );
        // 内置洁具：抖动点击不脏、Delete 拒删
        if (pbFx0) {
          const bBefore = JSON.stringify(pbFx0);
          const [jx, jy] = SPT((pbFx0.x1 + pbFx0.x2) / 2, (pbFx0.y1 + pbFx0.y2) / 2);
          fire('pointerdown', jx, jy);
          await tick();
          fire('pointermove', jx + 1, jy + 1);
          await tick();
          fire('pointerup', jx + 1, jy + 1);
          await tick();
          T('pb-fx-builtin-jitter-no-dirty', JSON.stringify(pbFx0) === bBefore, JSON.stringify(pbFx0).slice(0, 46));
          const nB = DOC.fixtures.length;
          wallEdit.sel = { kind: 'fx', id: pbFx0.id };
          updateWallBarFromSel();
          key('Delete');
          await tick();
          T(
            'pb-fx-builtin-not-deletable',
            DOC.fixtures.length === nB && JSON.stringify(pbFx0) === bBefore,
            'n=' + DOC.fixtures.length
          );
        } else I('pb-fx-builtin-not-deletable', 'NA（这份户型没有内置洁具）');
        // 用户洁具可删
        {
          const nC = DOC.fixtures.length,
            uC = uFx();
          wallEdit.sel = { kind: 'fx', id: fT.id };
          updateWallBarFromSel();
          key('Delete');
          await tick();
          T(
            'pb-fx-user-deletable',
            DOC.fixtures.length === nC - 1 && uFx() === uC - 1,
            'n=' + DOC.fixtures.length + ' user=' + uFx()
          );
        }
      }
      await pbReset();
      T(
        'pb-fx-cleanup',
        DOC.fixtures.length === n0 && uFx() === 0 && builtinDirty() === 0,
        'n=' + DOC.fixtures.length + ' user=' + uFx() + ' dirty=' + builtinDirty()
      );
    }

    /* ===== 7. 编辑 → 3D 一致性：新墙在 3D 里立起来 ===== */
    {
      setView('3d');
      await wait3D();
      const g1 = three && three.staticGroup;
      const v0 = staticVerts();
      setView('2d');
      await tick();
      await enterEdit();
      pushUserWall(pbFree[0] - 2, pbFree[1] - 2.5, pbFree[0] + 2, pbFree[1] - 2.5, 'w', 8);
      geoChanged();
      await tick();
      setView('3d');
      await wait3D();
      T('pb-3d-rebuilds-after-edit', three.staticGroup !== g1, 'staticGroup 换了对象 = 重建');
      const hit = rayDown(pbFree[0], pbFree[1] - 2.5);
      T(
        'pb-new-wall-in-3d',
        !!hit && hit.point.y > 1.0 && Math.hypot(hit.point.x - pbFree[0], hit.point.z - (pbFree[1] - 2.5)) < 1.0,
        hit ? 'y=' + hit.point.y.toFixed(2) : '3D 里没有这段新墙'
      );
      T('pb-3d-verts-increase', staticVerts() > v0, 'verts ' + v0 + ' → ' + staticVerts());
      setView('2d');
      await tick();
      await enterEdit();
      await pbReset();
    }

    /* ===== 8. 导入后编辑（合成 fixture，无个人数据） ===== */
    {
      const nPristine = window.MINIDEN.Migrate.docToLegacy(pbFresh()).walls.length;
      const nFxBuilt = effFixtures().length;
      T(
        'pb-import-libs',
        !!(window.DxfParser && window.MINIDEN_GEO && typeof window.MINIDEN_GEO.importDxf === 'function'),
        'DxfParser=' + !!window.DxfParser + ' GEO=' + !!window.MINIDEN_GEO
      );
      let imp = null,
        impErr = '';
      try {
        const txt = await (await fetch('../tests/fixtures/apartment-mm.dxf')).text();
        imp = window.MINIDEN_GEO.importDxf(new window.DxfParser().parseSync(txt), { name: 'planbuild' });
      } catch (e) {
        impErr = e.message;
      }
      T(
        'pb-import-parses',
        !!imp && imp.doc.walls.length > 3 && imp.doc.doors.length >= 1,
        impErr || (imp ? JSON.stringify(imp.info.counts) : 'null')
      );
      if (imp) {
        applyImportedDoc(imp.doc, imp.info);
        await tick();
        fit2DToContent();
        drawWallEdit();
        await tick();
        T(
          'pb-import-applied',
          DOC.imported === true && effWalls().length > 3 && effDoors().length >= 1,
          'imported=' +
            DOC.imported +
            ' walls=' +
            effWalls().length +
            ' doors=' +
            effDoors().length +
            ' fx=' +
            effFixtures().length
        );
        T('pb-import-clears-furniture', state.items.length === 0, 'items=' + state.items.length);
        T(
          'pb-import-fixtures-empty',
          effFixtures().length === 0,
          'fx=' + effFixtures().length + '（内置洁具属于内置户型，导入后不该留下）'
        );
        // 导入的实体必须可选中（entById 前缀映射覆盖导入管线）
        await enterEdit();
        const iw = effWalls().filter((s) => s.t === 'w')[0];
        await tap((iw.x1 + iw.x2) / 2, (iw.y1 + iw.y2) / 2);
        const selI = wallEdit.sel;
        T('pb-imported-wall-selectable', !!(selI && selI.kind === 'w'), JSON.stringify(selI));
        T('pb-imported-wall-is-user-sourced', !!(selI && srcU(selI.id)), 'srcU=' + !!(selI && srcU(selI.id)));
        // 选中后能改：拖端点
        {
          const ends = document.querySelectorAll('.wEnd');
          let ok = false,
            info = 'no .wEnd';
          if (ends.length) {
            const ent0 = { ...entById(selI.id).geom };
            const r4 = ends[0].getBoundingClientRect();
            await dragBy(r4.x + r4.width / 2, r4.y + r4.height / 2, 25, 0);
            const ent1 = entById(selI.id).geom;
            ok = Math.hypot(ent1.x1 - ent0.x1, ent1.y1 - ent0.y1) > 0.2;
            info = ent0.x1.toFixed(2) + ' → ' + ent1.x1.toFixed(2);
          }
          T('pb-imported-wall-editable', ok, info);
        }
        // 导入户型上放洁具（贴墙契约同样成立）
        {
          await setTool('fx');
          Q('#fxType').value = 'counter';
          const f0 = effFixtures().length;
          const c = [(BX0 + BX1) / 2, (BY0 + BY1) / 2];
          await tap(c[0], c[1]);
          T(
            'pb-imported-plan-fixture-place',
            effFixtures().length === f0 + 1,
            'fx ' + f0 + ' → ' + effFixtures().length
          );
          const nf = DOC.fixtures[DOC.fixtures.length - 1];
          wallEdit.sel = { kind: 'fx', id: nf.id };
          updateWallBarFromSel();
          key('Delete');
          await tick();
          T('pb-imported-plan-fixture-delete', effFixtures().length === f0, 'fx=' + effFixtures().length);
        }
        // 3D 读得到导入户型
        setView('3d');
        await wait3D();
        T(
          'pb-imported-3d-builds',
          !!(three && three.staticGroup) && three.staticGroup.children.length > 5,
          three && three.staticGroup ? 'children=' + three.staticGroup.children.length : 'no group'
        );
        setView('2d');
        await tick();
        // E26：导入新建了一份户型并切过去 → 「回到内置」要走真实的切换路径。
        // 原先这里用 resetDoc()+saveGeo()：那是把内置几何写进**导入户型的键**，
        // 把刚导入的那份抹掉。现在两份都在，切回去就行。
        const importedId = PLAN_ID;
        T(
          'pb-import-new-plan-entry',
          PLANS.hasPlan(PLAN_REG, importedId) && importedId !== BUILTIN_PLAN_ID,
          'plans=' + PLAN_REG.plans.length + ' active=' + (PLAN_ID === BUILTIN_PLAN_ID ? '内置' : '导入')
        );
        switchPlan(BUILTIN_PLAN_ID, true);
        await tick();
        if (wallEdit.on) drawWallEdit();
        await tick();
        T(
          'pb-import-restore-builtin',
          !DOC.imported && effWalls().length === nPristine && effFixtures().length === nFxBuilt,
          'walls=' + effWalls().length + '/' + nPristine + ' fx=' + effFixtures().length + '/' + nFxBuilt
        );
        T(
          'pb-import-keys-separate',
          PLANS.docKeyFor(importedId) !== PLANS.docKeyFor(BUILTIN_PLAN_ID) &&
            DOC_KEY === PLANS.docKeyFor(BUILTIN_PLAN_ID),
          'DOC_KEY 跟着当前户型走'
        );
      }
    }

    /* ===== 9. 持久化：编辑写进文档、读回一致 ===== */
    {
      await enterEdit();
      pushUserWall(pbFree[0] - 1.5, pbFree[1] + 1.5, pbFree[0] + 1.5, pbFree[1] + 1.5, 'w', 8);
      geoChanged();
      saveGeo();
      await tick();
      const raw = STORE.get(DOC_KEY);
      T('pb-save-roundtrip', !!raw && raw === JSON.stringify(DOC), raw ? 'len=' + raw.length : '没有写进主存');
      const back = JSON.parse(raw);
      const uw = back.walls.filter((e) => e.src === 'user');
      T('pb-saved-user-wall-count', uw.length >= 1, 'userWalls in doc=' + uw.length);
      await pbReset();
      saveGeo();
      await tick();
      const raw2 = STORE.get(DOC_KEY);
      T(
        'pb-reset-persisted',
        !!raw2 && JSON.parse(raw2).walls.filter((e) => e.src === 'user').length === 0,
        'user=' + JSON.parse(raw2).walls.filter((e) => e.src === 'user').length
      );
    }

    /* ===== 10. E23 撤销 / 重做（快照环） ===== */
    {
      const ckey = (sh) =>
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'z',
            ctrlKey: true,
            shiftKey: !!sh,
            bubbles: true,
            cancelable: true,
          })
        );
      const clearRing = () => {
        undoRing.length = 0;
        redoRing.length = 0;
        lastGesture = null;
        updateUndoUI();
      };
      await pbReset();
      clearRing();
      T(
        'pb-undo-empty-disabled',
        Q('#btnUndo').disabled === true && Q('#btnRedo').disabled === true,
        'undo.disabled=' + Q('#btnUndo').disabled + ' redo.disabled=' + Q('#btnRedo').disabled
      );

      // 画墙 → 撤销 → 重做
      await setTool('wall');
      const nW0 = DOC.walls.length;
      await tap(pbFree[0], pbFree[1]);
      await tap(pbFree[0] + 3, pbFree[1]);
      await tap(pbFree[0] + 3, pbFree[1]);
      T('pb-undo-wall-added', DOC.walls.length === nW0 + 1, 'walls ' + nW0 + ' → ' + DOC.walls.length);
      T('pb-undo-btn-enabled', Q('#btnUndo').disabled === false, 'disabled=' + Q('#btnUndo').disabled);
      ckey(false);
      await tick();
      T('pb-undo-wall-removed', DOC.walls.length === nW0, 'walls=' + DOC.walls.length);
      T('pb-undo-redo-enabled', Q('#btnRedo').disabled === false, 'disabled=' + Q('#btnRedo').disabled);
      ckey(true);
      await tick();
      T('pb-redo-wall-back', DOC.walls.length === nW0 + 1, 'walls=' + DOC.walls.length);
      ckey(false);
      await tick();
      T(
        'pb-undo-storage-matches-doc',
        STORE.get(DOC_KEY) === JSON.stringify(DOC),
        '主存 len=' + (STORE.get(DOC_KEY) || '').length
      );

      // 放洁具 → 撤销
      await setTool('fx');
      Q('#fxType').value = 'toilet';
      const nFx0 = DOC.fixtures.length;
      await tap(pbFree[0], pbFree[1]);
      T('pb-undo-fx-added', DOC.fixtures.length === nFx0 + 1, 'fx ' + nFx0 + ' → ' + DOC.fixtures.length);
      ckey(false);
      await tick();
      T('pb-undo-fx-removed', DOC.fixtures.length === nFx0, 'fx=' + DOC.fixtures.length);

      // 删用户墙 → 撤销（实体要能回来，id 不变）
      await setTool('select');
      const uw = pushUserWall(pbFree[0] - 1.5, pbFree[1] + 1.5, pbFree[0] + 1.5, pbFree[1] + 1.5, 'w', 8);
      geoChanged();
      await tick();
      const nW1 = DOC.walls.length;
      wallEdit.sel = { kind: 'w', id: uw.id };
      updateWallBarFromSel();
      key('Delete');
      await tick();
      T('pb-undo-del-wall', DOC.walls.length === nW1 - 1, 'walls ' + nW1 + ' → ' + DOC.walls.length);
      ckey(false);
      await tick();
      T(
        'pb-undo-restore-deleted-wall',
        DOC.walls.length === nW1 && !!entById(uw.id),
        'walls=' + DOC.walls.length + ' ent=' + !!entById(uw.id)
      );

      // 拖端点 → 撤销（位置逐位回到拖之前）
      {
        fit2DToContent(); // 前面几段可能把视图放大/平移过：手柄可能在视口外 → elementFromPoint 打空
        await tick();
        const e0 = { ...entById(uw.id).geom };
        wallEdit.sel = { kind: 'w', id: uw.id };
        updateWallBarFromSel();
        drawWallEdit(); // 手柄是 drawWallEdit 画的：只设 sel 不会有 .wEnd
        await tick();
        const ends = document.querySelectorAll('.wEnd');
        if (ends.length) {
          const r4 = ends[0].getBoundingClientRect();
          await dragBy(r4.x + r4.width / 2, r4.y + r4.height / 2, 30, 0);
          const e1 = { ...entById(uw.id).geom };
          const moved = Math.hypot(e1.x1 - e0.x1, e1.y1 - e0.y1);
          T('pb-undo-drag-moved', moved > 0.2, 'moved=' + moved.toFixed(2) + 'ft');
          ckey(false);
          await tick();
          const e2 = { ...entById(uw.id).geom };
          T(
            'pb-undo-drag-restored',
            Math.hypot(e2.x1 - e0.x1, e2.y1 - e0.y1) < 0.02 && Math.hypot(e2.x2 - e0.x2, e2.y2 - e0.y2) < 0.02,
            '回位偏差 ' + Math.hypot(e2.x1 - e0.x1, e2.y1 - e0.y1).toFixed(4) + 'ft'
          );
        } else T('pb-undo-drag-moved', false, '选中后没有 .wEnd 手柄');
      }

      // 连续方向键微调 = 一步撤销（节流契约：手势键相同不重复压环）
      {
        const e0 = { ...entById(uw.id).geom };
        wallEdit.sel = { kind: 'w', id: uw.id };
        updateWallBarFromSel();
        await tick();
        const ringBefore = undoRing.length;
        key('ArrowRight');
        await tick();
        key('ArrowRight');
        await tick();
        key('ArrowRight');
        await tick();
        const e1 = { ...entById(uw.id).geom };
        const moved = Math.hypot(e1.x1 - e0.x1, e1.y1 - e0.y1);
        T('pb-undo-nudge-moved', moved > 0.05 && moved < 0.15, '3×1cm 位移=' + moved.toFixed(3) + 'ft');
        T(
          'pb-undo-nudge-coalesces',
          undoRing.length === ringBefore + 1,
          '3 次微调只压 1 步：ring ' + ringBefore + ' → ' + undoRing.length
        );
        ckey(false);
        await tick();
        const e2 = { ...entById(uw.id).geom };
        T(
          'pb-undo-nudge-one-step',
          Math.hypot(e2.x1 - e0.x1, e2.y1 - e0.y1) < 0.01 && undoRing.length === ringBefore,
          '一步回到微调前；ring ' + undoRing.length
        );
      }

      // 家具也进环
      {
        const nIt = state.items.length;
        addItem(CATALOG[0].id);
        await tick();
        T('pb-undo-item-added', state.items.length === nIt + 1, 'items ' + nIt + ' → ' + state.items.length);
        ckey(false);
        await tick();
        T('pb-undo-item-removed', state.items.length === nIt, 'items=' + state.items.length);
      }

      // 导入整份替换也能退回去（用户最怕的一步）
      {
        const itemsBefore = state.items.length;
        const nBefore = DOC.walls.length;
        const wasImported = DOC.imported;
        const txt = await (await fetch('../tests/fixtures/apartment-mm.dxf')).text();
        const imp = window.MINIDEN_GEO.importDxf(new window.DxfParser().parseSync(txt), { name: 'pb-undo' });
        applyImportedDoc(imp.doc, imp.info);
        await tick();
        T(
          'pb-undo-import-applied',
          DOC.imported === true && DOC.walls.length !== nBefore,
          'imported=' + DOC.imported + ' walls=' + DOC.walls.length
        );
        ckey(false);
        await tick();
        T(
          'pb-undo-import-reverted',
          DOC.imported === wasImported && DOC.walls.length === nBefore && state.items.length === itemsBefore,
          'imported=' +
            DOC.imported +
            ' walls=' +
            DOC.walls.length +
            '/' +
            nBefore +
            ' items=' +
            state.items.length +
            '/' +
            itemsBefore
        );
      }

      // 改门宽（联动门垓 = 最难写逆操作的一步）→ 撤销：门与周围墙都要逐位回去
      {
        const dsel = pbDoor0;
        if (dsel) {
          fit2DToContent();
          await tick();
          wallEdit.sel = { kind: 'door', id: dsel._id };
          wallEdit.dEndSel = null;
          updateWallBarFromSel();
          drawWallEdit();
          await tick();
          const snapDoors = () => effDoors().map((d) => [d._id, d.x1, d.y1, d.x2, d.y2]);
          const snapWalls = () => effWalls().map((s) => [s._id, s.x1, s.y1, s.x2, s.y2]);
          const dBefore = snapDoors(),
            wBefore = snapWalls();
          Q('#dWidth').value = doorLenToUI(pbDoorLen + 0.5);
          Q('#dWidth').dispatchEvent(new Event('change'));
          await tick();
          const dNow = effDoors().find((d) => d._id === dsel._id);
          const Lnow = dNow ? Math.hypot(dNow.x2 - dNow.x1, dNow.y2 - dNow.y1) : 0;
          T(
            'pb-undo-door-width-changed',
            Math.abs(Lnow - pbDoorLen) > 0.1,
            '门宽 ' + pbDoorLen.toFixed(2) + ' → ' + Lnow.toFixed(2) + 'ft'
          );
          ckey(false);
          await tick();
          const dAfter = snapDoors(),
            wAfter = snapWalls();
          const same =
            JSON.stringify(dAfter) === JSON.stringify(dBefore) && JSON.stringify(wAfter) === JSON.stringify(wBefore);
          T(
            'pb-undo-door-width-restored',
            same,
            '门 ' + dAfter.length + ' 扇 + 墙 ' + wAfter.length + ' 段逐位回到改前'
          );
        } else T('pb-undo-door-width-changed', false, '没有可选门');
      }

      // 容量上限（不会无限长）
      {
        clearRing();
        for (let i = 0; i < 60; i++) {
          pushUndo(); // 模拟 60 次独立用户操作（pushUserWall 本身不进环，环在操作入口压）
          pushUserWall(pbFree[0], pbFree[1] + 2 + i * 0.02, pbFree[0] + 0.5, pbFree[1] + 2 + i * 0.02, 'w', 8);
          geoChanged();
        }
        T('pb-undo-cap', undoRing.length === UNDO_CAP, 'ring=' + undoRing.length + ' cap=' + UNDO_CAP);
      }

      await pbReset();
      clearRing();
      T('pb-undo-clean-exit', DOC.walls.filter((e) => e.src === 'user').length === 0 && undoRing.length === 0);
    }

    /* ===== 11. E24 数值改这段长度 + 按已知长度重标定整图 ===== */
    {
      await pbReset();
      await enterEdit();
      await setTool('select');
      fit2DToContent();
      await tick();
      const ctrlZ = () =>
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })
        );
      const lenOf = (seg) => (seg ? Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1) : -1);
      // 挑一段「干净」的墙：够长、中点离其它几何最远（点击不会被别的构件抢走）
      const pickWall = () => {
        let best = null,
          bs = -1;
        for (const s of effWalls()) {
          if (s.t !== 'w') continue;
          const L = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
          if (L < 2 || L > 14) continue;
          const mx = (s.x1 + s.x2) / 2,
            my = (s.y1 + s.y2) / 2;
          let d = pbClearance(mx, my);
          for (const dd of effDoors()) d = Math.min(d, distSeg(mx, my, dd));
          if (d > bs) {
            bs = d;
            best = { id: s._id, L, mx, my };
          }
        }
        return best;
      };
      const w0 = pickWall();
      if (!w0) T('pb-len-prefill', false, '找不到可测的墙段');
      else {
        await tap(w0.mx, w0.my);
        const sel = wallEdit.sel;
        const L0 = lenOf(selWallSeg());
        T('pb-len-select', !!(sel && sel.kind === 'w' && sel.id === w0.id), JSON.stringify(sel));
        T(
          'pb-len-prefill',
          Q('#wLen').disabled === false && Math.abs(+Q('#wLen').value - Math.round(L0 * 30.48)) <= 1,
          'input=' + Q('#wLen').value + 'cm 实际=' + L0.toFixed(2) + 'ft'
        );
        T(
          'pb-cal-disabled-builtin',
          Q('#calBtn').disabled === true,
          '内置户型不该能整图缩放 disabled=' + Q('#calBtn').disabled
        );
        // 工具条不得溢出（溢出 = 末尾控件被 overflow:hidden 剪掉），且编辑提示必须在画布里看得见
        {
          const bar = Q('#wallbar');
          const over = bar.scrollWidth - bar.clientWidth;
          T('pb-bar-no-overflow', over <= 1, 'scrollWidth=' + bar.scrollWidth + ' clientWidth=' + bar.clientWidth);
          const m = Q('#wMsg'),
            mr = m.getBoundingClientRect();
          const hint = Q('#hint');
          T(
            'pb-edit-hint-visible',
            mr.width >= 120 &&
              mr.height >= 14 &&
              mr.left >= 0 &&
              mr.right <= innerWidth &&
              mr.bottom <= innerHeight &&
              getComputedStyle(hint).display === 'none' &&
              m.textContent.length > 10,
            'wMsg=' + Math.round(mr.width) + 'x' + Math.round(mr.height) + ' hint=' + getComputedStyle(hint).display
          );
        }
        // 改这段：+2ft，起点必须不动（等价于拖终点）
        const live = selWallSeg();
        const x1b = live.x1,
          y1b = live.y1;
        const target = L0 + 2;
        Q('#wLen').value = String(Math.round(target * 30.48));
        Q('#wLenApply').click();
        await tick();
        const a = selWallSeg();
        const La = lenOf(a);
        const sameStart = !!a && Math.abs(a.x1 - x1b) < 0.011 && Math.abs(a.y1 - y1b) < 0.011;
        T(
          'pb-len-apply-wall',
          Math.abs(La - target) < 0.02 && sameStart,
          'len=' + La.toFixed(3) + 'ft 目标=' + target.toFixed(3) + ' 起点不动=' + sameStart
        );
        ctrlZ();
        await tick();
        // 撤销会清空选中（快照里的实体可能已不存在）→ 重新选中同一段
        await tap(w0.mx, w0.my);
        T('pb-len-undo', Math.abs(lenOf(selWallSeg()) - L0) < 0.011, 'len=' + lenOf(selWallSeg()).toFixed(3));
        // 下限：数值路径不能造出画墙时会被跳过的碎片段
        {
          const b = selWallSeg();
          const bx1 = b.x1,
            by1 = b.y1,
            bx2 = b.x2,
            by2 = b.y2;
          Q('#wLen').value = '1';
          Q('#wLenApply').click();
          await tick();
          const a2 = selWallSeg();
          const kept =
            !!a2 &&
            Math.abs(a2.x1 - bx1) < 1e-6 &&
            Math.abs(a2.y1 - by1) < 1e-6 &&
            Math.abs(a2.x2 - bx2) < 1e-6 &&
            Math.abs(a2.y2 - by2) < 1e-6;
          const msg2 = (Q('#wMsg') || {}).textContent || '';
          T(
            'pb-len-guard-min',
            kept && /\u592a\u77ed/.test(msg2),
            '\u51e0\u4f55\u4e0d\u53d8=' + kept + ' \u63d0\u793a=' + JSON.stringify(msg2.slice(0, 40))
          );
        }
      }
      // 挂在段上的门/窗不许被甩出去：缩到 10cm 必须被拒并且几何不变
      {
        let done = false,
          gi = '没有门完整落在任何墙段内部';
        for (const d of effDoors()) {
          if (done) break;
          for (const s of effWalls()) {
            if (s.t !== 'w') continue;
            const seg = { x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 };
            const t1 = ptOnSeg(d.x1, d.y1, seg, 0.06),
              t2 = ptOnSeg(d.x2, d.y2, seg, 0.06);
            if (t1 < 0 || t2 < 0) continue;
            const L = Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1);
            // 点墙上离门最远的位置，才选得中墙而不是门
            let bt = 0.5,
              bd = -1;
            for (let t = 0.12; t <= 0.88; t += 0.08) {
              const px = seg.x1 + (seg.x2 - seg.x1) * t,
                py = seg.y1 + (seg.y2 - seg.y1) * t;
              const dd = Math.min(Math.hypot(px - d.x1, py - d.y1), Math.hypot(px - d.x2, py - d.y2));
              if (dd > bd) {
                bd = dd;
                bt = t;
              }
            }
            await tap(seg.x1 + (seg.x2 - seg.x1) * bt, seg.y1 + (seg.y2 - seg.y1) * bt);
            const sel = wallEdit.sel;
            if (!sel || sel.kind !== 'w' || sel.id !== s._id) {
              gi = '选不中这段墙（选中=' + JSON.stringify(sel) + '）';
              break;
            }
            const before = selWallSeg();
            const bx1 = before.x1,
              by1 = before.y1,
              bx2 = before.x2,
              by2 = before.y2;
            Q('#wLen').value = '10';
            Q('#wLenApply').click();
            await tick();
            const after = selWallSeg();
            const unchanged =
              !!after &&
              Math.abs(after.x1 - bx1) < 1e-6 &&
              Math.abs(after.y1 - by1) < 1e-6 &&
              Math.abs(after.x2 - bx2) < 1e-6 &&
              Math.abs(after.y2 - by2) < 1e-6;
            const msg = (Q('#wMsg') || {}).textContent || '';
            T(
              'pb-len-guard-attached',
              unchanged && /门|窗/.test(msg),
              '几何不变=' + unchanged + ' 提示=' + JSON.stringify(msg.slice(0, 46)) + ' 段长=' + L.toFixed(2)
            );
            done = true;
            break;
          }
        }
        if (!done) I('pb-len-guard-attached-skipped', gi);
      }
      // 导入户型：整图按此缩放（两步确认 + 可撤销）
      let imp = null,
        impErr = '';
      try {
        const txt = await (await fetch('../tests/fixtures/apartment-mm.dxf')).text();
        imp = window.MINIDEN_GEO.importDxf(new window.DxfParser().parseSync(txt), { name: 'planbuild-cal' });
      } catch (e) {
        impErr = e.message;
      }
      if (!imp) T('pb-cal-import', false, impErr);
      else {
        applyImportedDoc(imp.doc, imp.info);
        await tick();
        fit2DToContent();
        drawWallEdit();
        await tick();
        await enterEdit();
        await setTool('select');
        const byLen = (a, b) => Math.hypot(b.x2 - b.x1, b.y2 - b.y1) - Math.hypot(a.x2 - a.x1, a.y2 - a.y1);
        const iw = effWalls()
          .filter((s) => s.t === 'w')
          .sort(byLen)[0];
        await tap((iw.x1 + iw.x2) / 2, (iw.y1 + iw.y2) / 2);
        const L0 = lenOf(selWallSeg());
        T('pb-cal-select', L0 > 0.5, '选中导入墙段 len=' + L0.toFixed(2) + 'ft');
        T('pb-cal-enabled-imported', Q('#calBtn').disabled === false, 'disabled=' + Q('#calBtn').disabled);
        const nW = DOC.walls.length,
          nD = DOC.doors.length,
          nS = DOC.solids.length;
        const spanOf = () => {
          // 几何包络（不是地板轮廓：importedFloorPts 给地板加固定 0.8ft 边距，不随缩放变）
          let a = 1e9,
            b = -1e9;
          for (const w of effWalls()) {
            a = Math.min(a, w.x1, w.x2);
            b = Math.max(b, w.x1, w.x2);
          }
          for (const d of effDoors()) {
            a = Math.min(a, d.x1, d.x2);
            b = Math.max(b, d.x1, d.x2);
          }
          return b - a;
        };
        const span0 = spanOf();
        const doorW0 = effDoors().map((d) => Math.hypot(d.x2 - d.x1, d.y2 - d.y1));
        Q('#wLen').value = String(Math.round(L0 * 2 * 30.48));
        Q('#calBtn').click();
        await tick();
        const La = lenOf(selWallSeg());
        T('pb-cal-two-step', Math.abs(La - L0) < 0.011, '第一次点击不该动手 len=' + La.toFixed(3));
        Q('#calBtn').click();
        await tick();
        const L1 = lenOf(selWallSeg());
        T(
          'pb-cal-scales-selected',
          Math.abs(L1 - L0 * 2) < 0.05,
          'len=' + L1.toFixed(3) + ' 期望≈' + (L0 * 2).toFixed(3)
        );
        T(
          'pb-cal-counts-kept',
          DOC.walls.length === nW && DOC.doors.length === nD && DOC.solids.length === nS,
          'walls=' +
            DOC.walls.length +
            '/' +
            nW +
            ' doors=' +
            DOC.doors.length +
            '/' +
            nD +
            ' solids=' +
            DOC.solids.length +
            '/' +
            nS
        );
        // 门是图纸读出来的开口 → 跟着缩放；不缩放的是洁具/台面这类真实尺寸
        const doorW1 = effDoors().map((d) => Math.hypot(d.x2 - d.x1, d.y2 - d.y1));
        const doorScaled =
          doorW0.length === doorW1.length && doorW0.every((v, i) => Math.abs(doorW1[i] - v * 2) < 0.05);
        T(
          'pb-cal-doors-scale',
          doorW0.length > 0 && doorScaled,
          doorW0
            .slice(0, 3)
            .map((v, i) => v.toFixed(2) + '→' + (doorW1[i] || 0).toFixed(2))
            .join(' ')
        );
        // 户型包络也跟着走（auto-fit 视图与 3D 取景不能错位）
        const span1 = spanOf();
        T(
          'pb-cal-plan-extent-scales',
          Math.abs(span1 - span0 * 2) < 0.15,
          'x 向包络=' + span0.toFixed(2) + ' → ' + span1.toFixed(2) + 'ft'
        );
        ctrlZ();
        await tick();
        await tap((iw.x1 + iw.x2) / 2, (iw.y1 + iw.y2) / 2);
        const L2 = lenOf(selWallSeg());
        T('pb-cal-undo', Math.abs(L2 - L0) < 0.05, 'len=' + L2.toFixed(3) + ' 原=' + L0.toFixed(3));
        const doorW2 = effDoors().map((d) => Math.hypot(d.x2 - d.x1, d.y2 - d.y1));
        T(
          'pb-cal-undo-doors',
          doorW0.every((v, i) => Math.abs(doorW2[i] - v) < 0.05),
          '门宽回到缩放前=' +
            doorW2
              .slice(0, 3)
              .map((v) => v.toFixed(2))
              .join(' ')
        );
        // E26：重标定跑在导入的户型上（内置户型不允许重标定）。“回到内置”走真实切换路径；
        // 原先的 resetDoc()+saveGeo() 会把内置几何写进**导入户型的键**，把刚标定的那份抹掉。
        switchPlan(BUILTIN_PLAN_ID, true);
        await tick();
        if (wallEdit.on) {
          drawWallEdit();
          updateWallBarFromSel(); // 真实 UI 路径（重置内置）就是这么刷工具条的
        }
        refresh();
        await tick();
        T('pb-cal-back-to-builtin', !DOC.imported && Q('#calBtn').disabled === true, 'imported=' + DOC.imported);
      }
    }

    /* ===== 12. E26 多户型管理：新建空白 / 切换 / 重命名 / 删除 / 导入不覆盖当前户型 ===== */
    {
      const e26Z = () =>
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })
        );
      const e26Pick = (id) => {
        const sel = Q('#planSel');
        sel.value = id;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      };
      await enterEdit();
      await pbReset();
      /* 12.0 bench 必须从内置户型开始（干净 profile + 没有注册表）。上一轮残留的注册表
         会把 bench 带进一个不存在的户型，断言就只是在测上一轮的垃圾。 */
      T(
        'pb-plan-starts-builtin',
        PLAN_ID === BUILTIN_PLAN_ID && PLANS.planById(PLAN_REG, BUILTIN_PLAN_ID) !== null,
        'active=' + (PLAN_ID === BUILTIN_PLAN_ID ? '内置' : PLAN_ID) + ' plans=' + PLAN_REG.plans.length
      );
      const e26Plans0 = PLAN_REG.plans.length; // 相对量：第 8 节已经导入过一次，那里留下一份户型
      /* 12.1 列表里看得到当前户型，且内置不可删 */
      const e26Sel = Q('#planSel');
      T(
        'pb-plan-select-listed',
        !!e26Sel && e26Sel.options.length >= 1 && e26Sel.value === PLAN_ID && PLAN_ID === BUILTIN_PLAN_ID,
        e26Sel ? e26Sel.options.length + ' 项 · value=' + e26Sel.value : '没有 #planSel'
      );
      const e26Pro = Q('#proTools');
      setProTools(true); // 量之前得先把它展开：display:none 的元素 scrollWidth/clientWidth 都是 0，断言会绿得毫无意义
      await tick();
      T(
        'pb-plan-row-fits',
        e26Pro.scrollWidth <= e26Pro.clientWidth + 1,
        'proTools scrollWidth=' +
          e26Pro.scrollWidth +
          ' clientWidth=' +
          e26Pro.clientWidth +
          '（多户型控件不能把这一行挤出去）'
      );
      setProTools(false);
      await tick();
      T(
        'pb-plan-builtin-locked',
        Q('#btnPlanDel').disabled === true,
        '内置户型时删除按钮 disabled=' + Q('#btnPlanDel').disabled
      );

      /* 12.2 先在内置户型里画一段用户墙（切回来必须还在 —— 这就是被修掉的坑） */
      const e26W0 = userCounts().w;
      pushUserWall(pbFree[0] - 1.5, pbFree[1] + 1.5, pbFree[0] + 1.5, pbFree[1] + 1.5, 'w', 8);
      geoChanged();
      await tick();
      const e26Wall = DOC.walls.filter((e) => e.src === 'user').slice(-1)[0];
      T('pb-plan-edit-committed', userCounts().w === e26W0 + 1 && !!e26Wall, 'userWalls=' + userCounts().w);
      const e26BuiltinWalls = effWalls().length;

      /* 12.3 新建空白户型：切过去 + 真的是空的 + 不拿内置户型的地板/家具 */
      Q('#btnPlanNew').click();
      await tick();
      const e26BlankId = PLAN_ID;
      T(
        'pb-plan-blank-created',
        e26BlankId !== BUILTIN_PLAN_ID && DOC.imported === true && PLAN_REG.plans.length === e26Plans0 + 1,
        'plans=' +
          e26Plans0 +
          '→' +
          PLAN_REG.plans.length +
          ' origin=' +
          (PLANS.planById(PLAN_REG, e26BlankId) || {}).origin
      );
      T(
        'pb-plan-blank-empty',
        effWalls().length === 0 && DOC.walls.length === 0 && effFixtures().length === 0,
        'walls=' + effWalls().length + ' fx=' + effFixtures().length
      );
      T(
        'pb-plan-blank-no-seed',
        state.items.length === 0,
        'items=' + state.items.length + '（内置布局不能播种到空白户型）'
      );
      const e26Fp = floorPts();
      T(
        'pb-plan-blank-own-canvas',
        e26Fp.length === 4 && JSON.stringify(e26Fp) !== JSON.stringify(FLOORPTS),
        '地板轮廓=' + JSON.stringify(e26Fp) + '（不能是内置户型的轮廓）'
      );
      T(
        'pb-plan-keys-separate',
        PLANS.docKeyFor(e26BlankId) !== PLANS.docKeyFor(BUILTIN_PLAN_ID) && DOC_KEY === PLANS.docKeyFor(e26BlankId),
        DOC_KEY
      );

      /* 12.4 空白户型里能画墙，地板轮廓跟着墙走 */
      await setTool('wall');
      Q('#wType').value = 'w';
      await tap(6, 6);
      await tap(12, 6);
      const e26WallBtn = Q('#wtoolSeg button[data-t="wall"]');
      e26WallBtn.focus();
      key('Enter', e26WallBtn);
      await tick();
      T('pb-plan-blank-draw-wall', effWalls().length === 1, 'walls=' + effWalls().length);
      const e26Fp2 = floorPts();
      const e26FpBox = e26Fp2.reduce(
        (a, p) => [Math.min(a[0], p[0]), Math.min(a[1], p[1]), Math.max(a[2], p[0]), Math.max(a[3], p[1])],
        [1e9, 1e9, -1e9, -1e9]
      );
      T(
        'pb-plan-blank-floor-follows',
        e26FpBox[0] <= 6 && e26FpBox[2] >= 12,
        '地板 x 向=' + e26FpBox[0].toFixed(1) + '…' + e26FpBox[2].toFixed(1) + 'ft（要包住画的墙）'
      );

      /* 12.5 切回内置户型：内置的编辑还在 */
      e26Pick(BUILTIN_PLAN_ID);
      await tick();
      T(
        'pb-plan-switch-back-builtin',
        PLAN_ID === BUILTIN_PLAN_ID && !DOC.imported && DOC_KEY === PLANS.docKeyFor(BUILTIN_PLAN_ID),
        'DOC_KEY=' + DOC_KEY
      );
      T(
        'pb-plan-switch-keeps-builtin-edit',
        !!e26Wall && DOC.walls.some((e) => e.id === e26Wall.id && e.src === 'user'),
        '内置户型里那段用户墙还在=' + DOC.walls.filter((e) => e.src === 'user').length
      );
      T(
        'pb-plan-switch-wall-count',
        effWalls().length === e26BuiltinWalls,
        'walls=' + effWalls().length + '/' + e26BuiltinWalls
      );

      /* 12.6 切回空白户型：它的墙也还在（两份互不干扰） */
      e26Pick(e26BlankId);
      await tick();
      T(
        'pb-plan-blank-preserved',
        effWalls().length === 1 && state.items.length === 0,
        'walls=' + effWalls().length + ' items=' + state.items.length
      );

      /* 12.7 重命名（输入框 + 按钮，没有阻塞弹窗） */
      Q('#planName').value = '测试户型 B';
      Q('#btnPlanRename').click();
      await tick();
      const e26Meta = PLANS.planById(PLAN_REG, PLAN_ID);
      T(
        'pb-plan-renamed',
        !!e26Meta && e26Meta.name === '测试户型 B' && DOC.name === '测试户型 B',
        'name=' + ((e26Meta || {}).name || '-') + ' DOC.name=' + DOC.name
      );
      T(
        'pb-plan-rename-in-select',
        Array.from(Q('#planSel').options).some((o) => /测试户型 B/.test(o.textContent)),
        Q('#planSel').selectedOptions[0].textContent
      );

      /* 12.8 删除：两步确认；内置不可删；删完自动切回内置 */
      Q('#btnPlanDel').click();
      await tick();
      T(
        'pb-plan-delete-armed-first-click',
        PLAN_REG.plans.length === e26Plans0 + 1 && Q('#btnPlanDel').classList.contains('arm'),
        '第一下只确认不删：plans=' + PLAN_REG.plans.length + ' arm=' + Q('#btnPlanDel').classList.contains('arm')
      );
      e26Pick(BUILTIN_PLAN_ID);
      await tick();
      T(
        'pb-plan-delete-refused-on-builtin',
        Q('#btnPlanDel').disabled === true && PLAN_REG.plans.length === e26Plans0 + 1,
        'disabled=' + Q('#btnPlanDel').disabled
      );
      e26Pick(e26BlankId);
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      T(
        'pb-plan-deleted',
        !PLANS.hasPlan(PLAN_REG, e26BlankId) && PLAN_ID === BUILTIN_PLAN_ID && effWalls().length === e26BuiltinWalls,
        'plans=' +
          PLAN_REG.plans.length +
          ' active=' +
          (PLAN_ID === BUILTIN_PLAN_ID ? '内置' : '其它') +
          ' walls=' +
          effWalls().length
      );
      T(
        'pb-plan-delete-keeps-builtin-edit',
        !!e26Wall && DOC.walls.some((e) => e.id === e26Wall.id && e.src === 'user'),
        '删掉另一份户型不能动内置户型的编辑'
      );

      /* 12.9 导入新建一份户型：内置户型的编辑不能被摸掉（E26 要修的就是这个） */
      let e26Imp = null,
        e26ImpErr = '';
      try {
        const txt = await (await fetch('../tests/fixtures/apartment-mm.dxf')).text();
        e26Imp = window.MINIDEN_GEO.importDxf(new window.DxfParser().parseSync(txt), { name: 'planbuild-e26' });
      } catch (e) {
        e26ImpErr = e.message;
      }
      if (e26Imp) {
        applyImportedDoc(e26Imp.doc, e26Imp.info);
        await tick();
        const e26ImpId = PLAN_ID;
        T(
          'pb-plan-import-makes-new-plan',
          e26ImpId !== BUILTIN_PLAN_ID && PLANS.hasPlan(PLAN_REG, e26ImpId) && PLAN_REG.plans.length === e26Plans0 + 1,
          'plans=' + PLAN_REG.plans.length
        );
        T(
          'pb-plan-import-builtin-intact',
          !!e26Wall &&
            !!PLANS.planById(PLAN_REG, BUILTIN_PLAN_ID) &&
            STORE.get(PLANS.docKeyFor(BUILTIN_PLAN_ID)) &&
            JSON.parse(STORE.get(PLANS.docKeyFor(BUILTIN_PLAN_ID))).walls.some(
              (e) => e.id === e26Wall.id && e.src === 'user'
            ),
          '内置户型的存档里那段用户墙还在'
        );
        e26Z();
        await tick();
        T(
          'pb-plan-undo-restores-plan',
          PLAN_ID === BUILTIN_PLAN_ID &&
            !DOC.imported &&
            !PLANS.hasPlan(PLAN_REG, e26ImpId) &&
            DOC.walls.some((e) => e.id === e26Wall.id && e.src === 'user'),
          'Ctrl+Z 把户型与列表一起退回去：active=' +
            (PLAN_ID === BUILTIN_PLAN_ID ? '内置' : '导入') +
            ' plans=' +
            PLAN_REG.plans.length
        );
      } else {
        T('pb-plan-import-makes-new-plan', false, e26ImpErr || 'fixture 读不到');
      }

      /* 12.10 内置布局播种的门禁：布局只属于内置户型。
         bench 页面被 build.mjs 剥掉了 plan.layout（确定性 + plan-independence），
         所以这里临时插一份假布局，直接验「切到空白户型时 load() 不能把内置户型的 32 件家具带过去」。 */
      const e26Layout0 = PLAN.layout;
      PLAN.layout = { items: [{ uid: 901, ref: 'lunix-0', x: 1, y: 1, rot: 0 }] };
      Q('#btnPlanNew').click();
      await tick();
      const e26Blank2 = PLAN_ID;
      load();
      T(
        'pb-plan-seed-gated',
        state.items.length === 0,
        '空白户型里 items=' + state.items.length + '（内置布局不能播种进来）'
      );
      PLAN.layout = e26Layout0;
      e26Pick(BUILTIN_PLAN_ID);
      await tick();
      T(
        'pb-plan-seed-gate-cleanup',
        PLAN_ID === BUILTIN_PLAN_ID && !DOC.imported,
        'active=' + (PLAN_ID === BUILTIN_PLAN_ID ? '内置' : PLAN_ID)
      );

      /* 12.11 首次引导卡在 bench / 校准 / #ui: 里必须不出现（像素基线与点击不能被动） */
      const e26Fr = Q('#firstRun');
      T(
        'pb-plan-firstrun-hidden-in-bench',
        !!e26Fr && getComputedStyle(e26Fr).display === 'none',
        'firstRun 存在=' + !!e26Fr + ' display=' + (e26Fr ? getComputedStyle(e26Fr).display : '-')
      );

      await pbReset();
      await enterEdit();
      // 把 12.10 多建的那份空白户型删掉（两步），不让它留在注册表里影响后续
      e26Pick(e26Blank2);
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      T(
        'pb-plan-cleanup',
        !PLANS.hasPlan(PLAN_REG, e26Blank2) && PLAN_ID === BUILTIN_PLAN_ID,
        'plans=' + PLAN_REG.plans.length
      );
    }

    /* ===== 收尾：页面不得有未捕获异常 ===== */
    T('pb-no-page-errors', window.__ERRS.length === 0, window.__ERRS.slice(0, 3).join(' || '));
  } catch (e) {
    log.push('EXC ' + e.message + ' @ ' + (e.stack || '').split('\n')[1]);
  }
  const pre = document.createElement('pre');
  pre.id = 'pbtest';
  pre.textContent = log.join('\n');
  document.body.appendChild(pre);
}
