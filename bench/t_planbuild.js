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
        wallEdit.tool === 'fx' && Q('#fxCtl').style.visibility === 'visible',
        'tool=' + wallEdit.tool + ' fxCtl=' + Q('#fxCtl').style.visibility
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
        // 回到内置
        resetDoc();
        saveGeo();
        geoDirty3D = true;
        build2D();
        if (wallEdit.on) drawWallEdit();
        refresh();
        await tick();
        T(
          'pb-import-restore-builtin',
          !DOC.imported && effWalls().length === nPristine && effFixtures().length === nFxBuilt,
          'walls=' + effWalls().length + '/' + nPristine + ' fx=' + effFixtures().length + '/' + nFxBuilt
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
