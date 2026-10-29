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
  /* 画出来的墙厚：从 wallPolys() 返回来的多边形量「垂直于墙轴的外缘跨度」——
     2D 填充与 3D 挤出用的就是这张表。断言如果照抄吸附实现里的公式，只能证明
     「代码自洽」，抓不到「代码与现实不符」（AGENTS §5.1；bug 猎 #20 就是这样藏着的）。 */
  const pbDrawnThick = (s) => {
    const L = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
    if (L < 1e-9) return NaN;
    const ux = (s.x2 - s.x1) / L,
      uy = (s.y2 - s.y1) / L,
      nx = -uy,
      ny = ux;
    /* wallPolys() 返回的是封口多边形 [a1,b1,b2,a2]：a1→b1 就是沿墙轴的那条边。
       先按「走向对齐 + 形心落在这段墙上」认人，再量垂直跨度；
       只按形心距离认会拿到邻墙的多边形（厚度量出来是另一个数）。 */
    let best = null,
      bd = 1e9;
    for (const q of wallPolys()) {
      const ex = q[1][0] - q[0][0],
        ey = q[1][1] - q[0][1],
        el = Math.hypot(ex, ey);
      if (el < 0.1) continue;
      if (Math.abs((ex * ux + ey * uy) / el) < 0.9) continue;
      const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4,
        cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
      let t = (cx - s.x1) * ux + (cy - s.y1) * uy;
      t = Math.max(0, Math.min(L, t));
      const d = Math.hypot(cx - (s.x1 + ux * t), cy - (s.y1 + uy * t));
      if (d < bd) {
        bd = d;
        best = q;
      }
    }
    if (!best || bd > 0.2) return NaN;
    let lo = 1e9,
      hi = -1e9;
    for (const p of best) {
      const v = p[0] * nx + p[1] * ny;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return hi - lo;
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
    Q('#wtoolSeg button[data-t="' + t + '"], #decoToolSeg button[data-t="' + t + '"]').click(); // F1：洁具 / 台面在「装修」工具组
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
            Math.abs(a5w - b5w) < 1e-6 && Math.abs(md5 - 10 / 30.48) < 1e-6, // S23：Shift = 10cm，处处一样（以前墙这边 5cm）
            '宽不变 ' + a5w.toFixed(3) + ' · 中心动 ' + (md5 * 30.48).toFixed(2) + 'cm（Shift=10cm）'
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
          if (s.t !== 'w') continue; // 只选实墙：契约从 wallPolys() 的多边形量厚度，薄墙不在那张表里
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
            /* 墙厚从 pbDrawnThick() 量（见定义处的注释）。
               以前这里写的就是 fixtureWallSnap 里那个 /SC 公式，所以它一直绿着，
               而台柜/镜子实际离墙面 4.3cm（bug 猎 #20）。 */
            const th = pbDrawnThick(s);
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
            snapOK = Number.isFinite(th) && rotOK && dWall > 0.05 && Math.abs(dWall - expect) < 0.05 && dimOK;
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
              ' 画出的墙厚=' +
              (Number.isFinite(th) ? th.toFixed(3) + 'ft' : '未匹配到多边形') +
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
      /* 6.x 非法洁具类型必须被拒。界面上 #fxType 只有合法选项，这个状态 UI 到不了 ——
         验的是爆炸半径而不是可达性：一个非法 t 进了文档，SCHEMA.Project.validate 就失败，
         而 loadDoc 对 validate 失败的文档是「STORE.remove(DOC_KEY) + 回退空文档」，
         整份房子会在下次打开时静默消失。 */
      {
        const nD = DOC.fixtures.length;
        Q('#fxType').value = 'sink'; // FX_DEFS 里没有这个键（真实类型叫 basin）
        await tap(pbFree[0] + 0.4, pbFree[1] + 0.4);
        const bad = DOC.fixtures.filter((f) => !FX_DEFS[f.t]).length;
        T(
          'pb-fx-invalid-type-rejected',
          DOC.fixtures.length === nD && bad === 0 && SCHEMA.Project.validate(DOC).length === 0,
          'fixtures=' + DOC.fixtures.length + ' 非法类型=' + bad + '（未放置，文档仍然可载入）'
        );
        Q('#fxType').value = 'toilet';
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

      /* S12 台面在 3D 里也得站起来（柜体 + 台面石板 + 冰箱 ≥ 3 个 Box） */
      const vWall = staticVerts();
      const pbRun3d = pushUserRun(
        [
          [pbFree[0] - 2, pbFree[1] + 1.5],
          [pbFree[0] + 2, pbFree[1] + 1.5],
        ],
        60 / 30.48,
        90 / 30.48
      );
      pbRun3d.modules = [{ at: 2.0, type: 'fridge', w: 2.0 }];
      geoChanged();
      await tick();
      setView('3d');
      await wait3D();
      const vRun = staticVerts();
      T('pb-run-in-3d', vRun - vWall >= 24 * 3, 'verts ' + vWall + ' → ' + vRun + '（柜体+石板+冰箱）');
      const pbRunN = runNormal(4, 0, pbFree[0] - 2, pbFree[1] + 1.5);
      const hitR = rayDown(pbFree[0] + pbRunN[0] * 0.9, pbFree[1] + 1.5 + pbRunN[1] * 0.9);
      T(
        'pb-run-blocks-ray-3d',
        !!hitR && hitR.point.y > 0.5,
        hitR ? '柜体顶 y=' + hitR.point.y.toFixed(2) + 'ft（台面高 2.95ft）' : '射线穿过柜体'
      );
      DOC.runs = (DOC.runs || []).filter((r) => r.id !== pbRun3d.id);
      geoChanged();
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
        // 导入文档的 env.preset 只被 validate 要求「是字符串」（手改过的导出 JSON / 第三方文档）：
        // 它必须在地带进入应用时被洗掉，否则后面进 3D 室内视角会当场抛异常
        imp.doc.env = { preset: 'kitchen-view-不存在', mode: 'day' };
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
        T(
          'pb-import-sanitizes-env-preset',
          !!(DOC.env && DOC.env.preset === 'seattle-city'),
          'DOC.env.preset=' + JSON.stringify(DOC.env && DOC.env.preset)
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

      /* E19 轮⑳：删用户洁具 / 删台面以前不进撤销环（deleteSel 只给墙/窗/门/多边形 pushUndo） */
      {
        await setTool('fx');
        Q('#fxType').value = 'basin';
        await tap(pbFree[0], pbFree[1] + 1.0);
        const uFx2 = DOC.fixtures[DOC.fixtures.length - 1];
        const nFx1 = DOC.fixtures.length;
        wallEdit.sel = { kind: 'fx', id: uFx2.id };
        deleteSel();
        await tick();
        T('pb-undo-del-fx', DOC.fixtures.length === nFx1 - 1, 'fx ' + nFx1 + ' → ' + DOC.fixtures.length);
        ckey(false);
        await tick();
        T(
          'pb-undo-restore-del-fx',
          DOC.fixtures.length === nFx1 && !!DOC.fixtures.find((x) => x.id === uFx2.id),
          'fx=' + DOC.fixtures.length + '/' + nFx1 + ' id 回来=' + !!DOC.fixtures.find((x) => x.id === uFx2.id)
        );
      }
      {
        const uRun2 = pushUserRun(
          [
            [pbFree[0] - 2, pbFree[1] + 2.5],
            [pbFree[0] + 2, pbFree[1] + 2.5],
          ],
          60 / 30.48,
          90 / 30.48
        );
        const nR0 = DOC.runs.length;
        geoChanged();
        await tick();
        wallEdit.sel = { kind: 'run', id: uRun2.id };
        deleteSel();
        await tick();
        T('pb-undo-del-run', DOC.runs.length === nR0 - 1, 'runs ' + nR0 + ' → ' + DOC.runs.length);
        ckey(false);
        await tick();
        T(
          'pb-undo-restore-del-run',
          DOC.runs.length === nR0 && !!DOC.runs.find((r) => r.id === uRun2.id),
          'runs=' + DOC.runs.length + '/' + nR0
        );
      }

      /* E19 轮⑳：台面在「选中」工具下也要能选中（以前 data-run 只在台面工具分支里认） */
      {
        const uRun3 = pushUserRun(
          [
            [pbFree[0] - 2, pbFree[1] + 2.5],
            [pbFree[0] + 2, pbFree[1] + 2.5],
          ],
          60 / 30.48,
          90 / 30.48
        );
        geoChanged();
        await tick();
        const bandN = runNormal(4, 0, pbFree[0] - 2, pbFree[1] + 2.5);
        const bandMid = [pbFree[0] + bandN[0] * 0.8, pbFree[1] + 2.5 + bandN[1] * 0.8];
        // 上一段撤销回来的用户洁具可能正好落在台面带上（那是正确行为：洁具赢）——先清掉，本段只验台面可选中
        DOC.fixtures = DOC.fixtures.filter((f) => f.src !== 'user');
        await setTool('select');
        wallEdit.sel = null;
        drawWallEdit();
        await tick();
        await tap(bandMid[0], bandMid[1]);
        T(
          'pb-run-selectable-in-select',
          !!wallEdit.sel && wallEdit.sel.kind === 'run' && wallEdit.sel.id === uRun3.id,
          'sel=' + (wallEdit.sel ? wallEdit.sel.kind + ':' + wallEdit.sel.id : 'null')
        );
        /* 「选择/调整」模式下面板也显示模块下拉 —— 那里点台面必须真能放模块
           （以前放置代码只在台面工具分支里 → 面板摆着下拉、点了只起手拖动，零反馈） */
        Q('#runModule').value = 'fridge';
        await tap(bandMid[0], bandMid[1]);
        const modSel = (uRun3.modules || []).length;
        T(
          'pb-run-module-works-in-select',
          modSel === 1,
          '选择模式下选冰箱再点台面 → modules=' + modSel + '（面板给了下拉就得能用）'
        );
        Q('#runModule').value = '';
        /* 台面命中区不能盖住它下面的洁具（洁具更小、更精准，应该赢） */
        await setTool('fx');
        Q('#fxType').value = 'toilet';
        await tap(bandMid[0], bandMid[1]);
        const overFx = DOC.fixtures[DOC.fixtures.length - 1];
        await setTool('select');
        wallEdit.sel = null;
        drawWallEdit();
        await tick();
        await tap(bandMid[0], bandMid[1]);
        T(
          'pb-fx-click-wins-over-run',
          !!wallEdit.sel && wallEdit.sel.kind === 'fx' && wallEdit.sel.id === overFx.id,
          'sel=' + (wallEdit.sel ? wallEdit.sel.kind + ':' + wallEdit.sel.id : 'null') + ' 期望 fx:' + overFx.id
        );
        DOC.fixtures = DOC.fixtures.filter((x) => x.id !== overFx.id);
        DOC.runs = (DOC.runs || []).filter((r) => r.id !== uRun3.id);
        geoChanged();
        await tick();
      }

      /* E19 轮⑳：只点一下、没拖动 → 不得进撤销环（否则「撤销」亮着但按下去什么都没发生） */
      {
        const uRun4 = pushUserRun(
          [
            [pbFree[0] - 2, pbFree[1] + 2.5],
            [pbFree[0] + 2, pbFree[1] + 2.5],
          ],
          60 / 30.48,
          90 / 30.48
        );
        geoChanged();
        await tick();
        const bandN2 = runNormal(4, 0, pbFree[0] - 2, pbFree[1] + 2.5);
        const bandMid2 = [pbFree[0] + bandN2[0] * 0.8, pbFree[1] + 2.5 + bandN2[1] * 0.8];
        await setTool('select');
        wallEdit.sel = null;
        drawWallEdit();
        await tick();
        const ring0 = undoRing.length;
        const path0 = JSON.stringify(uRun4.path);
        await tap(bandMid2[0], bandMid2[1]);
        T(
          'pb-undo-click-not-a-gesture',
          undoRing.length === ring0 && JSON.stringify(uRun4.path) === path0,
          'ring ' + ring0 + ' → ' + undoRing.length
        );
        DOC.runs = (DOC.runs || []).filter((r) => r.id !== uRun4.id);
        geoChanged();
        wallEdit.sel = null;
        await tick();
      }

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
          /* 不溢出 ≠ 没被压扁：flex 子元素会先自己收缩、把字折行，scrollWidth 照样不超（S14 实测：
             加第 7 个工具后 1700 宽时按钮高 30 → 48px，「选择/调整」读成竖排）。判据 = 每个看得见的按钮都是单行。 */
          const btns = Array.from(bar.querySelectorAll('button')).filter((b) => b.offsetParent);
          const tall = btns.filter((b) => b.getBoundingClientRect().height > 34).map((b) => b.textContent.trim());
          T(
            'pb-bar-buttons-single-line',
            btns.length >= 10 && tall.length === 0,
            btns.length +
              ' 个按钮 · 折行的：' +
              (tall.length ? tall.join('、') : '无') +
              ' · 工具条高 ' +
              Math.round(bar.getBoundingClientRect().height) +
              'px'
          );
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
        /* 先画一段带已知厚度的窗（20cm）：整图缩放后它的**画出来的厚度**该跟着翻倍。
           导入的窗没有 thick（见下面的 INFO），只有用户画的窗才带厚度 —— 用它来量。 */
        await setTool('wall');
        Q('#wThick').value = '20';
        Q('#wType').value = 'g';
        const iwPre = effWalls()
          .filter((s) => s.t === 'w')
          .sort((a, b) => Math.hypot(b.x2 - b.x1, b.y2 - b.y1) - Math.hypot(a.x2 - a.x1, a.y2 - a.y1))[0];
        const iwL0 = Math.hypot(iwPre.x2 - iwPre.x1, iwPre.y2 - iwPre.y1) || 1;
        const nX = -(iwPre.y2 - iwPre.y1) / iwL0,
          nY = (iwPre.x2 - iwPre.x1) / iwL0;
        const cW1 = [iwPre.x1 + nX * 4, iwPre.y1 + nY * 4];
        const cW2 = [cW1[0] + 3, cW1[1]];
        await tap(cW1[0], cW1[1]);
        await tap(cW2[0], cW2[1]);
        const cWBtn = Q('#wtoolSeg button[data-t="wall"]');
        cWBtn.focus();
        key('Enter', cWBtn);
        await tick();
        /* 窗不在 wallPolys() 里（它只收 t==='w'），所以窗厚从投影的 wd 量、墙厚从多边形量，
           两条不同的路一起断：缩放必须让它们按同一个比例走。 */
        const calWinEnt = () => DOC.windows.find((e) => e.src === 'user' && e.thick != null) || null;
        const calWinWd = () => {
          const e = calWinEnt();
          if (!e) return NaN;
          const s = effWalls().find((q) => q._id === e.id);
          return s && s.wd != null ? s.wd / S : NaN;
        };
        const calWinT0 = calWinEnt() ? calWinEnt().thick : NaN;
        const calWinWd0 = calWinWd();
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
        const calWallTh0 = pbDrawnThick(iw); // 缩放前量：iw 的坐标在缩放后就是旧值了
        const doorW0 = effDoors().map((d) => Math.hypot(d.x2 - d.x1, d.y2 - d.y1));
        /* 家具摆在墙边：整图缩放必须把它一起搬走。家具不在 ProjectDoc 里（它走
           planner_v1:<id> 另一条存档），而 rescaleDocPlan 只摸 DOC。 */
        addItem(CATALOG[0].id);
        await tick();
        const calIt0 = state.items[state.items.length - 1];
        calIt0.x = iw.x1 + 1.2;
        calIt0.y = iw.y1 + 1.2;
        const calUid = calIt0.uid;
        const calP0 = [calIt0.x, calIt0.y];
        /* 缩放的不动点 = 缩放**之前**的户型包络中心（在这里取，不在缩放后取）：
           G16 之后自包含户型的地板轮廓是墙围出来的真实外轮廓，导入 DXF 墙角的细缝在原尺寸下封得住、
           放大 2 倍后封不住（退回包围盒）——缩放后再用 floorPts() 反推中心，默认了「轮廓定义在缩放前后不变」 */
        const calC = (() => {
          const fp = floorPts();
          let a = 1e9,
            b = 1e9,
            c = -1e9,
            d = -1e9;
          for (const p of fp) {
            a = Math.min(a, p[0]);
            b = Math.min(b, p[1]);
            c = Math.max(c, p[0]);
            d = Math.max(d, p[1]);
          }
          return [(a + c) / 2, (b + d) / 2];
        })();
        drawFurniture();
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
        /* 家具跟着户型走（bug 猎 #22：以前它留在旧坐标，×2 之后跑到墙外 / 房间错位）。
           缩放中心（calC）在缩放之前从 floorPts() 包络独立算，不照抄实现。 */
        const calK = span1 / span0;
        const calIt1 = state.items.find((it) => it.uid === calUid);
        const expX = calC[0] + (calP0[0] - calC[0]) * calK;
        const expY = calC[1] + (calP0[1] - calC[1]) * calK;
        T(
          'pb-cal-items-move-with-plan',
          !!calIt1 && Math.abs(calIt1.x - expX) < 0.06 && Math.abs(calIt1.y - expY) < 0.06,
          '家具 (' +
            calP0[0].toFixed(2) +
            ', ' +
            calP0[1].toFixed(2) +
            ') → (' +
            (calIt1 ? calIt1.x.toFixed(2) : '?') +
            ', ' +
            (calIt1 ? calIt1.y.toFixed(2) : '?') +
            ') 期望 (' +
            expX.toFixed(2) +
            ', ' +
            expY.toFixed(2) +
            ') · ×' +
            calK.toFixed(3)
        );
        /* 门的 width 字段必须跟着几何走（bug 猎 #23：几何 ×2 而 width 没动 →
           声明值只有实际开口的一半；导出/导入把它当门宽读就读到一半）。
           窗的 width 已经缩放（同一节代码里），门是这套规则里唯一的漏项。 */
        const calDoors = DOC.doors.map((d) => {
          const g = d.geom;
          return { id: d.id, w: d.width, L: Math.hypot(g.x2 - g.x1, g.y2 - g.y1) };
        });
        const calDoorOk = calDoors.every((d) => Math.abs(d.w - d.L) < 0.03);
        T(
          'pb-cal-door-width-field-scales',
          calDoors.length > 0 && calDoorOk,
          calDoors
            .slice(0, 3)
            .map((d) => d.id + ' width=' + d.w.toFixed(3) + ' 开口=' + d.L.toFixed(3))
            .join(' ')
        );
        /* 窗厚：用户画的窗带 thick（20cm）。整图缩放把墙厚放大了，窗厚没跟着走的话
           窗就比它所在的墙薄一大截。墙厚从 wallPolys 多边形量，窗厚从投影 wd 量。 */
        const calWallTh1 = pbDrawnThick(effWalls().find((q) => q._id === iw._id) || iw);
        const calWinT1 = calWinEnt() ? calWinEnt().thick : NaN;
        const calWinWd1 = calWinWd();
        T(
          'pb-cal-window-thick-scales',
          isFinite(calWinT0) &&
            isFinite(calWinT1) &&
            Math.abs(calWinT1 - calWinT0 * 2) < 0.03 &&
            isFinite(calWinWd0) &&
            isFinite(calWinWd1) &&
            Math.abs(calWinWd1 - calWinWd0 * 2) < 0.03,
          '窗 thick ' +
            (isFinite(calWinT0) ? calWinT0.toFixed(3) : '?') +
            '→' +
            (isFinite(calWinT1) ? calWinT1.toFixed(3) : '?') +
            ' · 投影 wd ' +
            (isFinite(calWinWd0) ? calWinWd0.toFixed(3) : '?') +
            '→' +
            (isFinite(calWinWd1) ? calWinWd1.toFixed(3) : '?') +
            'ft（期望 ×2）'
        );
        T(
          'pb-cal-wall-thick-geometric',
          isFinite(calWallTh0) && isFinite(calWallTh1) && Math.abs(calWallTh1 - calWallTh0 * 2) < 0.06,
          '墙画出来的厚 ' +
            (isFinite(calWallTh0) ? calWallTh0.toFixed(3) : '?') +
            ' → ' +
            (isFinite(calWallTh1) ? calWallTh1.toFixed(3) : '?') +
            'ft（期望 ×2）'
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

      /* 12.12 E19 轮⑲：一份「读得到但读不动」的存档，不许把内置公寓写进自包含户型。
         loadDoc 的回退原先只有一种形状：freshDoc() = 内置公寓。切到一个存档坏了的自包含户型时
         它拿到整套西雅图公寓，紧接着 switchPlan 末尾的 saveGeo() 把这套公寓写进那份户型的键——
         用户的导入户型被替换成别人家的房子，而原存档在 usable() 失败那一步已被 STORE.remove 删掉。 */
      Q('#btnPlanNew').click();
      await tick();
      const e26Broken = PLAN_ID,
        e26BrokenKey = PLANS.docKeyFor(PLAN_ID);
      STORE.set(e26BrokenKey, '{"v":1,"walls":"不是数组"}'); // 读得到、validate 判坏
      e26Pick(BUILTIN_PLAN_ID);
      await tick();
      const e26BuiltWalls = effWalls().length;
      e26Pick(e26Broken);
      await tick();
      T(
        'pb-plan-corrupt-archive-not-builtin',
        DOC.imported === true && (DOC.walls || []).length === 0 && effWalls().length !== e26BuiltWalls,
        'walls=' +
          effWalls().length +
          '（内置=' +
          e26BuiltWalls +
          '） imported=' +
          DOC.imported +
          ' name=' +
          JSON.stringify(DOC.name)
      );
      T(
        'pb-plan-corrupt-archive-kept',
        (STORE.get(e26BrokenKey) || '').indexOf('不是数组') >= 0,
        '主存里现在存的是 ' + JSON.stringify(String(STORE.get(e26BrokenKey) || '').slice(0, 46))
      );
      // 存档坏了也得删得掉这份户型（删除路径不能因为读不动就卡住）
      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      T(
        'pb-plan-corrupt-archive-deleted',
        !PLANS.hasPlan(PLAN_REG, e26Broken) && PLAN_ID === BUILTIN_PLAN_ID,
        'plans=' + PLAN_REG.plans.length
      );

      /* 12.13 存档「缺失」时也不许拿旧单桶存档（它属于内置户型）当这份户型的几何 */
      const e26LegacySeed = STORE.get(PLANS.docKeyFor(BUILTIN_PLAN_ID));
      if (e26LegacySeed) localStorage.setItem('planner_doc_v1', e26LegacySeed); // 旧单桶键 = 内置公寓的存档
      Q('#btnPlanNew').click();
      await tick();
      const e26Gone = PLAN_ID,
        e26GoneKey = PLANS.docKeyFor(PLAN_ID);
      STORE.remove(e26GoneKey); // 模拟「这份户型的存档不见了」（LS 配额满 / 主存读不到）
      e26Pick(BUILTIN_PLAN_ID);
      await tick();
      e26Pick(e26Gone);
      await tick();
      T(
        'pb-plan-missing-archive-not-legacy-builtin',
        DOC.imported === true && (DOC.walls || []).length === 0 && effWalls().length !== e26BuiltWalls,
        'walls=' + effWalls().length + '（内置=' + e26BuiltWalls + '） imported=' + DOC.imported
      );
      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      T(
        'pb-plan-missing-archive-cleanup',
        !PLANS.hasPlan(PLAN_REG, e26Gone) && PLAN_ID === BUILTIN_PLAN_ID,
        'plans=' + PLAN_REG.plans.length
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

    /* ===== 13. 彻底的从零开始：空白户型 → 画一圈墙（含窗与门洞）→ 放门 → 放洁具 → 放家具 → 3D 里看见它 ===== */
    {
      /* 这一节断的是产品承诺本身：一个没有图纸、也没有内置户型的人，从一张空白画布开始，
         在界面里把房子画出来、装上门 / 窗 / 洁具 / 家具，然后在 3D 里看见它。
         以前每一节都跑在内置户型上（打开就有一整套房 + 洁具 + 门），所以「从零建房」这条
         路径从来没有被完整测过。空白户型的画布是 app 自己的常量 ⇒ 本节 plan-independent。 */
      await enterEdit();
      await pbReset();
      T(
        'pb-zero-starts-builtin',
        PLAN_ID === BUILTIN_PLAN_ID,
        'active=' + (PLAN_ID === BUILTIN_PLAN_ID ? '内置' : PLAN_ID)
      );

      /* 13.1 空白起点：走真实 UI 路径（工具 ⌄ → 新建空白户型） */
      Q('#btnPlanNew').click();
      await tick();
      const zId = PLAN_ID;
      const zFp = floorPts();
      const zXs = zFp.map((p) => p[0]),
        zYs = zFp.map((p) => p[1]);
      const ZX0 = Math.min.apply(null, zXs),
        ZX1 = Math.max.apply(null, zXs),
        ZY0 = Math.min.apply(null, zYs),
        ZY1 = Math.max.apply(null, zYs);
      const ZW = ZX1 - ZX0,
        ZH = ZY1 - ZY0;
      T(
        'pb-zero-blank',
        zId !== BUILTIN_PLAN_ID &&
          DOC.walls.length === 0 &&
          DOC.windows.length === 0 &&
          DOC.doors.length === 0 &&
          DOC.fixtures.length === 0 &&
          state.items.length === 0,
        'walls=' +
          DOC.walls.length +
          ' win=' +
          DOC.windows.length +
          ' doors=' +
          DOC.doors.length +
          ' fx=' +
          DOC.fixtures.length +
          ' items=' +
          state.items.length
      );
      T('pb-zero-own-canvas', zFp.length === 4 && ZW >= 10 && ZH >= 8, '画布 ' + ZW + '×' + ZH + 'ft');

      /* 13.2 画一圈墙：底边中间一段是窗（类型=玻璃/窗），顶边中间一段是门洞（类型=门洞） */
      const AX = ZX0 + ZW * 0.2,
        AY = ZY0 + ZH * 0.2,
        BX = ZX1 - ZW * 0.2,
        BY = ZY1 - ZH * 0.2;
      const RW = BX - AX,
        RH = BY - AY;
      // 底边中间一段是窗（占 50%），顶边中间一段是门洞（占 25% ⇒ 约 90cm 开口）
      const P1 = [AX + RW * 0.25, AY],
        P2 = [BX - RW * 0.25, AY],
        P3 = [AX + RW * 0.625, BY],
        P4 = [AX + RW * 0.375, BY];
      await setTool('wall');
      const drawPiece = async (type, a, b) => {
        Q('#wType').value = type;
        await tap(a[0], a[1]);
        await tap(b[0], b[1]);
        const btn = Q('#wtoolSeg button[data-t="wall"]');
        btn.focus();
        key('Enter', btn);
        await tick();
      };
      await drawPiece('w', [AX, AY], P1);
      await drawPiece('g', P1, P2);
      await drawPiece('w', P2, [BX, AY]);
      await drawPiece('w', [BX, AY], [BX, BY]);
      await drawPiece('w', [BX, BY], P3);
      await drawPiece('d', P3, P4);
      await drawPiece('w', P4, [AX, BY]);
      await drawPiece('w', [AX, BY], [AX, AY]);
      const zWalls = DOC.walls.filter((e) => e.src === 'user');
      const zOpen = zWalls.filter((e) => e.kind === 'opening');
      T(
        'pb-zero-room-closed',
        zWalls.length === 7 && DOC.windows.filter((e) => e.src === 'user').length === 1,
        '墙 ' + zWalls.length + ' 段（应 6 实墙 + 1 门洞）· 窗 ' + DOC.windows.length
      );
      const zLegacy = effWalls();
      T(
        'pb-zero-window-and-opening-in-projection',
        zLegacy.some((s) => s.t === 'g') && zLegacy.some((s) => s.t === 'd'),
        '投影 t 集合=' +
          zLegacy
            .map((s) => s.t)
            .sort()
            .join('')
      );
      // 端点咬合：四个角各被两段墙共用（磁吸把重复点击并到同一点）
      const zJoined = [
        [AX, AY],
        [BX, AY],
        [BX, BY],
        [AX, BY],
      ].filter(([cx, cy]) => {
        let n = 0;
        for (const s of zWalls) {
          const d1 = Math.hypot(s.geom.x1 - cx, s.geom.y1 - cy),
            d2 = Math.hypot(s.geom.x2 - cx, s.geom.y2 - cy);
          if (d1 < 0.35 || d2 < 0.35) n++;
        }
        return n >= 2;
      }).length;
      T('pb-zero-corners-joined', zJoined === 4, zJoined + '/4 个角有两段墙共用（磁吸咬合）');
      const zFp2 = floorPts();
      const z2Xs = zFp2.map((p) => p[0]),
        z2Ys = zFp2.map((p) => p[1]);
      T(
        'pb-zero-floor-follows-drawing',
        Math.min.apply(null, z2Xs) <= AX + 0.05 &&
          Math.max.apply(null, z2Xs) >= BX - 0.05 &&
          Math.min.apply(null, z2Ys) <= AY + 0.05 &&
          Math.max.apply(null, z2Ys) >= BY - 0.05,
        '地板轮廓 x[' +
          Math.min.apply(null, z2Xs).toFixed(1) +
          '…' +
          Math.max.apply(null, z2Xs).toFixed(1) +
          '] y[' +
          Math.min.apply(null, z2Ys).toFixed(1) +
          '…' +
          Math.max.apply(null, z2Ys).toFixed(1) +
          ']'
      );

      /* 13.3 放门：门工具点门洞（门只能放在开口上 —— 这是设计，不是 bug） */
      await setTool('door');
      if (zOpen.length) {
        const o = zOpen[0].geom;
        await tap((o.x1 + o.x2) / 2, (o.y1 + o.y2) / 2);
      }
      const zDoor = DOC.doors.filter((e) => e.src === 'user').slice(-1)[0];
      const zOpenLen = zOpen.length
        ? Math.hypot(zOpen[0].geom.x2 - zOpen[0].geom.x1, zOpen[0].geom.y2 - zOpen[0].geom.y1)
        : 0;
      T(
        'pb-zero-door-on-opening',
        !!zDoor && DOC.doors.length === 1 && Math.abs(zDoor.width - zOpenLen) < 0.15,
        zDoor
          ? '门宽=' + zDoor.width.toFixed(2) + 'ft 门洞=' + zOpenLen.toFixed(2) + 'ft kind=' + zDoor.kind
          : '门没放上（门洞数=' + zOpen.length + '）'
      );
      T(
        'pb-zero-door-in-projection',
        effDoors().length === 1 && effDoors()[0]._id === zDoor.id,
        'effDoors=' + effDoors().length
      );

      /* 13.4 洁具：马桶 + 台盆（自由放置）+ 镜子（贴墙契约） */
      await setTool('fx');
      const zFxN = () => DOC.fixtures.filter((f) => f.src === 'user').length;
      Q('#fxType').value = 'toilet';
      await tap(AX + RW * 0.12, AY + RH * 0.18);
      const zToilet = DOC.fixtures[DOC.fixtures.length - 1];
      Q('#fxType').value = 'basin';
      await tap(AX + RW * 0.4, AY + RH * 0.1);
      const zSink = DOC.fixtures[DOC.fixtures.length - 1];
      T(
        'pb-zero-fx-placed-inside',
        zFxN() === 2 &&
          zToilet.t === 'toilet' &&
          zSink.t === 'basin' &&
          [zToilet, zSink].every((f) => {
            const cx = (f.x1 + f.x2) / 2,
              cy = (f.y1 + f.y2) / 2;
            return cx > AX && cx < BX && cy > AY && cy < BY;
          }),
        'userFx=' + zFxN() + '（都在画出来的房间里）'
      );
      Q('#fxType').value = 'mirror';
      // 贴墙吸附半径 = min(1.0, 20/屏幕每英尺像素)：空白户型视野大 → 半径小，点击必须落在半径内
      const zSnapIn = Math.min(0.35, 10 / pxPerFtNow());
      await tap(AX + zSnapIn, (AY + BY) / 2); // 左墙内侧（吸附半径内）
      const zMir = DOC.fixtures[DOC.fixtures.length - 1];
      {
        // 对着「实际吸附到的那面墙」量，不是对着我以为的那面墙
        let wall = null,
          bd = 1e9;
        const cxm = (zMir.x1 + zMir.x2) / 2,
          cym = (zMir.y1 + zMir.y2) / 2;
        for (const s of effWalls()) {
          if (s.t !== 'w' && s.t !== 'i') continue;
          const d = distSeg(cxm, cym, s);
          if (d < bd) {
            bd = d;
            wall = s;
          }
        }
        let ok = false,
          info = '没有可贴的墙';
        if (wall) {
          const L = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
          const ux = (wall.x2 - wall.x1) / L,
            uy = (wall.y2 - wall.y1) / L;
          const th = pbDrawnThick(wall);
          const expect = (th + FX_DEFS.mirror.d) / 2;
          let wa = (Math.atan2(uy, ux) * 180) / Math.PI;
          wa = ((wa % 360) + 360) % 360;
          if (wa >= 180) wa -= 180;
          ok =
            Number.isFinite(th) &&
            zMir.t === 'mirror' &&
            zMir.rot != null &&
            Math.abs((zMir.rot || 0) - Math.round(wa)) < 0.6 &&
            Math.abs(bd - expect) < 0.05;
          info =
            '贴墙=' +
            wall._id +
            ' 墙角=' +
            wa.toFixed(1) +
            ' rot=' +
            zMir.rot +
            ' dWall=' +
            bd.toFixed(3) +
            ' expect=' +
            expect.toFixed(3) +
            ' 墙厚=' +
            th.toFixed(3);
        }
        T('pb-zero-mirror-snaps-to-drawn-wall', ok, info);
      }

      /* 13.5 家具：目录卡片点击（addItem 就是卡片 onclick 调的函数）→ 落在房间里 */
      Q('#btnWallEdit').click(); // 退出编辑模式（放家具是自由视角的动作）
      await tick();
      const zRefs = ['sofa', 'table', 'lamp'].map((kw) => {
        const hit = CATALOG.find((c) => (c.cat || '').indexOf(kw) >= 0 || c.kind.indexOf(kw) >= 0);
        return hit ? hit.id : null;
      });
      zRefs.forEach((id, i) => {
        if (!id) return;
        addItem(id);
        const it = state.items[state.items.length - 1];
        // 拖动等价：改占地坐标后重画（2D 拖动做的就是这个）
        it.x = AX + RW * (0.3 + 0.2 * i);
        it.y = AY + RH * (0.55 + 0.15 * i);
        drawFurniture();
        save();
      });
      T(
        'pb-zero-furniture-inside',
        state.items.length === 3 && state.items.every((it) => it.x > AX && it.x < BX && it.y > AY && it.y < BY),
        'items=' + state.items.length + ' refs=' + zRefs.join(',')
      );
      updateTotals();
      const zTot = Q('#totals') ? Q('#totals').textContent : '';
      T('pb-zero-totals-counted', /清单\s*3\s*件/.test(zTot), '#totals = ' + JSON.stringify(zTot.slice(0, 40)));

      /* 13.6 3D：画的墙立到顶、洁具与家具都在场景里 */
      setView('3d');
      await wait3D();
      const zHit = rayDown(AX, (AY + BY) / 2);
      T(
        'pb-zero-3d-wall-stands',
        !!zHit && zHit.point.y > 1.0 && Math.hypot(zHit.point.x - AX, zHit.point.z - (AY + BY) / 2) < 1.2,
        zHit ? '左墙命中 y=' + zHit.point.y.toFixed(2) : '3D 里没有这段墙'
      );
      const zFxGroups =
        three && three.staticGroup
          ? (() => {
              let n = 0;
              three.staticGroup.traverse((o) => {
                if (o.isMesh && o.geometry && o.geometry.attributes && o.geometry.attributes.position) {
                  const bb = new THREE.Box3().setFromObject(o);
                  if (bb.min.x > AX - 1 && bb.max.x < BX + 1 && bb.min.z > AY - 1 && bb.max.z < BY + 1) n++;
                }
              });
              return n;
            })()
          : 0;
      T('pb-zero-3d-has-content', zFxGroups > 0, '房间内静态网格 ' + zFxGroups + ' 个');
      T(
        'pb-zero-3d-furniture',
        !!three && three.furnMap && three.furnMap.size === 3,
        'furnMap=' + (three && three.furnMap ? three.furnMap.size : '-')
      );
      /* 13.6b 第一人称落点：自包含户型不能落在硬编码的 (22,27)ft（那是内置户型的客厅，
         在画出来的户型外面 → 点「室内」先看见自家外墙背面）。落点必须在户型内。 */
      setView('fp');
      await new Promise((r) => setTimeout(r, 1500));
      const zCamFP = three && three.cam ? [three.cam.position.x, three.cam.position.z] : null;
      const zFpHome = floorPts();
      const zInsideFP = (x, y) => {
        let ins = false;
        for (let i = 0, j = zFpHome.length - 1; i < zFpHome.length; j = i++) {
          const xi = zFpHome[i][0],
            yi = zFpHome[i][1],
            xj = zFpHome[j][0],
            yj = zFpHome[j][1];
          if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins;
        }
        return ins;
      };
      T(
        'pb-zero-fp-inside-plan',
        !!zCamFP && zInsideFP(zCamFP[0], zCamFP[1]),
        '室内落点 (' +
          (zCamFP ? zCamFP[0].toFixed(1) : '?') +
          ', ' +
          (zCamFP ? zCamFP[1].toFixed(1) : '?') +
          ') 在画出的户型内；视线方向 (' +
          (three.fpDir ? three.fpDir.x.toFixed(2) : '?') +
          ', ' +
          (three.fpDir ? three.fpDir.z.toFixed(2) : '?') +
          ')（旧版硬编码 (22,27) 在户型外）'
      );
      setView('2d');
      await tick();

      /* 13.7 这份从零建的房子写进了它自己的存档键，且没有污染内置户型 */
      saveGeo();
      await tick();
      const zRaw = STORE.get(DOC_KEY);
      const zBack = zRaw ? JSON.parse(zRaw) : null;
      T(
        'pb-zero-persisted-own-key',
        !!zBack &&
          zBack.imported === true &&
          zBack.walls.filter((e) => e.src === 'user').length === 7 &&
          zBack.doors.length === 1 &&
          zBack.fixtures.filter((f) => f.src === 'user').length === 3,
        zBack
          ? 'doc=' + DOC_KEY + ' 墙' + zBack.walls.length + ' 门' + zBack.doors.length + ' 洁具' + zBack.fixtures.length
          : '没写进主存'
      );
      const zBuiltinRaw = STORE.get(PLANS.docKeyFor(BUILTIN_PLAN_ID));
      const zBuiltin = zBuiltinRaw ? JSON.parse(zBuiltinRaw) : null;
      T(
        'pb-zero-builtin-untouched',
        !!zBuiltin && zBuiltin.walls.filter((e) => e.src === 'user').length === 0,
        '内置户型 userWalls=' + (zBuiltin ? zBuiltin.walls.filter((e) => e.src === 'user').length : '-')
      );

      /* 13.7b 界面建出来的这份文档必须过 validate —— 过不了的话 loadDoc 会 STORE.remove(DOC_KEY)
         然后回退成空文档：用户的整份房子被静默删掉。这是这条路径上最贵的一道闸。 */
      {
        const zV = SCHEMA.Project.validate(JSON.parse(STORE.get(DOC_KEY)));
        T('pb-zero-doc-valid', zV.length === 0, zV.length ? 'validate: ' + zV.slice(0, 3).join(' | ') : '通过');
      }

      /* 13.8 切回内置户型：从零建的那份还在（注册表里数得出来），内置户型也还是完整的 */
      const zSel = Q('#planSel');
      zSel.value = BUILTIN_PLAN_ID;
      zSel.dispatchEvent(new Event('change', { bubbles: true }));
      await tick();
      T(
        'pb-zero-switch-back-intact',
        PLAN_ID === BUILTIN_PLAN_ID && effWalls().length > 10 && effDoors().length > 0,
        '内置 墙=' + effWalls().length + ' 门=' + effDoors().length
      );
      zSel.value = zId;
      zSel.dispatchEvent(new Event('change', { bubbles: true }));
      await tick();
      T(
        'pb-zero-from-scratch-survives',
        PLAN_ID === zId && DOC.walls.filter((e) => e.src === 'user').length === 7 && state.items.length === 3,
        '回到从零建的那份：墙=' + DOC.walls.filter((e) => e.src === 'user').length + ' 家具=' + state.items.length
      );

      /* 13.9 清场：删掉这份户型，不让它留在注册表里影响后续 */
      await enterEdit();
      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      T(
        'pb-zero-cleanup',
        !PLANS.hasPlan(PLAN_REG, zId) && PLAN_ID === BUILTIN_PLAN_ID,
        'plans=' + PLAN_REG.plans.length + ' active=' + (PLAN_ID === BUILTIN_PLAN_ID ? '内置' : PLAN_ID)
      );
    }
    /* ── 12.14 S12 台面 run 的消费面（E19 轮⑳）───────────── */
    {
      /* 凹型（L 型）地板 + 沿内边的台面：柜体必须长在地板那一侧。
           旧判据「指向地板质心」在凹型上会把柜体翻到户型外——质心被另一条臂拉走了。 */
      const s20Doc0 = JSON.parse(JSON.stringify(DOC));
      const s20L = [
        [0, 0],
        [12, 0],
        [12, 5],
        [5, 5],
        [5, 12],
        [0, 12],
      ];
      DOC.imported = true;
      DOC.floorOutline = s20L.map((p) => [p[0], p[1]]);
      const s20Run = pushUserRun(
        [
          [5, 5],
          [5, 12],
        ],
        60 / 30.48,
        90 / 30.48
      ); // 沿内边 x=5, y 5..12
      fit2DToContent();
      build2D(); // 视图复位到新地板（AGENTS §5.1：点击段开头先复位视图）
      const s20N = runNormal(0, 7, 5, 5);
      const s20In = [5 + s20N[0] * 1.0, 5 + s20N[1] * 1.0];
      const s20Out = [5 - s20N[0] * 1.0, 5 - s20N[1] * 1.0];
      T(
        'pb-run-side-follows-floor-not-centroid',
        s20N[0] < 0 && insideFloorPt(s20In[0], s20In[1]) && !insideFloorPt(s20Out[0], s20Out[1]),
        '法线=(' +
          s20N.map((v) => v.toFixed(2)).join(',') +
          ') 探点内=' +
          insideFloorPt(s20In[0], s20In[1]) +
          ' 探点外=' +
          insideFloorPt(s20Out[0], s20Out[1]) +
          '（L 型内边：地板在 x<5 那侧）'
      );
      // 2D 真画出来的柜体多边形：顶点也得落在地板内（不能穿墙到户型外）
      if (!wallEdit.on) Q('#btnWallEdit').click();
      build2D();
      drawWallEdit();
      const s20Gs = pbSvg.querySelectorAll('g[data-run="' + s20Run.id + '"]');
      const s20G = s20Gs.length ? s20Gs[s20Gs.length - 1] : null;
      const s20Poly = s20G ? s20G.querySelector('polygon') : null;
      const s20Pts = s20Poly
        ? (s20Poly.getAttribute('points') || '')
            .trim()
            .split(/\s+/)
            .map((s) => s.split(',').map((v) => +v / S))
        : [];
      const s20Cx = s20Pts.reduce((a, p) => a + p[0], 0) / (s20Pts.length || 1);
      const s20Cy = s20Pts.reduce((a, p) => a + p[1], 0) / (s20Pts.length || 1);
      T(
        'pb-run-2d-band-inside-floor',
        !!s20Poly && s20Pts.length === 4 && insideFloorPt(s20Cx, s20Cy),
        s20Poly
          ? '带中心=(' +
              s20Cx.toFixed(2) +
              ',' +
              s20Cy.toFixed(2) +
              ') 在地板内=' +
              insideFloorPt(s20Cx, s20Cy) +
              ' pts=' +
              (s20Poly.getAttribute('points') || '') +
              ' 组数=' +
              s20Gs.length
          : '没找到台面图例'
      );

      /* 模块不许超出台面末端：冰箱宽 2ft，放在台面末点上 → 一半悬在柜体外 */
      wallEdit.tool = 'run';
      wallEdit.sel = { kind: 'run', id: s20Run.id };
      document.getElementById('runModule').value = 'fridge';
      const s20Total = (() => {
        let a = 0;
        const p = s20Run.path;
        for (let i = 0; i < p.length - 1; i++) a += Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]);
        return a;
      })();
      await tap(5, 11.95); // 贴近台面末端放冰箱
      const s20Mod = ((DOC.runs.find((r) => r.id === s20Run.id) || {}).modules || [])[0];
      const s20At = s20Mod ? s20Mod.at : -1,
        s20W = s20Mod ? s20Mod.w : 0;
      T(
        'pb-run-module-stays-on-counter',
        !!s20Mod && s20At - s20W / 2 >= -0.01 && s20At + s20W / 2 <= s20Total + 0.01,
        s20Mod
          ? '沿台面 ' + s20At.toFixed(2) + 'ft · 宽 ' + s20W.toFixed(2) + 'ft · 台面长 ' + s20Total.toFixed(2) + 'ft'
          : '模块没放进去'
      );

      /* 台面比模块窄 → 拒放并说明（不能放一个搁不下的冰箱） */
      const s20Short = pushUserRun(
        [
          [1, 1],
          [1, 2.2],
        ],
        60 / 30.48,
        90 / 30.48
      ); // 长 1.2ft
      wallEdit.sel = { kind: 'run', id: s20Short.id };
      const s20Msg0 = document.getElementById('wMsg').textContent;
      await tap(1, 2.1);
      const s20ShortMod = ((DOC.runs.find((r) => r.id === s20Short.id) || {}).modules || []).length;
      const s20Msg1 = document.getElementById('wMsg').textContent;
      T(
        'pb-run-module-too-narrow-rejected',
        s20ShortMod === 0 && s20Msg1 !== s20Msg0 && /窄|放不下|加长/.test(s20Msg1),
        '模块数=' +
          s20ShortMod +
          ' 提示「' +
          s20Msg1 +
          '」 tool=' +
          wallEdit.tool +
          ' sel=' +
          (wallEdit.sel ? wallEdit.sel.kind + ':' + wallEdit.sel.id : 'null') +
          ' mod=' +
          JSON.stringify(document.getElementById('runModule').value) +
          ' 长=' +
          runLength(s20Short).toFixed(2) +
          ' clamp=' +
          String(clampRunModuleAt(s20Short, 1.1, 2.0)) +
          ' runs=' +
          (DOC.runs || []).map((r) => r.id).join(',')
      );

      wallEdit.tool = '';
      wallEdit.sel = null;
      wallEdit.moved = false;
      drag = null;
      document.getElementById('runModule').value = '';
      DOC.imported = s20Doc0.imported;
      DOC.floorOutline = s20Doc0.floorOutline;
      DOC.runs = s20Doc0.runs || [];
      fit2DToContent();
      drawWallEdit();
    }

    /* ===== 14. 离散动作各自成一步（E19 轮㉒：撤销一次不该丢掉两件事） ===== */
    {
      /* 手势键同时当两个身份用：「同一个手势」与「同一种动作」。
         连续手势（拖动中、滑块、连续方向键微调）合并是对的；
         离散动作（一次放置、一次 +90°、一次键盘旋转、一次开关切换）每次都是新手势，
         合并的结果是「撤销一次同时撤掉两件事」与「撤销按钮亮着、按下去什么都没发生」。 */
      await pbReset();
      undoRing.length = 0;
      redoRing.length = 0;
      lastGesture = null;
      updateUndoUI();
      const u22z = () =>
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })
        );
      const u22y = () =>
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true, cancelable: true })
        );
      const u22fx = () => DOC.fixtures.filter((f) => f.src === 'user').length;
      // 两个互不干扰的落点（同一个点第二次点会选中已放的洁具，测的就不是「放两件」了）
      const u22cand = [];
      const u22sx = (BX1 - BX0) / 14,
        u22sy = (BY1 - BY0) / 14;
      for (let gx = BX0 + u22sx; gx <= BX1 - u22sx; gx += u22sx)
        for (let gy = BY0 + u22sy; gy <= BY1 - u22sy; gy += u22sy)
          if (pbClearance(gx, gy) > 0.9) u22cand.push([gx, gy]);
      let u22p2 = pbFree,
        u22bd = -1;
      for (const c of u22cand) {
        const d = Math.hypot(c[0] - pbFree[0], c[1] - pbFree[1]);
        if (d > u22bd) {
          u22bd = d;
          u22p2 = c;
        }
      }

      /* 14.1 连放两个洁具（fxPlace 是常量键） */
      await enterEdit();
      await setTool('fx');
      Q('#fxType').value = 'toilet';
      await tap(pbFree[0], pbFree[1]);
      const u22f1 = u22fx();
      Q('#fxType').value = 'basin';
      await tap(u22p2[0], u22p2[1]);
      const u22f2 = u22fx();
      const u22ring1 = undoRing.length;
      u22z();
      await tick();
      const u22f3 = u22fx();
      T(
        'pb-undo-two-fixtures-each-step',
        u22f1 === 1 && u22f2 === 2 && u22f3 === 1,
        '放第一件=' + u22f1 + ' 放第二件=' + u22f2 + ' 撤销一次后=' + u22f3 + '（期望剩 1 件） 环=' + u22ring1
      );
      u22y();
      await tick();
      T('pb-undo-two-fixtures-redo', u22fx() === 2, '重做后=' + u22fx() + '（期望 2）');
      await pbReset();

      /* 14.2 同一件商品连点两次（addItem 的键带 refId → 同 ref 就合并） */
      Q('#btnWallEdit').click();
      await tick();
      const u22ref = CATALOG[0].id;
      const u22i0 = state.items.length;
      addItem(u22ref);
      addItem(u22ref);
      const u22i1 = state.items.length;
      u22z();
      await tick();
      T(
        'pb-undo-two-adds-each-step',
        u22i1 === u22i0 + 2 && state.items.length === u22i0 + 1,
        '连点两次=' + (u22i1 - u22i0) + ' 件，撤销一次后剩 ' + (state.items.length - u22i0) + ' 件（期望 1）'
      );

      /* 14.3 属性面板「+90°」按两次（rot90 的键带 uid，而 uid 不变） */
      // 上面那次撤销把两件全撤掉了（就是被证明的 bug），这里重新给一件干净的被测件
      state.items = [];
      selected = null;
      addItem(u22ref);
      await tick();
      const u22it = state.items[state.items.length - 1];
      // 撤销会把 state.items 换成从快照里重新解析出来的一批新对象 → 必须按 uid 重新找
      const u22rotNow = () => {
        const c = state.items.find((i) => i.uid === u22it.uid);
        return c ? ((c.rot % 360) + 360) % 360 : NaN;
      };
      Q('#pRot90').click();
      await tick();
      Q('#pRot90').click();
      await tick();
      const u22rot1 = u22rotNow();
      u22z();
      await tick();
      const u22rot2 = u22rotNow();
      T(
        'pb-undo-rot90-each-step',
        u22rot1 === 180 && u22rot2 === 90,
        '按两次 +90° 后 rot=' + u22rot1 + '°，撤销一次后 rot=' + u22rot2 + '°（期望 90）'
      );

      /* 14.4 键盘 R 转两次（key:rot 同样带 uid） */
      key('r', document.body);
      await tick();
      key('r', document.body);
      await tick();
      const u22rot3 = u22rotNow();
      u22z();
      await tick();
      const u22rot4 = u22rotNow();
      T(
        'pb-undo-key-rot-each-step',
        u22rot3 === u22rot2 + 30 && u22rot4 === u22rot3 - 15,
        '再按两次 R 后 rot=' + u22rot3 + '°，撤销一次后 rot=' + u22rot4 + '°（期望 195）'
      );

      /* 14.5 对照组：复制两次本来就该是两步（第二次的面板选中已经换成了新的 uid） */
      const u22d0 = state.items.length;
      Q('#pDup').click();
      await tick();
      Q('#pDup').click();
      await tick();
      const u22d1 = state.items.length;
      u22z();
      await tick();
      T(
        'pb-undo-dup-two-steps-control',
        u22d1 === u22d0 + 2 && state.items.length === u22d0 + 1,
        '复制两次=' + (u22d1 - u22d0) + ' 件，撤销一次后多 ' + (state.items.length - u22d0) + ' 件（期望 1）'
      );
      state.items = [];
      selected = null;
      drawFurniture();
      save();

      /* 14.6 同一段墙连续改两次类型（segType 的键带墙 id，走 wallView 代理的 setter） */
      await enterEdit();
      await setTool('select');
      fit2DToContent();
      await tick();
      const u22w = pushUserWall([pbFree[0] - 1.5, pbFree[1] + 1.2], [pbFree[0] + 1.5, pbFree[1] + 1.2], 'w', 9);
      geoChanged();
      wallEdit.sel = { kind: 'w', id: u22w.id };
      drawWallEdit();
      await tick();
      const u22typeCtl = Q('#wType');
      const u22t = () => {
        const x = effWalls().find((v) => v._id === u22w.id);
        return x ? x.t : '?';
      };
      const u22t0 = u22t();
      u22typeCtl.value = 'd';
      u22typeCtl.dispatchEvent(new Event('change'));
      await tick();
      const u22t1 = u22t();
      u22typeCtl.value = 'o';
      u22typeCtl.dispatchEvent(new Event('change'));
      await tick();
      const u22t2 = u22t();
      u22z();
      await tick();
      const u22t3 = u22t();
      T(
        'pb-undo-seg-type-each-step',
        u22t0 === 'w' && u22t1 === 'd' && u22t2 === 'o' && u22t3 === 'd',
        '类型 ' +
          u22t0 +
          '→' +
          u22t1 +
          '→' +
          u22t2 +
          '，撤销一次后=' +
          u22t3 +
          '（期望回到 d；回到 w = 一次撤销撤掉了两件事）'
      );
      DOC.walls = DOC.walls.filter((e) => e.id !== u22w.id);
      DOC.windows = (DOC.windows || []).filter((e) => e.id !== u22w.id);
      wallEdit.sel = null;
      geoChanged();

      /* 14.7 同一块台面上连放两个模块（runMod 的键带 run id） */
      {
        const u22doc0 = JSON.parse(JSON.stringify(DOC));
        DOC.imported = true;
        DOC.floorOutline = [
          [0, 0],
          [12, 0],
          [12, 8],
          [0, 8],
        ];
        const u22run = pushUserRun(
          [
            [1, 1],
            [9, 1],
          ],
          60 / 30.48,
          90 / 30.48
        );
        wallEdit.sel = { kind: 'run', id: u22run.id };
        tryPlaceRunModule('fridge', u22run, [3, 1]);
        await tick();
        tryPlaceRunModule('sink', u22run, [6, 1]);
        await tick();
        const u22m1 = ((DOC.runs.find((r) => r.id === u22run.id) || {}).modules || []).length;
        u22z();
        await tick();
        const u22m2 = ((DOC.runs.find((r) => r.id === u22run.id) || {}).modules || []).length;
        T(
          'pb-undo-two-run-modules-each-step',
          u22m1 === 2 && u22m2 === 1,
          '连放两个模块=' + u22m1 + '，撤销一次后=' + u22m2 + '（期望 1）'
        );
        wallEdit.sel = null;
        DOC.imported = u22doc0.imported;
        DOC.floorOutline = u22doc0.floorOutline;
        DOC.runs = u22doc0.runs || [];
        fit2DToContent();
        drawWallEdit();
      }

      /* 14.8 对照组：连续手势照旧只算一步（修离散动作不能把连续手势也拆开） */
      await pbReset();
      undoRing.length = 0;
      redoRing.length = 0;
      lastGesture = null;
      updateUndoUI();
      await enterEdit();
      await setTool('select');
      fit2DToContent();
      await tick();
      wallEdit.sel = { kind: 'w', id: pbWall._id };
      drawWallEdit();
      const u22ring0 = undoRing.length;
      for (let i = 0; i < 5; i++) {
        key('ArrowRight', document.body);
        await tick();
      }
      T(
        'pb-undo-nudge-still-coalesces',
        undoRing.length === u22ring0 + 1,
        '连按 5 次方向键后环 +' + (undoRing.length - u22ring0) + '（期望 +1：连续微调只算一步）'
      );
      u22z();
      await tick();
      await pbReset();
      DOC.runs = (DOC.runs || []).filter((r) => r.src !== 'user');
      geoChanged();
      undoRing.length = 0;
      redoRing.length = 0;
      lastGesture = null;
      updateUndoUI();
      T(
        'pb-undo-round22-clean-exit',
        DOC.fixtures.filter((f) => f.src === 'user').length === 0 &&
          DOC.doors.filter((e) => e.src === 'user').length === 0 &&
          (DOC.runs || []).filter((r) => r.src === 'user').length === 0 &&
          undoRing.length === 0,
        '洁具 ' +
          DOC.fixtures.filter((f) => f.src === 'user').length +
          ' 门 ' +
          DOC.doors.filter((e) => e.src === 'user').length +
          ' 台面 ' +
          (DOC.runs || []).filter((r) => r.src === 'user').length +
          ' 环 ' +
          undoRing.length
      );
    }

    /* ===== 15. 检视面板：撤销覆盖 / 旋转口径 / 自定义件尺寸上下限（E19 轮㉓） ===== */
    {
      /* 探针实测（work/_p23_probe*.html）：
         · 改颜色 / 色温 / 亮度不进撤销环 → 改完按 Ctrl+Z 撤掉的是「放这件家具」那一步（家具直接消失）
         · 旋转框里重打同一个数字 → 环 +1 而什么都没改 → 第一次 Ctrl+Z 什么都没发生，要按第二次
         · 旋转框输入 720 → 框显示 720 而滑块显示 0（同一时刻两个控件读数矛盾），再按 +90° 跳到 90
         · 自定义件尺寸没有上下限：99999cm 收（2D 图例 72178px = 户型宽的 72 倍，盖住整张图）、
           0.1cm 收（0.07px，隐形且点不中 → 选不中也就删不掉）、高 -5cm 收（3D bbox y −0.164..0.000ft） */
      await pbReset();
      state.items = [];
      drawFurniture();
      save();
      undoRing.length = 0;
      redoRing.length = 0;
      lastGesture = null;
      updateUndoUI();
      const u23z = () =>
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })
        );
      const sel23 = (uid) => {
        selected = uid;
        updateProps();
      };
      const item23 = (uid) => state.items.find((i) => i.uid === uid) || null;
      const lastUid23 = () => state.items[state.items.length - 1].uid;

      // 15.1 改颜色必须能撤，而且撤的是颜色本身（不是「放这件家具」）
      addItem(CATALOG[0].id);
      await tick();
      const cUid = lastUid23();
      sel23(cUid);
      const cBefore = item23(cUid).color; // undefined = 跟着目录配色
      document.getElementById('pColor').value = '#ff0000';
      document.getElementById('pColor').dispatchEvent(new Event('input'));
      await tick();
      const cAfter = item23(cUid).color;
      u23z();
      await tick();
      const cIt = item23(cUid);
      T(
        'pb-undo-color-each-step',
        cAfter === '#ff0000' && !!cIt && cIt.color === cBefore,
        '颜色 ' +
          String(cBefore) +
          ' → ' +
          cAfter +
          ' → Ctrl+Z → ' +
          (cIt ? String(cIt.color) : '（件没了）') +
          ' 环 ' +
          undoRing.length
      );

      // 15.2 色温 / 亮度同理（可调光的落地灯才有这两格）
      undoRing.length = 0;
      redoRing.length = 0;
      lastGesture = null;
      addItem('hw-02e');
      await tick();
      const lUid = lastUid23();
      sel23(lUid);
      const l0 = { cct: item23(lUid).cct, dim: item23(lUid).dim };
      document.getElementById('pCCT').value = '2200';
      document.getElementById('pCCT').dispatchEvent(new Event('input'));
      await tick();
      const cctSet = item23(lUid).cct;
      u23z();
      await tick();
      const lIt1 = item23(lUid);
      T(
        'pb-undo-cct-each-step',
        cctSet === 2200 && !!lIt1 && lIt1.cct === l0.cct,
        '色温 ' + String(l0.cct) + ' → ' + cctSet + ' → Ctrl+Z → ' + (lIt1 ? String(lIt1.cct) : '（件没了）')
      );
      document.getElementById('pDim').value = '20';
      document.getElementById('pDim').dispatchEvent(new Event('input'));
      await tick();
      const dimSet = item23(lUid) ? item23(lUid).dim : null;
      u23z();
      await tick();
      const lIt2 = item23(lUid);
      T(
        'pb-undo-dim-each-step',
        dimSet === 0.2 && !!lIt2 && lIt2.dim === l0.dim,
        '亮度 ' + String(dimSet) + ' → Ctrl+Z → ' + (lIt2 ? String(lIt2.dim) : '（件没了）')
      );

      // 15.3 旋转框：口径必须与滑块 / +90° / [ ] 一致（mod 360）
      undoRing.length = 0;
      redoRing.length = 0;
      lastGesture = null;
      addItem(CATALOG[1].id);
      await tick();
      const rUid = lastUid23();
      sel23(rUid);
      document.getElementById('pRot').value = '720';
      document.getElementById('pRot').dispatchEvent(new Event('input'));
      await tick();
      const rIt = item23(rUid);
      const boxV = Number(document.getElementById('pRot').value);
      const sliderV = Number(document.getElementById('pRotSlider').value);
      T(
        'pb-rot-box-normalized',
        rIt.rot === 0 && boxV === 0 && sliderV === 0,
        '输入 720 → it.rot=' + rIt.rot + ' 框=' + boxV + ' 滑块=' + sliderV
      );
      document.getElementById('pRot90').click();
      await tick();
      T(
        'pb-rot-box-then-90-continuous',
        item23(rUid).rot === 90,
        '+90° 之后 it.rot=' + item23(rUid).rot + ' 框=' + document.getElementById('pRot').value
      );

      // 15.3a 逐字符打小数：number input 的半成品文本（"45."）不该被当成 0 应用到家具，
      // 归一后的回写也不该吃掉用户正在打的小数点（面板宣称 0.1° 精度）。
      // 模拟必须用真插入（execCommand insertText）：直接给 number input 赋 "45." 会被浏览器判非法吞掉。
      undoRing.length = 0;
      redoRing.length = 0;
      lastGesture = null;
      addItem(CATALOG[1].id);
      await tick();
      const decUid = lastUid23();
      sel23(decUid);
      const decBox = document.getElementById('pRot');
      decBox.focus();
      decBox.value = '';
      decBox.dispatchEvent(new Event('input'));
      await tick();
      const decSteps = [];
      const decVals = [];
      for (const ch of ['4', '5', '.', '5']) {
        document.execCommand('insertText', false, ch); // 真打字：文本累加，非法文本由浏览器保留
        await tick();
        decSteps.push(ch + '→rot=' + item23(decUid).rot + '/框=' + decBox.value);
        decVals.push(item23(decUid).rot);
      }
      const decIt = item23(decUid);
      T(
        'pb-rot-decimal-typing',
        !!decIt && decIt.rot === 45.5 && Number(decBox.value) === 45.5,
        '逐字符打 4 5 . 5：' + decSteps.join(' ') + ' → it.rot=' + (decIt ? decIt.rot : '?')
      );
      // 清空框（准备重打）不该把家具转到 0°；非法文本（"-"）同理
      decBox.value = '';
      decBox.dispatchEvent(new Event('input'));
      await tick();
      const emptyRot = item23(decUid).rot;
      decBox.value = '-';
      decBox.dispatchEvent(new Event('input'));
      await tick();
      const negRot = item23(decUid).rot;
      T(
        'pb-rot-empty-or-invalid-not-applied',
        emptyRot === 45.5 && negRot === 45.5,
        '清空框 → rot=' + emptyRot + '；打「-」→ rot=' + negRot + '（都该仍是 45.5，不该被当成 0°）'
      );

      // 15.3b 焦点还在旋转框里时 Ctrl+Z 必须生效，而且面板数字要跟着回去（bug 猎 #45 / #46）
      undoRing.length = 0;
      redoRing.length = 0;
      lastGesture = null;
      addItem(CATALOG[1].id);
      await tick();
      const gUid = lastUid23();
      sel23(gUid);
      const gBox = document.getElementById('pRot');
      const u23zOn = (el) =>
        el.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true })
        );
      gBox.focus();
      gBox.value = '45';
      gBox.dispatchEvent(new Event('input'));
      await tick();
      document.getElementById('pRot90').click(); // 离散动作：把两次编辑分开
      await tick();
      const gBefore = { rot: item23(gUid).rot, ring: undoRing.length };
      u23zOn(gBox); // 真键盘口径：事件 target 就是那个输入框
      await tick();
      const gIt = item23(gUid);
      const gAfter = {
        rot: gIt ? gIt.rot : null,
        box: Number(document.getElementById('pRot').value),
        slider: Number(document.getElementById('pRotSlider').value),
      };
      T(
        'pb-undo-works-from-rot-input',
        !!gIt && Math.abs(gBefore.rot - 135) < 0.2 && Math.abs(gAfter.rot - 45) < 0.2,
        '焦点在旋转框里按 Ctrl+Z：' + gBefore.rot + '° → ' + String(gAfter.rot) + '°（撤销生效，撤的是那个离散动作）'
      );
      T(
        'pb-props-panel-follows-undo',
        Math.abs(gAfter.rot - 45) < 0.2 && gAfter.box === gAfter.rot && gAfter.slider === gAfter.rot,
        '撤销后面板跟着回去：it.rot=' + String(gAfter.rot) + ' 框=' + gAfter.box + ' 滑块=' + gAfter.slider
      );
      // 对照组：自由文本框里的 Ctrl+Z 属于浏览器自己的「撤销打字」，不该被抢走
      const ringBefore23 = undoRing.length;
      const searchEl = document.getElementById('catSearch');
      searchEl.focus();
      u23zOn(searchEl);
      await tick();
      T(
        'pb-undo-key-not-stolen-in-search',
        undoRing.length === ringBefore23 && item23(gUid) && Math.abs(item23(gUid).rot - 45) < 0.2,
        '搜索框里按 Ctrl+Z：环 ' + ringBefore23 + ' → ' + undoRing.length + '（没被抢走），rot 仍 ' + item23(gUid).rot
      );
      searchEl.value = '';
      searchEl.dispatchEvent(new Event('input'));
      await tick();

      // 15.4 死步：重打同一个数字不该占一步（一次按键就该撤掉真正那一步）
      undoRing.length = 0;
      redoRing.length = 0;
      lastGesture = null;
      addItem(CATALOG[2].id);
      await tick();
      const dUid = lastUid23();
      sel23(dUid);
      const r1 = undoRing.length;
      document.getElementById('pRot').value = String(item23(dUid).rot);
      document.getElementById('pRot').dispatchEvent(new Event('input'));
      await tick();
      const r2 = undoRing.length;
      const n1 = state.items.length;
      u23z();
      await tick();
      const n2 = state.items.length;
      T(
        'pb-undo-no-dead-step',
        n2 === n1 - 1,
        '环 ' +
          r1 +
          '→' +
          r2 +
          '（重打同一个数字）· 件数 ' +
          n1 +
          ' → 一次 Ctrl+Z → ' +
          n2 +
          '（期望 ' +
          (n1 - 1) +
          '）'
      );

      // 15.5 自定义件尺寸上下限：一个笔误不该毁掉整张图
      const cfN0 = state.customCat.length;
      const cfTry = (w, d, h) => {
        document.getElementById('cfName').value = '体检件';
        document.getElementById('cfW').value = String(w);
        document.getElementById('cfD').value = String(d);
        document.getElementById('cfH').value = String(h);
        document.getElementById('cfImg').value = '';
        document.getElementById('cfAdd').click();
      };
      const cfToast = () => (document.getElementById('toast') || {}).textContent || '';
      cfTry(99999, 100, 100);
      await tick();
      const hugeMsg = cfToast();
      T(
        'pb-custom-size-huge-rejected',
        state.customCat.length === cfN0 && /1200/.test(hugeMsg),
        '宽 99999 → 目录 ' + state.customCat.length + '/' + cfN0 + ' 提示「' + hugeMsg + '」'
      );
      cfTry(0.1, 0.1, 1);
      await tick();
      T(
        'pb-custom-size-tiny-rejected',
        state.customCat.length === cfN0,
        '宽 0.1 → 目录 ' + state.customCat.length + '/' + cfN0 + ' 提示「' + cfToast() + '」'
      );
      cfTry(50, 50, -5);
      await tick();
      T(
        'pb-custom-size-negative-rejected',
        state.customCat.length === cfN0,
        '高 -5 → 目录 ' + state.customCat.length + '/' + cfN0 + ' 提示「' + cfToast() + '」'
      );
      cfTry(90, 45, 75); // 对照组：正常尺寸必须照收
      await tick();
      T(
        'pb-custom-size-sane-accepted',
        state.customCat.length === cfN0 + 1 && state.items.length > 0,
        '90×45×75 → 目录 ' + state.customCat.length + '/' + cfN0 + ' 件数 ' + state.items.length
      );
      const bb23 = gFurn.getBBox();
      const fp23 = floorPts();
      const pw23 = (Math.max(...fp23.map((p) => p[0])) - Math.min(...fp23.map((p) => p[0]))) * S;
      T(
        'pb-custom-legend-not-cover-plan',
        bb23.width <= pw23 * 1.5,
        '家具图层宽 ' + bb23.width.toFixed(0) + 'px vs 户型宽 ' + pw23.toFixed(0) + 'px'
      );
      // 收尾复位：这一段造的自定义件与摆出来的件都不留给后面
      state.items = [];
      state.customCat = state.customCat.slice(0, cfN0);
      drawFurniture();
      save();
      buildCatalog('');
      undoRing.length = 0;
      redoRing.length = 0;
      lastGesture = null;
      updateUndoUI();
      T(
        'pb-props-round23-clean-exit',
        state.items.length === 0 && state.customCat.length === cfN0 && undoRing.length === 0,
        '件 ' + state.items.length + ' 自定义 ' + state.customCat.length + ' 环 ' + undoRing.length
      );
    }

    /* ===== 16. E19 轮㉔：按屏幕尺寸恒定的叠加层 / 量尺寸标注的归属 ===== */
    {
      /* 两个同族根因（探针实测）：
         ①「按屏幕尺寸恒定」的叠加层（量尺寸标注 / 编辑手柄）在绘制时除以当时的 getScreenCTM().a，
            而 viewBox 变化后不重画 → 滚轮放大 5 次后标注线宽 1.600px→2.577px、字号 10→16.1px；
            fit2DToContent() 后量尺寸 1.878px / 手柄 1.89px、2.835px（基准 1.6 / 1.0 / 1.5）。
         ②量尺寸标注跨的是几何：换户型 / 导入 / 整图重标定不把它作废或跟着搬 →
            旧标注停在原地、读数不再对应它跨的那段。 */
      const r24k = () => {
        const b = svg.viewBox.baseVal;
        return svg.getBoundingClientRect().width / b.width;
      };
      const r24px = (sel, attr) => {
        const e = document.querySelector(sel);
        return e ? parseFloat(e.getAttribute(attr)) * r24k() : null;
      };
      const r24vb = () => svg.viewBox.baseVal.width;
      const r24wheel = (dy, n) => {
        const r = svg.getBoundingClientRect();
        for (let i = 0; i < n; i++)
          svg.dispatchEvent(
            new WheelEvent('wheel', {
              clientX: r.x + r.width / 2,
              clientY: r.y + r.height / 2,
              deltaY: dy,
              bubbles: true,
              cancelable: true,
            })
          );
      };
      const r24nodes = () => document.querySelectorAll('#meas *').length;
      const r24texts = () => [...document.querySelectorAll('#meas text')].map((x) => x.textContent).join(' | ');
      const r24drift = (a, b) => (a === null || b === null ? 9 : Math.abs(b - a) / a);
      const r24last = () => meas.list[meas.list.length - 1];
      const r24len = (m) => Math.hypot(m[1][0] - m[0][0], m[1][1] - m[0][1]);

      await pbReset();
      if (meas.on) measEnd();
      measClear();
      fit2DToContent();
      await tick();
      const fp24 = floorPts();
      const cx24 = (Math.min(...fp24.map((p) => p[0])) + Math.max(...fp24.map((p) => p[0]))) / 2;
      const cy24 = (Math.min(...fp24.map((p) => p[1])) + Math.max(...fp24.map((p) => p[1]))) / 2;

      /* 16.1 量尺寸标注：缩放 / 重新取景后必须还是同一个屏幕尺寸 */
      measStart();
      measClick([cx24 - 2, cy24], false);
      measClick([cx24 + 2, cy24], false);
      await tick();
      const b24Line = r24px('#meas line', 'stroke-width');
      const b24Font = r24px('#meas text', 'font-size');
      T(
        'pb-meas-drawn',
        r24nodes() > 0 && !!b24Line && !!b24Font,
        '标注 ' + r24nodes() + ' 个元素 · 线宽 ' + b24Line + 'px · 字号 ' + b24Font + 'px'
      );
      r24wheel(-100, 5);
      await tick();
      const zi24Line = r24px('#meas line', 'stroke-width');
      const zi24Font = r24px('#meas text', 'font-size');
      T(
        'pb-meas-constant-after-zoom-in',
        r24drift(b24Line, zi24Line) < 0.02 && r24drift(b24Font, zi24Font) < 0.02,
        'viewBox ' +
          r24vb().toFixed(0) +
          '（基准 ' +
          1232 +
          '）→ 线宽 ' +
          zi24Line.toFixed(3) +
          'px（基准 ' +
          b24Line.toFixed(3) +
          '）· 字号 ' +
          zi24Font.toFixed(3) +
          'px（基准 ' +
          b24Font.toFixed(3) +
          '）'
      );
      r24wheel(100, 10);
      await tick();
      const zo24Line = r24px('#meas line', 'stroke-width');
      const zo24Font = r24px('#meas text', 'font-size');
      T(
        'pb-meas-constant-after-zoom-out',
        r24drift(b24Line, zo24Line) < 0.02 && r24drift(b24Font, zo24Font) < 0.02,
        'viewBox ' + r24vb().toFixed(0) + ' → 线宽 ' + zo24Line.toFixed(3) + 'px · 字号 ' + zo24Font.toFixed(3) + 'px'
      );

      /* 16.2 编辑手柄：同一个处理器里 wallEdit 重画了、meas 没重画（对照组 + 真红的那条） */
      await enterEdit();
      const hw24 = effWalls()
        .filter((s) => s.t === 'w')
        .sort((a, b) => Math.hypot(b.x2 - b.x1, b.y2 - b.y1) - Math.hypot(a.x2 - a.x1, a.y2 - a.y1))[0];
      wallEdit.sel = { kind: 'w', id: hw24._id };
      updateWallBarFromSel();
      drawWallEdit();
      await tick();
      const b24Dash = r24px('#wedit line[stroke="#3d8bfd"]', 'stroke-width');
      const b24Sel = r24px('#wedit line[stroke="#26e0a8"]', 'stroke-width');
      T('pb-edit-handles-drawn', !!b24Dash && !!b24Sel, '墙中心线 ' + b24Dash + 'px · 选中描边 ' + b24Sel + 'px');
      r24wheel(-100, 5);
      await tick();
      const zi24Dash = r24px('#wedit line[stroke="#3d8bfd"]', 'stroke-width');
      const zi24Sel = r24px('#wedit line[stroke="#26e0a8"]', 'stroke-width');
      T(
        'pb-edit-handles-constant-after-zoom',
        r24drift(b24Dash, zi24Dash) < 0.02 && r24drift(b24Sel, zi24Sel) < 0.02,
        '对照组：滚轮后手柄照旧恒定 中心线 ' + zi24Dash.toFixed(3) + 'px · 选中 ' + zi24Sel.toFixed(3) + 'px'
      );
      /* 重新取景这一条要量得确定：先缩小 10 次（viewBox 变大）并用应用自己的重画
         （build2D 末尾就是 drawMeasure + drawWallEdit）在新缩放下重画一遍基准，
         然后 fit2DToContent() 把 viewBox 改回去 —— 中间不 tick，不给任何定时器机会。 */
      r24wheel(100, 10);
      drawMeasure();
      drawWallEdit();
      const vb24Wide = r24vb();
      const w24Line = r24px('#meas line', 'stroke-width');
      const w24Font = r24px('#meas text', 'font-size');
      const w24Dash = r24px('#wedit line[stroke="#3d8bfd"]', 'stroke-width');
      const w24Sel = r24px('#wedit line[stroke="#26e0a8"]', 'stroke-width');
      fit2DToContent();
      const rf24Dash = r24px('#wedit line[stroke="#3d8bfd"]', 'stroke-width');
      const rf24Sel = r24px('#wedit line[stroke="#26e0a8"]', 'stroke-width');
      const rf24Line = r24px('#meas line', 'stroke-width');
      const rf24Font = r24px('#meas text', 'font-size');
      T(
        'pb-overlays-constant-after-refit',
        r24drift(w24Dash, rf24Dash) < 0.02 &&
          r24drift(w24Sel, rf24Sel) < 0.02 &&
          r24drift(w24Line, rf24Line) < 0.02 &&
          r24drift(w24Font, rf24Font) < 0.02,
        'viewBox ' +
          vb24Wide.toFixed(0) +
          ' → ' +
          r24vb().toFixed(0) +
          '：标注 ' +
          rf24Line.toFixed(3) +
          '/' +
          rf24Font.toFixed(3) +
          'px（基准 ' +
          w24Line.toFixed(3) +
          '/' +
          w24Font.toFixed(3) +
          '）· 手柄 ' +
          rf24Dash.toFixed(3) +
          '/' +
          rf24Sel.toFixed(3) +
          'px（基准 ' +
          w24Dash.toFixed(3) +
          '/' +
          w24Sel.toFixed(3) +
          '）'
      );
      drawMeasure();
      drawWallEdit();
      if (wallEdit.on) Q('#btnWallEdit').click();
      await tick();

      /* 16.3 换户型 / 导入：旧标注属于上一份几何，不该留在图上 */
      let imp24 = null,
        imp24Err = '';
      try {
        const txt = await (await fetch('../tests/fixtures/apartment-mm.dxf')).text();
        imp24 = window.MINIDEN_GEO.importDxf(new window.DxfParser().parseSync(txt), {
          name: 'planbuild-r24',
        });
      } catch (e) {
        imp24Err = e.message;
      }
      if (!imp24) T('pb-meas-import', false, imp24Err);
      else {
        measStart();
        measClick([cx24 - 1, cy24], false);
        measClick([cx24 + 1, cy24], false);
        await tick();
        const pre24 = r24nodes();
        applyImportedDoc(imp24.doc, imp24.info);
        await tick();
        fit2DToContent();
        await tick();
        T(
          'pb-meas-dropped-on-import',
          pre24 > 0 && r24nodes() === 0,
          '导入前 ' + pre24 + ' 个元素 · 导入后 ' + r24nodes() + ' 个（旧标注量的是另一份户型的坐标）'
        );

        /* 16.4 整图重标定：标注跨的是几何 → 必须跟着搬，读数自动跟着变 */
        await enterEdit();
        const iw24 = effWalls()
          .filter((s) => s.t === 'w')
          .sort((a, b) => Math.hypot(b.x2 - b.x1, b.y2 - b.y1) - Math.hypot(a.x2 - a.x1, a.y2 - a.y1))[0];
        const wid24 = iw24._id;
        const L0 = Math.hypot(iw24.x2 - iw24.x1, iw24.y2 - iw24.y1);
        wallEdit.sel = { kind: 'w', id: wid24 };
        updateWallBarFromSel();
        await tick();
        measStart();
        measClick([iw24.x1, iw24.y1], false);
        measClick([iw24.x2, iw24.y2], false);
        await tick();
        const lab0 = r24texts();
        const m0 = r24last();
        const mL0 = r24len(m0);
        T(
          'pb-meas-on-wall',
          Math.abs(mL0 - L0) < 0.02,
          '标注跨 ' + mL0.toFixed(3) + 'ft · 墙长 ' + L0.toFixed(3) + 'ft · 读数 ' + lab0
        );
        Q('#wLen').value = String(Math.round(L0 * 2 * 30.48));
        Q('#calBtn').click();
        await tick();
        Q('#calBtn').click();
        await tick();
        const g24 = entById(wid24).geom;
        const L1 = Math.hypot(g24.x2 - g24.x1, g24.y2 - g24.y1);
        const m1 = r24last();
        const mL1 = r24len(m1);
        const dEnd = Math.min(
          Math.hypot(m1[0][0] - g24.x1, m1[0][1] - g24.y1),
          Math.hypot(m1[0][0] - g24.x2, m1[0][1] - g24.y2)
        );
        T(
          'pb-meas-follows-rescale',
          r24nodes() > 0 && dEnd < 0.03 && Math.abs(mL1 - L1) < 0.03,
          '×2 后墙长 ' +
            L1.toFixed(3) +
            'ft · 标注跨 ' +
            mL1.toFixed(3) +
            'ft · 端点偏差 ' +
            dEnd.toFixed(3) +
            'ft · 读数 ' +
            r24texts() +
            '（原 ' +
            lab0 +
            '）'
        );
        /* 重标定的重画序列是 geoChanged()（build2D 里重画叠加层）+ fit2DToContent()（改 viewBox）：
           顺序反了就会把标注与手柄在屏幕上放大一整倍。 */
        const rs24Line = r24px('#meas line', 'stroke-width');
        const rs24Font = r24px('#meas text', 'font-size');
        const rs24Dash = r24px('#wedit line[stroke="#3d8bfd"]', 'stroke-width');
        T(
          'pb-overlays-constant-after-rescale',
          r24drift(w24Line, rs24Line) < 0.02 &&
            r24drift(w24Font, rs24Font) < 0.02 &&
            (rs24Dash === null || r24drift(w24Dash, rs24Dash) < 0.02),
          '重标定后 viewBox ' +
            r24vb().toFixed(0) +
            '：标注 ' +
            rs24Line.toFixed(3) +
            '/' +
            rs24Font.toFixed(3) +
            'px（基准 ' +
            w24Line.toFixed(3) +
            '/' +
            w24Font.toFixed(3) +
            '）· 手柄 ' +
            (rs24Dash === null ? '无' : rs24Dash.toFixed(3)) +
            'px（基准 ' +
            w24Dash.toFixed(3) +
            '）'
        );
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'z',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          })
        );
        await tick();
        const g24b = entById(wid24).geom;
        const L0b = Math.hypot(g24b.x2 - g24b.x1, g24b.y2 - g24b.y1);
        const m2 = r24last();
        const mL2 = r24len(m2);
        T(
          'pb-meas-restored-by-undo',
          Math.abs(L0b - L0) < 0.05 && Math.abs(mL2 - L0) < 0.05 && r24texts() === lab0,
          '撤销整图缩放：墙 ' + L0b.toFixed(3) + 'ft · 标注跨 ' + mL2.toFixed(3) + 'ft · 读数 ' + r24texts()
        );
        switchPlan(BUILTIN_PLAN_ID, true);
        await tick();
        T('pb-meas-dropped-on-plan-switch', r24nodes() === 0, '切回内置户型后标注 ' + r24nodes() + ' 个元素');
      }
      if (meas.on) measEnd();
      measClear();
      wallEdit.sel = null;
      drawWallEdit();
      await pbReset();
      T(
        'pb-meas-round24-clean-exit',
        r24nodes() === 0 && PLAN_ID === BUILTIN_PLAN_ID && !DOC.imported,
        '标注 ' +
          r24nodes() +
          ' · 户型 ' +
          (PLAN_ID === BUILTIN_PLAN_ID ? '内置' : PLAN_ID) +
          ' · imported=' +
          DOC.imported
      );
    }

    /* ===== 17. E19 轮㉕：编辑模式跨视图 + 3D 静态场景的同步时机 ===== */
    {
      /* 选一处连门都离得远的空地：pbClearance 只算墙/洁具/柱，门的命中区在墙垛缺口里，
         点上去会选中门而不是我新画的墙（探针实测：sel={"kind":"door","id":"d1"}）。 */
      const free25 = (() => {
        let best = null,
          bs = -1;
        const stepX = (BX1 - BX0) / 14,
          stepY = (BY1 - BY0) / 14;
        for (let gx = BX0 + stepX; gx <= BX1 - stepX; gx += stepX)
          for (let gy = BY0 + stepY; gy <= BY1 - stepY; gy += stepY) {
            let d = pbClearance(gx, gy);
            for (const dd of effDoors()) if (dd && dd.x1 != null) d = Math.min(d, distSeg(gx, gy, dd));
            if (d > bs) {
              bs = d;
              best = [gx, gy];
            }
          }
        return { p: best || pbFree, clear: bs };
      })();
      const [fx25, fy25] = free25.p;
      await enterEdit();
      pushUserWall(fx25 - 2, fy25, fx25 + 2, fy25, 'w', 8);
      geoChanged();
      drawWallEdit(); // 新实体要重画命中区（命中区是命中唯一来源，AGENTS §5.1）
      await tick();
      const wid25 = DOC.walls[DOC.walls.length - 1].id;
      for (const off of [0, 1.2, -1.2, 0.7, -0.7]) {
        await tap(fx25 + off, fy25);
        if (wallEdit.sel && wallEdit.sel.kind === 'w' && wallEdit.sel.id === wid25) break;
      }
      const selOK = !!wallEdit.sel && wallEdit.sel.kind === 'w' && wallEdit.sel.id === wid25;
      T(
        'pb-edit-selected-user-wall',
        selOK,
        'sel=' + JSON.stringify(wallEdit.sel) + ' 期望墙 ' + wid25 + ' 净空 ' + free25.clear.toFixed(2) + 'ft'
      );
      const bar25 = () => getComputedStyle(Q('#wallbar')).display;
      T('pb-edit-toolbar-visible-in-2d', bar25() !== 'none', '#wallbar display=' + bar25());

      /* 17.1 切到 3D：模式可以跟着走（#btnWallEdit 还亮着），但属于 2D 的工具条不该糊在 3D 画布上 */
      setView('3d');
      await wait3D();
      T(
        'pb-edit-mode-kept-across-view',
        wallEdit.on === true && !!wallEdit.sel && wallEdit.sel.id === wid25,
        'on=' + wallEdit.on + ' sel=' + JSON.stringify(wallEdit.sel)
      );
      /* F1：改户型在 3D 里不再藏工具条 / 强切 2D——结构工具灰掉（只剩「选择」）、画布中间出提示卡「切到 2D 平面」 */
      const dis25 = Array.from(document.querySelectorAll('#wtoolSeg button'))
        .filter((b) => b.dataset.t !== 'select')
        .every((b) => b.disabled);
      const note25 = getComputedStyle(Q('#modeNote')).display;
      T(
        'pb-edit-toolbar-hidden-in-3d',
        bar25() !== 'none' && dis25 && !Q('#wtoolSeg button[data-t="select"]').disabled && note25 !== 'none',
        '3D 俯瞰里工具条=' + bar25() + ' · 结构工具都灰=' + dis25 + ' · 提示卡=' + note25
      );

      /* 17.2 在 3D 里按方向键：2D 被藏着，用户看不见被改的几何 —— 不该隔空偷偷改 */
      const g25a = JSON.stringify(entById(wid25).geom);
      const ring25a = undoRing.length;
      for (const k of ['ArrowRight', 'ArrowRight', 'ArrowRight']) {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
        await tick();
      }
      const moved25 = g25a !== JSON.stringify(entById(wid25).geom);
      T(
        'pb-edit-keys-inert-in-3d',
        !moved25 && undoRing.length === ring25a,
        '墙 ' + wid25 + ' 几何被改=' + moved25 + ' · 撤销环 ' + ring25a + '→' + undoRing.length
      );

      /* 17.3 在 3D 里按 Delete：静默删掉一段墙，而 3D 里那堵墙还立着 */
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
      await tick();
      await tick();
      T(
        'pb-edit-delete-in-3d-not-silent',
        !!entById(wid25) && !DOC.hidden.walls.includes(wid25) && undoRing.length === ring25a,
        '墙 ' + wid25 + ' 还在文档里=' + !!entById(wid25) + ' · 撤销环 ' + ring25a + '→' + undoRing.length
      );

      /* 17.4 3D 在场时几何变了（任何路径）→ 静态场景必须重建，不能只标脏等下一次切视图 */
      const grp25 = three && three.staticGroup;
      const v25a = staticVerts();
      const off25 = Math.max(0.8, Math.min(1.4, free25.clear * 0.4));
      pushUserWall(fx25 - 2, fy25 + off25, fx25 + 2, fy25 + off25, 'w', 8);
      geoChanged();
      await tick();
      await tick();
      const rebuilt25 = three.staticGroup !== grp25;
      const v25b = staticVerts();
      const hit25 = rayDown(fx25, fy25 + off25);
      T(
        'pb-3d-rebuilds-on-geo-change-in-3d',
        rebuilt25 && v25b > v25a,
        'staticGroup 换了=' +
          rebuilt25 +
          ' · verts ' +
          v25a +
          '→' +
          v25b +
          ' · 新墙处射线=' +
          (hit25 ? 'y=' + hit25.point.y.toFixed(2) : '没有')
      );

      /* 17.5 回 2D：编辑快捷键照常工作（对照组，别把修好的东西修坏） */
      setView('2d');
      await tick();
      wallEdit.sel = { kind: 'w', id: wid25 };
      const g25b = JSON.stringify(entById(wid25).geom);
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      await tick();
      const moved25b = g25b !== JSON.stringify(entById(wid25).geom);
      T('pb-edit-keys-work-in-2d', moved25b, '2D 里微调生效=' + moved25b + ' · 工具条 ' + bar25());

      await pbReset();
      setView('2d');
      await tick();
      T(
        'pb-round25-clean-exit',
        DOC.walls.filter((e) => e.src === 'user').length === 0 && PLAN_ID === BUILTIN_PLAN_ID && bar25() !== 'none',
        'userWalls=' +
          DOC.walls.filter((e) => e.src === 'user').length +
          ' · 户型 ' +
          (PLAN_ID === BUILTIN_PLAN_ID ? '内置' : PLAN_ID) +
          ' · 工具条 ' +
          bar25()
      );
    }

    /* ===== 18. E19 轮㉗：换户型时编辑层的作废（悬空选中 / 进行中的画墙链） ===== */
    {
      const plans27_0 = PLAN_REG.plans.length;
      const e27Pick = (id) => {
        const sel = Q('#planSel');
        sel.value = id;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const box27 = () => {
        const fp = floorPts() || [];
        const a = [1e9, 1e9, -1e9, -1e9];
        for (const q of fp) {
          a[0] = Math.min(a[0], q[0]);
          a[1] = Math.min(a[1], q[1]);
          a[2] = Math.max(a[2], q[0]);
          a[3] = Math.max(a[3], q[1]);
        }
        return a;
      };
      const key27 = (k) =>
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      const msg27 = () => (Q('#wMsg') || {}).textContent || '';

      await enterEdit();
      // 选一处连门都离得远的空地（同 §17 口径：门的命中区在墙垛缺口里，点上去会选中门）
      const free27 = (() => {
        let best = null,
          bs = -1;
        const stepX = (BX1 - BX0) / 14,
          stepY = (BY1 - BY0) / 14;
        for (let gx = BX0 + stepX; gx <= BX1 - stepX; gx += stepX)
          for (let gy = BY0 + stepY; gy <= BY1 - stepY; gy += stepY) {
            let d = pbClearance(gx, gy);
            for (const dd of effDoors()) if (dd && dd.x1 != null) d = Math.min(d, distSeg(gx, gy, dd));
            if (d > bs) {
              bs = d;
              best = [gx, gy];
            }
          }
        return best || pbFree;
      })();
      const [fx27, fy27] = free27;
      pushUserWall(fx27 - 2, fy27, fx27 + 2, fy27, 'w', 8);
      geoChanged();
      drawWallEdit();
      await tick();
      const wid27 = DOC.walls[DOC.walls.length - 1].id;
      for (const off of [0, 1.2, -1.2, 0.7, -0.7]) {
        await tap(fx27 + off, fy27);
        if (wallEdit.sel && wallEdit.sel.kind === 'w' && wallEdit.sel.id === wid27) break;
      }
      const sel27 = !!wallEdit.sel && wallEdit.sel.id === wid27;
      const msg27a = msg27();
      T(
        'pb-edit27-wall-selected',
        sel27 && /长 /.test(msg27a),
        'sel=' + JSON.stringify(wallEdit.sel) + ' · #wMsg=' + JSON.stringify(msg27a)
      );

      /* 18.1 新建空白户型：上一份户型的选中必须作废，工具条不能描述一个不存在的东西 */
      Q('#btnPlanNew').click();
      await tick();
      const blank27a = PLAN_ID;
      const msg27b = msg27();
      T(
        'pb-edit27-plan-new-clears-selection',
        wallEdit.sel === null && /悬停会亮出墙体/.test(msg27b) && msg27b !== msg27a,
        'sel=' + JSON.stringify(wallEdit.sel) + ' · #wMsg=' + JSON.stringify(msg27b)
      );
      const ctlOn = (s) => Q(s).classList.contains('on');
      T(
        'pb-edit27-plan-new-controls-off',
        !ctlOn('#doorCtl') && !ctlOn('#fxCtl') && !ctlOn('#runCtl') && !ctlOn('#winCtl'),
        'doorCtl=' +
          ctlOn('#doorCtl') +
          ' fxCtl=' +
          ctlOn('#fxCtl') +
          ' runCtl=' +
          ctlOn('#runCtl') +
          ' winCtl=' +
          ctlOn('#winCtl') +
          '（修前：门控件还亮着、#dWidth=' +
          Q('#dWidth').value +
          'cm）'
      );

      /* 18.2 悬空选中按 Delete：不能说「已删除」（什么都没删），也不能往撤销环塞一步死快照 */
      wallEdit.sel = { kind: 'w', id: wid27 }; // 上一份户型的墙 id，这份文档里没有
      const w27a = DOC.walls.length,
        hid27a = DOC.hidden.walls.length,
        r27a = undoRing.length;
      key27('Delete');
      await tick();
      const msg27c = msg27();
      T(
        'pb-edit27-dangling-delete-not-a-lie',
        DOC.walls.length === w27a &&
          DOC.hidden.walls.length === hid27a &&
          undoRing.length === r27a &&
          msg27c.indexOf('已删除') < 0 &&
          msg27c.indexOf('不在当前户型里') >= 0,
        'walls ' +
          w27a +
          '→' +
          DOC.walls.length +
          ' · hidden.walls ' +
          hid27a +
          '→' +
          DOC.hidden.walls.length +
          ' · 撤销环 ' +
          r27a +
          '→' +
          undoRing.length +
          ' · #wMsg=' +
          JSON.stringify(msg27c)
      );

      /* 18.3 进行中的画墙链：换户型后必须作废 —— 否则下一击就把上一份户型的坐标变成这份的几何 */
      await setTool('wall');
      let bb27 = box27();
      await tap((bb27[0] + bb27[2]) / 2, (bb27[1] + bb27[3]) / 2);
      bb27 = box27();
      await tap((bb27[0] + bb27[2]) / 2 + 3, (bb27[1] + bb27[3]) / 2);
      const chain27 = wallEdit.drawPts.map((p) => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]);
      T('pb-edit27-chain-in-progress', wallEdit.drawPts.length === 2, 'drawPts=' + JSON.stringify(chain27));
      Q('#btnPlanNew').click();
      await tick();
      const blank27b = PLAN_ID;
      T(
        'pb-edit27-plan-new-clears-chain',
        wallEdit.drawPts.length === 0,
        'drawPts=' + JSON.stringify(wallEdit.drawPts) + '（修前带着上一份的 ' + JSON.stringify(chain27) + '）'
      );
      const w27b = DOC.walls.length;
      bb27 = box27();
      await tap((bb27[0] + bb27[2]) / 2, bb27[3] + 1);
      key27('Enter');
      await tick();
      T(
        'pb-edit27-chain-not-leaked',
        DOC.walls.length === w27b,
        '这份户型 walls ' +
          w27b +
          '→' +
          DOC.walls.length +
          '（修前 +1：坐标 ' +
          JSON.stringify(chain27[0]) +
          ' 来自上一份）'
      );

      /* 18.4 对照组：同一份户型里画墙链照常工作（别把修好的东西修坏） */
      await setTool('wall');
      bb27 = box27();
      await tap(bb27[0] + 1, bb27[1] + 1);
      await tap(bb27[2] - 1, bb27[1] + 1);
      key27('Enter');
      await tick();
      T(
        'pb-edit27-chain-still-works',
        DOC.walls.length >= w27b + 1,
        '同一份户型里画两点→回车 walls ' + w27b + '→' + DOC.walls.length
      );

      /* 18.5 对照组：切户型（#planSel）同样作废编辑层 —— 这条 switchPlan 早就做了 */
      wallEdit.sel = { kind: 'w', id: 'wZZZ' };
      wallEdit.drawPts = [
        [1, 1],
        [2, 2],
      ];
      e27Pick(BUILTIN_PLAN_ID);
      await tick();
      T(
        'pb-edit27-plan-switch-clears-layer',
        wallEdit.sel === null && wallEdit.drawPts.length === 0,
        'sel=' + JSON.stringify(wallEdit.sel) + ' drawPts=' + wallEdit.drawPts.length
      );

      /* 18.6 收尾：删掉本轮建的两份空白户型，注册表回到本轮开始前的样子 */
      for (const id of [blank27a, blank27b]) {
        if (!PLANS.hasPlan(PLAN_REG, id)) continue;
        if (PLAN_ID !== id) {
          e27Pick(id);
          await tick();
        }
        Q('#btnPlanDel').click();
        await tick();
        Q('#btnPlanDel').click();
        await tick();
      }
      if (PLAN_ID !== BUILTIN_PLAN_ID) {
        e27Pick(BUILTIN_PLAN_ID);
        await tick();
      }
      await pbReset();
      T(
        'pb-edit27-round27-clean-exit',
        PLAN_ID === BUILTIN_PLAN_ID && PLAN_REG.plans.length === plans27_0 && userCounts().w === 0,
        '户型 ' +
          (PLAN_ID === BUILTIN_PLAN_ID ? '内置' : PLAN_ID) +
          ' · plans ' +
          plans27_0 +
          '→' +
          PLAN_REG.plans.length +
          ' · userWalls=' +
          userCounts().w
      );
    }

    /* ===== 19. S14 电源插座：墙面 / 台面挡水墙 / 中岛正面 / 台柜 —— 放、改、拖、跟着宿主走、删、3D ===== */
    {
      /* 用户 2026-10-22 的需求。断言口径：插座的位置是「相对宿主」的事实（at / side / dh），
         坐标是派生缓存 —— 所以每条断言都从宿主的几何独立量回去（墙皮距离 = 画出来的半厚、
         高度 = 台面高 + 15cm），不照抄实现公式。在一份新建的空白户型里自己画一间房，
         plan-independent。 */
      await enterEdit();
      await pbReset();
      const ol0Plans = PLAN_REG.plans.length;
      Q('#btnPlanNew').click();
      await tick();
      const olPlan = PLAN_ID;
      const oFp = floorPts();
      const oXs = oFp.map((p) => p[0]),
        oYs = oFp.map((p) => p[1]);
      const OX0 = Math.min.apply(null, oXs) + 1,
        OX1 = Math.max.apply(null, oXs) - 1,
        OY0 = Math.min.apply(null, oYs) + 1,
        OY1 = Math.max.apply(null, oYs) - 1;
      const oWd = cmToWd(12);
      const wN = pushUserWall(OX0, OY0, OX1, OY0, 'w', oWd); // 北墙（房间在它的 +y 一侧）
      pushUserWall(OX1, OY0, OX1, OY1, 'w', oWd);
      pushUserWall(OX1, OY1, OX0, OY1, 'w', oWd);
      const wW = pushUserWall(OX0, OY1, OX0, OY0, 'w', oWd); // 西墙
      geoChanged();
      fit2DToContent();
      drawWallEdit();
      await tick();
      const segOf = (id) => effWalls().find((s) => s._id === id);
      const sN = segOf(wN.id);
      const halfN = pbDrawnThick(sN) / 2;
      const olN = () => (DOC.outlets || []).length;
      const ring = () => undoRing.length;
      const msg = () => (Q('#wMsg') || {}).textContent || '';
      const faceDist = (o, s) => distSeg(o.x, o.y, s);

      await setTool('outlet');
      T(
        'pb-ol-tool-visible',
        wallEdit.tool === 'outlet' && vis('#outletCtl') === 'visible' && /点墙边/.test(msg()),
        'tool=' + wallEdit.tool + ' outletCtl=' + vis('#outletCtl') + ' · ' + msg().slice(0, 30)
      );

      /* 19.1 放之前先看见：鼠标停在墙附近有虚线预览，停在房间正中没有 */
      const midX = (OX0 + OX1) / 2;
      const [pvx, pvy] = SPT(midX, OY0 + halfN + 0.25);
      fire('pointermove', pvx, pvy, { buttons: 0 });
      await tick();
      const pvNear = pbSvg.querySelectorAll('.olPreview').length;
      const [pcx, pcy] = SPT(midX, (OY0 + OY1) / 2);
      fire('pointermove', pcx, pcy, { buttons: 0 });
      await tick();
      const pvFar = pbSvg.querySelectorAll('.olPreview').length;
      T('pb-ol-preview', pvNear === 1 && pvFar === 0, '墙边预览 ' + pvNear + ' 个 · 房间正中 ' + pvFar + ' 个');

      /* 19.2 点墙附近 → 贴在点击那一侧的墙皮上，离地 30cm，一步撤销 */
      const r0 = ring(),
        n0 = olN();
      await tap(midX, OY0 + halfN + 0.25);
      const oA = (DOC.outlets || [])[n0];
      const ny = oA ? Math.sin((oA.rot * Math.PI) / 180) : 0;
      T(
        'pb-ol-wall-place',
        olN() === n0 + 1 &&
          !!oA &&
          oA.host === 'wall' &&
          oA.hostId === wN.id &&
          Math.abs(faceDist(oA, sN) - halfN) < 0.002 &&
          oA.y > OY0 &&
          ny > 0.99 &&
          Math.abs(oA.h * 30.48 - 30) < 0.6 &&
          ring() === r0 + 1,
        oA
          ? '离墙轴 ' +
              faceDist(oA, sN).toFixed(3) +
              'ft（画出来的半厚 ' +
              halfN.toFixed(3) +
              '）· 朝向 ' +
              oA.rot +
              '° · 离地 ' +
              Math.round(oA.h * 30.48) +
              'cm · 撤销环 +' +
              (ring() - r0)
          : '没放上'
      );
      T(
        'pb-ol-selected-and-told',
        !!wallEdit.sel && wallEdit.sel.kind === 'outlet' && /插座/.test(msg()) && /离地 30cm/.test(msg()),
        '#wMsg=' + msg().slice(0, 40)
      );
      const g2d = oA && pbSvg.querySelector('[data-outlet="' + oA.id + '"].outletSym');
      T(
        'pb-ol-2d-symbol',
        !!g2d && g2d.querySelectorAll('circle').length === 1 && g2d.getBoundingClientRect().width > 3,
        g2d
          ? '图例 ' +
              g2d.querySelectorAll('circle').length +
              ' 个圆 · ' +
              g2d.getBoundingClientRect().width.toFixed(1) +
              'px 宽'
          : '没画'
      );

      /* 19.3 墙的另一侧 → 另一面墙皮（朝向反过来） */
      wallEdit.sel = null;
      await tap(midX + 1, OY0 - halfN - 0.25);
      const oB = (DOC.outlets || [])[n0 + 1];
      T(
        'pb-ol-wall-other-side',
        !!oB && oB.hostId === wN.id && oB.y < OY0 && Math.abs(((oB.rot - oA.rot + 360) % 360) - 180) < 1,
        oB ? '朝向 ' + oA.rot + '° / ' + oB.rot + '°' : '没放上'
      );
      DOC.outlets = (DOC.outlets || []).filter((o) => o !== oB);
      geoChanged();

      /* 19.4 空地上点 → 拒放并说清为什么（不悬在空中） */
      wallEdit.sel = null;
      const n1 = olN(),
        r1 = ring();
      await tap(midX, (OY0 + OY1) / 2);
      T(
        'pb-ol-free-rejected',
        olN() === n1 && ring() === r1 && /可装在/.test(msg()) && Q('#wMsg').classList.contains('err'),
        '#wMsg=' + msg().slice(0, 36)
      );

      /* 19.5 选中后改类型 / 联数 / 离地高：各占一步；非法高度拒收且不动 */
      wallEdit.sel = { kind: 'outlet', id: oA.id };
      updateWallBarFromSel();
      const r2 = ring();
      Q('#olKind').value = 'gfci';
      Q('#olKind').dispatchEvent(new Event('change'));
      Q('#olN').value = '2';
      Q('#olN').dispatchEvent(new Event('change'));
      Q('#olH').value = '45';
      Q('#olH').dispatchEvent(new Event('change'));
      await tick();
      const g2d2 = pbSvg.querySelector('[data-outlet="' + oA.id + '"].outletSym');
      T(
        'pb-ol-edit-props',
        oA.kind === 'gfci' &&
          oA.n === 2 &&
          Math.abs(oA.h * 30.48 - 45) < 0.6 &&
          ring() === r2 + 3 &&
          !!g2d2 &&
          g2d2.querySelectorAll('circle').length === 2 &&
          /G/.test(g2d2.textContent),
        'kind=' + oA.kind + ' n=' + oA.n + ' h=' + Math.round(oA.h * 30.48) + 'cm · 撤销环 +' + (ring() - r2)
      );
      const r3 = ring();
      Q('#olH').value = '999';
      Q('#olH').dispatchEvent(new Event('change'));
      await tick();
      T(
        'pb-ol-height-rejected',
        Math.abs(oA.h * 30.48 - 45) < 0.6 && ring() === r3 && /离地高要在/.test(msg()),
        'h=' + Math.round(oA.h * 30.48) + 'cm · ' + msg().slice(0, 30)
      );
      Q('#olH').value = '45';
      Q('#olH').dispatchEvent(new Event('change'));
      T('pb-ol-same-height-no-dead-step', ring() === r3, '重打同一个数：撤销环 ' + r3 + ' → ' + ring());

      /* 19.6 拖 = 沿墙滑动：仍贴同一面墙皮，一次拖动一步撤销 */
      const ax0 = oA.x,
        r4 = ring();
      const sc = outletSymbolCenters(oA).cs;
      const [hx, hy] = SPT((sc[0][0] + sc[1][0]) / 2, (sc[0][1] + sc[1][1]) / 2);
      await dragBy(hx, hy, 1.5 * pxPerFtNow(), 0);
      T(
        'pb-ol-drag-along-wall',
        oA.hostId === wN.id &&
          Math.abs(oA.x - ax0 - 1.5) < 0.2 &&
          Math.abs(faceDist(oA, sN) - halfN) < 0.02 &&
          ring() === r4 + 1,
        '沿墙 ' +
          (oA.x - ax0).toFixed(2) +
          'ft（拖 1.5ft）· 离墙轴 ' +
          faceDist(oA, sN).toFixed(3) +
          ' · 撤销环 +' +
          (ring() - r4)
      );

      /* 19.7 台面：靠墙那条 → 挡水墙上（台面高 + 15cm）；改台面高，插座跟着走 */
      const runY = OY1 - halfN; // path = 南墙内皮
      const rn = pushUserRun(
        [
          [OX1 - 6, runY],
          [OX1 - 1, runY],
        ],
        60 / 30.48,
        90 / 30.48
      );
      geoChanged();
      drawWallEdit();
      await tick();
      const rnN = runNormal(5, 0, OX1 - 6, runY);
      wallEdit.sel = null;
      await setTool('outlet');
      await tap(OX1 - 3.5, runY + rnN[1] * 0.9);
      const oR = (DOC.outlets || []).find((o) => o.hostId === rn.id);
      T(
        'pb-ol-run-backsplash',
        !!oR && oR.side === 0 && Math.abs(oR.h - (rn.topH + 15 / 30.48)) < 0.02 && Math.abs(oR.y - runY) < 0.03,
        oR
          ? '离地 ' +
              Math.round(oR.h * 30.48) +
              'cm（台面 90 + 15）· 离 path ' +
              Math.abs(oR.y - runY).toFixed(3) +
              'ft'
          : '没挂上台面'
      );
      wallEdit.sel = { kind: 'run', id: rn.id };
      updateWallBarFromSel();
      Q('#runTopH').value = '100';
      Q('#runTopH').dispatchEvent(new Event('change'));
      await tick();
      T(
        'pb-ol-follows-run-height',
        !!oR && Math.abs(oR.h * 30.48 - 115) < 0.8,
        oR ? '台面 90 → 100cm：插座 ' + Math.round(oR.h * 30.48) + 'cm（应 115）' : '-'
      );

      /* 19.8 中岛（背后没有墙）→ 柜体正面，低于台面 */
      const isY = (OY0 + OY1) / 2;
      const isl = pushUserRun(
        [
          [midX - 2, isY],
          [midX + 2, isY],
        ],
        60 / 30.48,
        90 / 30.48
      );
      geoChanged();
      drawWallEdit();
      await tick();
      const isN = runNormal(4, 0, midX - 2, isY);
      wallEdit.sel = null;
      await tap(midX, isY + isN[1] * 1.5);
      const oI = (DOC.outlets || []).find((o) => o.hostId === isl.id);
      const frontD = oI ? (oI.x - (midX - 2)) * isN[0] + (oI.y - isY) * isN[1] : -1;
      T(
        'pb-ol-island-front',
        !!oI && oI.side === 1 && oI.h < isl.topH && Math.abs(frontD - isl.depth) < 0.03,
        oI
          ? '离 path ' +
              frontD.toFixed(3) +
              'ft（柜深 ' +
              isl.depth.toFixed(3) +
              '）· 离地 ' +
              Math.round(oI.h * 30.48) +
              'cm'
          : '没挂上中岛'
      );

      /* 19.9 台柜：挂在靠墙那条边（就在墙皮上），离地 = 台柜台面 + 15cm；拖台柜，插座跟着走 */
      const sW = segOf(wW.id);
      const cs = fixtureWallSnap(OX0 + 0.3, (OY0 + OY1) / 2 - 1, 'counter');
      const cnt = pushUserFixture('counter', cs.cx, cs.cy, cs.rot);
      geoChanged();
      drawWallEdit();
      await tick();
      wallEdit.sel = null;
      await setTool('outlet');
      await tap((cnt.x1 + cnt.x2) / 2, (cnt.y1 + cnt.y2) / 2);
      const oF = (DOC.outlets || []).find((o) => o.hostId === cnt.id);
      const fWall = oF ? faceDist(oF, sW) - pbDrawnThick(sW) / 2 : 99;
      T(
        'pb-ol-counter',
        !!oF && oF.host === 'fx' && Math.abs(fWall) < 0.03 && Math.abs(oF.h * 30.48 - (2.59 * 30.48 + 15)) < 0.8,
        oF ? '离西墙皮 ' + fWall.toFixed(3) + 'ft · 离地 ' + Math.round(oF.h * 30.48) + 'cm' : '没挂上台柜'
      );
      const fy0 = oF ? oF.y : 0,
        cy0 = (cnt.y1 + cnt.y2) / 2;
      await setTool('select');
      const [ccx, ccy] = SPT((cnt.x1 + cnt.x2) / 2 + 0.3, (cnt.y1 + cnt.y2) / 2 + 0.3);
      await dragBy(ccx, ccy, 0, 1.0 * pxPerFtNow());
      const cdy = (cnt.y1 + cnt.y2) / 2 - cy0;
      T(
        'pb-ol-follows-counter',
        !!oF && cdy > 0.5 && Math.abs(oF.y - fy0 - cdy) < 0.03,
        '台柜挪 ' + cdy.toFixed(2) + 'ft · 插座挪 ' + (oF ? (oF.y - fy0).toFixed(2) : '?') + 'ft'
      );

      /* 19.10 删宿主 → 上面的插座一起删、说出来、一步撤销回来 */
      wallEdit.sel = { kind: 'fx', id: cnt.id };
      updateWallBarFromSel();
      const nF = olN(),
        r5 = ring();
      key('Delete');
      await tick();
      const gone = !DOC.fixtures.some((f) => f.id === cnt.id) && !(DOC.outlets || []).some((o) => o.hostId === cnt.id);
      T(
        'pb-ol-host-delete-cascades',
        gone && olN() === nF - 1 && /连同上面的 1 个点位/.test(msg()) && ring() === r5 + 1,
        '台柜与插座都删了=' + gone + ' · ' + msg()
      );
      undoStep();
      await tick();
      T(
        'pb-ol-host-delete-undo',
        DOC.fixtures.some((f) => f.id === cnt.id) && (DOC.outlets || []).some((o) => o.hostId === cnt.id),
        '撤销一步：台柜与插座都回来'
      );

      /* 19.11 删插座本身 */
      wallEdit.sel = { kind: 'outlet', id: oA.id };
      const nD = olN();
      key('Delete');
      await tick();
      T(
        'pb-ol-delete',
        olN() === nD - 1 && !(DOC.outlets || []).some((o) => o.id === oA.id) && /已删除「/.test(msg()),
        msg()
      );
      undoStep();
      await tick();
      const oAr = (DOC.outlets || []).find((o) => o.id === oA.id);

      /* 19.12 整图重标定 ×2：墙变长变厚，插座仍贴墙皮、沿墙位置按比例走，高度不变 */
      const atA = oAr ? oAr.at : 0,
        hA = oAr ? oAr.h : 0;
      pushUndo('pb-ol-rescale', true);
      rescaleDocPlan(2);
      geoChanged();
      await tick();
      const sN2 = segOf(wN.id);
      const oA3 = (DOC.outlets || []).find((o) => o.id === oA.id);
      T(
        'pb-ol-rescale-follows',
        !!oA3 &&
          Math.abs(oA3.at - atA * 2) < 0.03 &&
          Math.abs(faceDist(oA3, sN2) - pbDrawnThick(sN2) / 2) < 0.03 &&
          Math.abs(oA3.h - hA) < 1e-6,
        oA3
          ? 'at ' +
              atA.toFixed(2) +
              ' → ' +
              oA3.at.toFixed(2) +
              ' · 离墙轴 ' +
              faceDist(oA3, sN2).toFixed(3) +
              '（半厚 ' +
              (pbDrawnThick(sN2) / 2).toFixed(3) +
              '）· 高 ' +
              Math.round(oA3.h * 30.48) +
              'cm'
          : '-'
      );
      undoStep();
      await tick();

      /* 19.13 文档往返：插座通过 schema 校验、导出 JSON 读回来逐字段相同 */
      const vErr = SCHEMA.Project.validate(DOC);
      const rt = JSON.parse(JSON.stringify(DOC.outlets));
      T(
        'pb-ol-doc-roundtrip',
        vErr.length === 0 && JSON.stringify(rt) === JSON.stringify(DOC.outlets) && olN() >= 3,
        'validate 错误 ' + vErr.length + ' · 插座 ' + olN() + ' 个'
      );

      /* 19.14 3D：面板真的在墙上（水平射线先打到面板，比打到墙皮近 0.6cm） */
      const oW = (DOC.outlets || []).find((o) => o.id === oA.id);
      setView('3d');
      await wait3D();
      three.staticGroup.updateMatrixWorld(true);
      const rayAt = (x, y, h) => {
        const rc = new THREE.Raycaster();
        const n = [Math.cos((oW.rot * Math.PI) / 180), Math.sin((oW.rot * Math.PI) / 180)];
        rc.set(new THREE.Vector3(x + n[0] * 1, h, y + n[1] * 1), new THREE.Vector3(-n[0], 0, -n[1]));
        const hs = rc.intersectObjects(three.staticGroup.children, true);
        return hs.length ? hs[0].distance : null;
      };
      const dPlate = oW ? rayAt(oW.x, oW.y, oW.h) : null,
        dWall = oW ? rayAt(oW.x, oW.y, oW.h + 1.2) : null;
      T(
        'pb-ol-in-3d',
        dPlate != null &&
          dWall != null &&
          Math.abs(dWall - 1) < 0.01 &&
          dWall - dPlate > 0.012 &&
          dWall - dPlate < 0.05,
        '射线：面板 ' +
          (dPlate != null ? dPlate.toFixed(3) : '无') +
          'ft · 上方墙皮 ' +
          (dWall != null ? dWall.toFixed(3) : '无') +
          'ft'
      );
      setView('2d');
      await tick();

      /* 收尾：删掉这份户型，回到内置户型 */
      await enterEdit();
      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      T(
        'pb-ol-clean-exit',
        PLAN_ID !== olPlan && PLAN_REG.plans.length === ol0Plans && !(DOC.outlets || []).length,
        '户型 ' +
          (PLAN_ID === BUILTIN_PLAN_ID ? '内置' : PLAN_ID) +
          ' · plans ' +
          ol0Plans +
          '→' +
          PLAN_REG.plans.length
      );
    }

    /* ===== 20. S15 点位家族：网络电视 / 水 / 燃气 / 风 + 地面与天花 + 被家具挡住高亮 ===== */
    {
      /* 用户 2026-10-22：同轴 / 网线口；洗衣机烘干机上下水、通风管道口、油烟机管道口；插座被挡住时高亮。
         与第 19 节同样在一份新建的空白户型里自己画一间房（plan-independent）；遮挡用自定义件
         （尺寸自己定，不依赖目录里某一件商品的尺寸）+ 目录里任意一条地毯。 */
      await enterEdit();
      await pbReset();
      const p20Plans = PLAN_REG.plans.length;
      Q('#btnPlanNew').click();
      await tick();
      const p20Plan = PLAN_ID;
      const fp20 = floorPts();
      const xs20 = fp20.map((p) => p[0]),
        ys20 = fp20.map((p) => p[1]);
      const X0 = Math.min.apply(null, xs20) + 1,
        X1 = Math.max.apply(null, xs20) - 1,
        Y0 = Math.min.apply(null, ys20) + 1,
        Y1 = Math.max.apply(null, ys20) - 1;
      const wd20 = cmToWd(12);
      const wTop = pushUserWall(X0, Y0, X1, Y0, 'w', wd20);
      pushUserWall(X1, Y0, X1, Y1, 'w', wd20);
      pushUserWall(X1, Y1, X0, Y1, 'w', wd20);
      pushUserWall(X0, Y1, X0, Y0, 'w', wd20);
      geoChanged();
      fit2DToContent();
      drawWallEdit();
      await tick();
      const sTop = effWalls().find((s) => s._id === wTop.id);
      const half20 = pbDrawnThick(sTop) / 2;
      const cx20 = (X0 + X1) / 2,
        cy20 = (Y0 + Y1) / 2;
      const ol20 = () => DOC.outlets || [];
      const last20 = () => ol20()[ol20().length - 1];
      const msg20 = () => (Q('#wMsg') || {}).textContent || '';
      const setKind = async (k, mount) => {
        wallEdit.sel = null;
        Q('#olKind').value = k;
        Q('#olKind').dispatchEvent(new Event('change'));
        Q('#olMount').value = mount || 'auto';
        Q('#olMount').dispatchEvent(new Event('change'));
        await tick();
      };
      await setTool('outlet');

      /* 20.1 工具与类型表：按钮叫「点位」，类型下拉 = 类型表（5 组 16 类） */
      const groups = Array.from(Q('#olKind').querySelectorAll('optgroup'));
      T(
        'pb-pt-kinds-from-schema',
        Q('#wtoolSeg button[data-t="outlet"]').textContent.trim() === '插座与水电' &&
          groups.length === 5 &&
          Q('#olKind').options.length === SCHEMA.Project.OUTLET_KINDS.length &&
          SCHEMA.Project.OUTLET_KINDS.length === 16,
        groups.map((g) => g.label + ' ' + g.children.length).join(' · ')
      );

      /* 20.2 同轴 / 网线口：贴墙、离地 30cm、按类别着色（网络 = 青） */
      await setKind('coax');
      await tap(cx20 - 2, Y0 + half20 + 0.25);
      const oCoax = last20();
      await setKind('lan');
      await tap(cx20 - 1, Y0 + half20 + 0.25);
      const oLan = last20();
      const strokeOf = (o) => {
        const g = pbSvg.querySelector('[data-outlet="' + o.id + '"].outletSym');
        const e = g && g.querySelector('polygon,circle');
        return e ? e.getAttribute('stroke') : null;
      };
      T(
        'pb-pt-coax-lan-on-wall',
        !!oCoax &&
          !!oLan &&
          oCoax.kind === 'coax' &&
          oLan.kind === 'lan' &&
          oCoax.host === 'wall' &&
          Math.abs(oCoax.h * 30.48 - 30) < 0.6 &&
          Math.abs(distSeg(oLan.x, oLan.y, sTop) - half20) < 0.002 &&
          strokeOf(oCoax) === PT_CAT_COL.data &&
          strokeOf(oLan) === PT_CAT_COL.data,
        (oCoax ? oCoax.kind + '@' + Math.round(oCoax.h * 30.48) + 'cm ' : '') +
          (oLan ? oLan.kind + ' 离墙轴 ' + distSeg(oLan.x, oLan.y, sTop).toFixed(3) : '') +
          ' · 颜色 ' +
          (oCoax ? strokeOf(oCoax) : '?')
      );

      /* 20.3 上水 / 下水 / 燃气 / 烘干机排风：各自的缺省高度；上水的安装面只有墙（地面 / 天花选项是灰的） */
      const expectH = { supply: 110, drain: 95, gas: 30, dryerVent: 40 };
      const got3 = [];
      let i3 = 0;
      for (const k of Object.keys(expectH)) {
        await setKind(k);
        await tap(cx20 + 1 + i3 * 1.2, Y0 + half20 + 0.25);
        const o = last20();
        got3.push(o && o.kind === k && o.host === 'wall' && Math.abs(o.h * 30.48 - expectH[k]) < 0.6 ? k : '✗' + k);
        i3++;
      }
      await setKind('supply');
      const mOpt = (v) => Q('#olMount').querySelector('option[value="' + v + '"]').disabled;
      T(
        'pb-pt-water-gas-air-heights',
        got3.every((x) => x[0] !== '✗') && mOpt('floor') && mOpt('ceiling') && !mOpt('wall'),
        got3.join(' · ') + ' · 上水的「地面」灰=' + mOpt('floor')
      );

      /* 20.4 地面送风口：点房间中间 → 落在地上、h=0、长边按最近的墙摆正；3D 射线从上往下先打到格栅 */
      await setKind('supplyVent');
      await tap(cx20, Y0 + 2.2);
      const oVent = last20();
      T(
        'pb-pt-floor-vent',
        !!oVent &&
          oVent.host === 'floor' &&
          oVent.h === 0 &&
          Math.abs(oVent.x - cx20) < 0.05 &&
          (oVent.rot === 0 || oVent.rot === 90),
        oVent ? oVent.host + ' @(' + oVent.x.toFixed(2) + ',' + oVent.y.toFixed(2) + ') rot ' + oVent.rot : '没放上'
      );

      /* 20.5 地漏（只能装地上）+ 天花上的油烟机排风口 */
      await setKind('floorDrain');
      await tap(cx20 + 3, cy20);
      const oDrain = last20();
      await setKind('hood', 'ceiling');
      await tap(cx20 - 3, cy20);
      const oHood = last20();
      T(
        'pb-pt-floor-drain-ceiling-hood',
        !!oDrain &&
          oDrain.kind === 'floorDrain' &&
          oDrain.host === 'floor' &&
          !!oHood &&
          oHood.kind === 'hood' &&
          oHood.host === 'ceiling' &&
          Math.abs(oHood.h - CEIL_H) < 1e-6,
        (oDrain ? oDrain.kind + '/' + oDrain.host : '?') +
          ' · ' +
          (oHood ? oHood.kind + '/' + oHood.host + ' h=' + oHood.h.toFixed(2) : '?')
      );

      /* 20.6 装不到的地方如实拒：上水选「地面」、地漏选「墙面」、点在地板外 */
      const n6 = ol20().length,
        r6 = undoRing.length;
      await setKind('supply');
      Q('#olMount').value = 'floor';
      Q('#olMount').dispatchEvent(new Event('change'));
      const floorDisabled = Q('#olMount').querySelector('option[value="floor"]').disabled;
      const snapFloor = pointSnap(cx20, cy20, 'supply', 'floor');
      await setKind('floorDrain');
      const wallDisabled = Q('#olMount').querySelector('option[value="wall"]').disabled;
      const snapWall = pointSnap(cx20, Y0 + half20 + 0.25, 'floorDrain', 'wall');
      const m6 = pointRejectMsg('floorDrain', 'wall', [cx20, Y0 + half20 + 0.25]);
      T(
        'pb-pt-reject-illegal-mount',
        floorDisabled &&
          snapFloor === null &&
          wallDisabled &&
          snapWall === null &&
          ol20().length === n6 &&
          undoRing.length === r6 &&
          /不能装在墙面上/.test(m6),
        '上水「地面」灰=' + floorDisabled + ' · 地漏「墙面」灰=' + wallDisabled + ' · 说明：' + m6.slice(0, 30)
      );

      /* 20.7 被挡住：自定义沙发（高 80cm）推到 30cm 的插座前 → 变红 + 晕 + 提示写出沙发名；挪开 → 恢复 */
      await setKind('std');
      await tap(cx20 + 2, Y1 - half20 - 0.25);
      const oStd = last20();
      const sofaUid = uidSeq++;
      state.items.push({
        uid: sofaUid,
        custom: { name: '测试沙发', w: 200, d: 90, h: 80, color: '#7a6a5a' },
        x: oStd.x,
        y: oStd.y - (45 + 2) / 30.48,
        rot: 0,
      });
      drawFurniture();
      const blkG = () => pbSvg.querySelector('[data-outlet="' + oStd.id + '"].outletSym');
      const halo = () => pbSvg.querySelector('#ptBlk .olBlockHalo[data-outlet="' + oStd.id + '"]');
      const t7 = blkG() ? (blkG().querySelector('title') || {}).textContent || '' : '';
      T(
        'pb-pt-blocked-by-sofa',
        !!blkG() &&
          blkG().classList.contains('olBlocked') &&
          !!halo() &&
          /测试沙发/.test(t7) &&
          (ptBlocked.get(oStd.id) || []).includes('测试沙发'),
        '提示：' + t7
      );
      const sofa = state.items.find((it) => it.uid === sofaUid);
      sofa.y -= 3;
      drawFurniture();
      T(
        'pb-pt-unblocked-after-move',
        !blkG().classList.contains('olBlocked') && !halo() && !ptBlocked.has(oStd.id),
        '挪开 3ft 后 class/晕/记账都清了'
      );

      /* 20.8 对照组：矮凳（20cm）在插座前不挡；上水前站着洗衣机（85cm）不挡（上下水本来就该在家电后面） */
      sofa.x = oStd.x;
      sofa.y = oStd.y - (17.5 + 2) / 30.48;
      sofa.custom = { name: '矮凳', w: 100, d: 35, h: 20, color: '#888' };
      const oSup = ol20().find((o) => o.kind === 'supply');
      const washUid = uidSeq++;
      state.items.push({
        uid: washUid,
        custom: { name: '洗衣机', w: 60, d: 60, h: 85, color: '#eee' },
        x: oSup.x,
        y: oSup.y + (30 + 2) / 30.48,
        rot: 0,
      });
      drawFurniture();
      T(
        'pb-pt-control-low-stool-and-washer',
        !ptBlocked.has(oStd.id) && !ptBlocked.has(oSup.id),
        '矮凳前的插座 blocked=' + ptBlocked.has(oStd.id) + ' · 洗衣机后的上水 blocked=' + ptBlocked.has(oSup.id)
      );
      state.items = state.items.filter((it) => it.uid !== sofaUid && it.uid !== washUid);

      /* 20.9 地毯盖住地面送风口 → 挡住；同一块地毯在墙面插座前 → 不挡 */
      const rugSpec = catalogAll().find((c) => c.kind === 'rug');
      const rugUid = uidSeq++;
      if (rugSpec) state.items.push({ uid: rugUid, ref: rugSpec.id, x: oVent.x, y: oVent.y, rot: 0 });
      drawFurniture();
      const ventBlk = ptBlocked.has(oVent.id);
      const rug = state.items.find((it) => it.uid === rugUid);
      if (rug) {
        rug.x = oStd.x;
        rug.y = oStd.y - cm2ft(rugSpec.d) / 2;
      }
      drawFurniture();
      T(
        'pb-pt-rug-blocks-floor-vent-not-wall',
        !!rugSpec && ventBlk && !ptBlocked.has(oVent.id) && !ptBlocked.has(oStd.id),
        rugSpec
          ? '地毯「' +
              rugSpec.name.slice(0, 14) +
              '」盖送风口 blocked=' +
              ventBlk +
              ' · 挪到插座前 blocked=' +
              ptBlocked.has(oStd.id)
          : '目录里没有地毯'
      );
      state.items = state.items.filter((it) => it.uid !== rugUid);
      drawFurniture();

      /* 20.10 选中地面送风口：换成上水被拒（上水不能装地上）；安装面换成天花 → host=ceiling、h=层高；一步撤销 */
      wallEdit.sel = { kind: 'outlet', id: oVent.id };
      updateWallBarFromSel();
      Q('#olKind').value = 'supply';
      Q('#olKind').dispatchEvent(new Event('change'));
      const rej10 = oVent.kind === 'supplyVent' && /不能装在地面上/.test(msg20());
      const r10 = undoRing.length;
      Q('#olMount').value = 'ceiling';
      Q('#olMount').dispatchEvent(new Event('change'));
      await tick();
      const v10 = ol20().find((o) => o.id === oVent.id);
      T(
        'pb-pt-change-kind-and-mount',
        rej10 && !!v10 && v10.host === 'ceiling' && Math.abs(v10.h - CEIL_H) < 1e-6 && undoRing.length === r10 + 1,
        '换上水被拒=' +
          rej10 +
          ' · 换天花 → ' +
          (v10 ? v10.host + ' h=' + v10.h.toFixed(2) : '?') +
          ' · 撤销环 +' +
          (undoRing.length - r10)
      );

      /* 20.11 文档往返：16 类里放过的每一类都通过 schema 校验 */
      const kinds11 = Array.from(new Set(ol20().map((o) => o.kind)));
      const v11 = SCHEMA.Project.validate(DOC);
      T(
        'pb-pt-doc-valid',
        v11.length === 0 && kinds11.length >= 9,
        '放过 ' + kinds11.length + ' 类：' + kinds11.join(',') + ' · validate 错误 ' + v11.length
      );

      /* 20.12 3D：墙上的网线口、地上的地漏、天花的油烟机口都真的在场景里（射线打到它们，而不是墙 / 地 / 天花） */
      setView('3d');
      await wait3D();
      three.staticGroup.updateMatrixWorld(true);
      const rc = new THREE.Raycaster();
      const firstHit = (o, d) => {
        rc.set(o, d);
        const hs = rc.intersectObjects(three.staticGroup.children, true);
        return hs.length ? hs[0] : null;
      };
      const nL = [Math.cos((oLan.rot * Math.PI) / 180), Math.sin((oLan.rot * Math.PI) / 180)];
      const hLan = firstHit(
        new THREE.Vector3(oLan.x + nL[0], oLan.h, oLan.y + nL[1]),
        new THREE.Vector3(-nL[0], 0, -nL[1])
      );
      const hDrain = firstHit(new THREE.Vector3(oDrain.x, 3, oDrain.y), new THREE.Vector3(0, -1, 0));
      const hHood = firstHit(new THREE.Vector3(oHood.x, 2, oHood.y), new THREE.Vector3(0, 1, 0));
      T(
        'pb-pt-3d-present',
        !!hLan &&
          hLan.distance < 0.99 &&
          !!hDrain &&
          hDrain.point.y > 0.006 &&
          hDrain.point.y < 0.05 &&
          !!hHood &&
          hHood.point.y < CEIL_H - 0.05,
        '网线口 ' +
          (hLan ? hLan.distance.toFixed(3) : '无') +
          'ft · 地漏顶 y=' +
          (hDrain ? hDrain.point.y.toFixed(3) : '无') +
          ' · 油烟机口底 y=' +
          (hHood ? hHood.point.y.toFixed(2) : '无') +
          '（天花 ' +
          CEIL_H +
          '）'
      );
      setView('2d');
      await tick();

      /* 收尾 */
      await enterEdit();
      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      T(
        'pb-pt-clean-exit',
        PLAN_ID !== p20Plan && PLAN_REG.plans.length === p20Plans,
        'plans ' + p20Plans + '→' + PLAN_REG.plans.length
      );
    }

    /* ===== 21. S16 房间与地板：点一下识别房间 → 命名 / 面积 / 地板（2D 底纹 + 3D 贴图）→ 整层地板 → 重标定 → 删除 ===== */
    {
      /* 用户 2026-10-22：「地板的品类，样式，也是要命的需求」。空白户型里画两间相邻的房
         （隔墙中间一段门洞）；面积断言用独立量：净面积 = (轴线宽 − 画出来的墙厚) × (轴线深 − 墙厚)。 */
      await enterEdit();
      await pbReset();
      const p21Plans = PLAN_REG.plans.length;
      Q('#btnPlanNew').click();
      await tick();
      const p21Plan = PLAN_ID;
      const fp21 = floorPts();
      const A0 =
          Math.min.apply(
            null,
            fp21.map((p) => p[0])
          ) + 1,
        B0 =
          Math.min.apply(
            null,
            fp21.map((p) => p[1])
          ) + 1;
      const AW = 12,
        BW = 7,
        RH = 10;
      const wd21 = cmToWd(12);
      const wa = pushUserWall(A0, B0, A0 + AW + BW, B0, 'w', wd21);
      pushUserWall(A0 + AW + BW, B0, A0 + AW + BW, B0 + RH, 'w', wd21);
      pushUserWall(A0 + AW + BW, B0 + RH, A0, B0 + RH, 'w', wd21);
      pushUserWall(A0, B0 + RH, A0, B0, 'w', wd21);
      pushUserWall(A0 + AW, B0, A0 + AW, B0 + 4, 'w', wd21);
      pushUserWall(A0 + AW, B0 + 4, A0 + AW, B0 + 7, 'd', wd21); // 门洞：算房间边界
      pushUserWall(A0 + AW, B0 + 7, A0 + AW, B0 + RH, 'w', wd21);
      geoChanged();
      fit2DToContent();
      drawWallEdit();
      await tick();
      const t21 = pbDrawnThick(effWalls().find((s) => s._id === wa.id));
      const ring21 = () => undoRing.length;
      const msg21 = () => (Q('#wMsg') || {}).textContent || '';
      const rooms21 = () => DOC.rooms || [];
      await setTool('room');

      /* 21.1 悬停预览：房间里有黄虚线，墙上没有 */
      const [hx, hy] = SPT(A0 + 3, B0 + 3);
      fire('pointermove', hx, hy, { buttons: 0 });
      await tick();
      const pv1 = pbSvg.querySelectorAll('.rmPreview').length;
      const [wx, wy] = SPT(A0 + 5, B0);
      fire('pointermove', wx, wy, { buttons: 0 });
      await tick();
      const pv2 = pbSvg.querySelectorAll('.rmPreview').length;
      T(
        'pb-room-tool-preview',
        Q('#wtoolSeg button[data-t="room"]').textContent.trim() === '房间范围' &&
          vis('#roomCtl') === 'visible' &&
          pv1 === 1 &&
          pv2 === 0,
        '房间里预览 ' + pv1 + ' 个 · 墙上 ' + pv2 + ' 个'
      );

      /* 21.2 点房间 A → 新建一个房间：4 个角、面积 = 净宽 × 净深（< 1%）、选中、一步撤销 */
      const r0 = ring21(),
        n0 = rooms21().length;
      await tap(A0 + 3, B0 + 3);
      const rA = rooms21()[rooms21().length - 1];
      const wantA = (AW - t21) * (RH - t21);
      const areaA = rA ? roomArea(rA) : 0;
      T(
        'pb-room-pick-area',
        rooms21().length === n0 + 1 &&
          !!rA &&
          rA.src === 'user' &&
          rA.poly.length === 4 &&
          Math.abs(areaA - wantA) / wantA < 0.01 &&
          !!wallEdit.sel &&
          wallEdit.sel.kind === 'room' &&
          ring21() === r0 + 1 &&
          /面积/.test(Q('#rmArea').textContent),
        '识别 ' +
          areaA.toFixed(2) +
          'ft² · 独立量 ' +
          wantA.toFixed(2) +
          'ft²（墙厚 ' +
          t21.toFixed(3) +
          '）· 撤销环 +' +
          (ring21() - r0)
      );

      /* 21.3 再点同一间：不新建、不占撤销步（#44 死步） */
      const r3 = ring21();
      await tap(A0 + 8, B0 + 6);
      T(
        'pb-room-repick-no-dead-step',
        rooms21().length === n0 + 1 && ring21() === r3 && wallEdit.sel.id === rA.id,
        '房间数 ' + rooms21().length + ' · 撤销环 ' + r3 + '→' + ring21()
      );

      /* 21.4 命名：图上出现名字 + 面积 */
      Q('#rmName').value = '客厅';
      Q('#rmName').dispatchEvent(new Event('change'));
      await tick();
      const lbl = Array.from(pbSvg.querySelectorAll('text.roomlabel')).find((t) => /客厅/.test(t.textContent));
      T(
        'pb-room-named-with-area',
        !!lbl && /m²|sq ft/.test(lbl.textContent) && rA.label === '客厅',
        lbl ? '图上：' + lbl.textContent : '图上没有名字'
      );

      /* 21.5 换地板：人字拼 → 2D 底纹用对应的 pattern；转 45° 换成另一个 pattern；各一步撤销 */
      const r5 = ring21();
      Q('#rmFloor').value = 'oakHerring';
      Q('#rmFloor').dispatchEvent(new Event('change'));
      await tick();
      const poly5 = () => pbSvg.querySelector('.roomFloor[data-room="' + rA.id + '"]');
      const fill0 = poly5() ? poly5().getAttribute('fill') : '';
      Q('#rmAngle').value = '45';
      Q('#rmAngle').dispatchEvent(new Event('change'));
      await tick();
      const fill45 = poly5() ? poly5().getAttribute('fill') : '';
      T(
        'pb-room-floor-2d',
        rA.floor &&
          rA.floor.mat === 'oakHerring' &&
          rA.floor.angle === 45 &&
          fill0 === 'url(#flp-oakHerring-0)' &&
          fill45 === 'url(#flp-oakHerring-45)' &&
          !!pbSvg.querySelector('#flp-oakHerring-45') &&
          ring21() === r5 + 2,
        'fill ' + fill0 + ' → ' + fill45 + ' · 撤销环 +' + (ring21() - r5)
      );

      /* 21.6 隔壁那间（隔着门洞）是另一个房间，不并进来 */
      await tap(A0 + AW + 3, B0 + 5);
      const rB = rooms21()[rooms21().length - 1];
      const wantB = (BW - t21) * (RH - t21);
      T(
        'pb-room-door-opening-separates',
        !!rB && rB.id !== rA.id && Math.abs(roomArea(rB) - wantB) / wantB < 0.01,
        rB ? 'B ' + roomArea(rB).toFixed(2) + 'ft²（独立量 ' + wantB.toFixed(2) + '）' : '没识别出 B'
      );
      Q('#rmFloor').value = 'tileWhite60';
      Q('#rmFloor').dispatchEvent(new Event('change'));
      await tick();

      /* 21.7 墙上有缺口 → 如实说，不新建 */
      // 拆掉顶边那整面外墙 → 房间 B 不再被围住（拆内墙不算：两间连成一块，外墙还围着）
      const waSaved = DOC.walls.find((w) => w.id === wa.id);
      DOC.walls = DOC.walls.filter((w) => w.id !== wa.id);
      geoChanged();
      drawWallEdit();
      await tick();
      const n7 = rooms21().length,
        r7 = ring21();
      wallEdit.sel = null;
      await tap(A0 + AW + 3, B0 + 8.5);
      T(
        'pb-room-leak-told',
        rooms21().length === n7 && ring21() === r7 && /没有被墙围起来/.test(msg21()),
        msg21().slice(0, 30)
      );
      DOC.walls.push(waSaved);
      geoChanged();
      await tick();

      /* 21.8 整层地板：没单独设地板的地方用它（2D 整层底纹 + 3D 地板贴图） */
      wallEdit.sel = null;
      updateWallBarFromSel();
      const r8 = ring21();
      Q('#lvFloor').value = 'concrete';
      Q('#lvFloor').dispatchEvent(new Event('change'));
      await tick();
      T(
        'pb-level-floor',
        DOC.floorMat === 'concrete' && !!pbSvg.querySelector('polygon.levelFloor') && ring21() === r8 + 1,
        'floorMat=' + DOC.floorMat
      );

      /* 21.9 3D：房间 A 中心向下的射线先打到「它自己的地板」，贴图是人字拼那张；房间外的整层地板是水泥那张 */
      setView('3d');
      await wait3D();
      three.staticGroup.updateMatrixWorld(true);
      const rc21 = new THREE.Raycaster();
      const down = (x, y) => {
        rc21.set(new THREE.Vector3(x, 1.0, y), new THREE.Vector3(0, -1, 0));
        const hs = rc21.intersectObjects(three.staticGroup.children, true);
        return hs.length ? hs[0] : null;
      };
      const hA = down(A0 + 3, B0 + 3),
        hOut = down(A0 + AW, B0 + 5.5); // 两间房之间的门洞：两间的轮廓都在这里止住，露出来的是整层地板
      T(
        'pb-room-floor-3d',
        !!hA &&
          hA.object.userData.roomFloor === rA.id &&
          hA.object.material.map === floorTexture('oakHerring').map &&
          !!hOut &&
          hOut.object.material.map === floorTexture('concrete').map,
        '房间 A 射线打到 ' +
          (hA ? (hA.object.userData.roomFloor || '?') + ' y=' + hA.point.y.toFixed(3) : '无') +
          ' · 外圈 ' +
          (hOut ? (hOut.object.material.map === floorTexture('concrete').map ? '水泥' : '别的') : '无')
      );
      setView('2d');
      await tick();
      await enterEdit();

      /* 21.10 采购清单底部的地板用量（按预设汇总面积） */
      const fu = Array.from(document.querySelectorAll('#plRows .floorRow')).map((r) => r.textContent);
      T(
        'pb-room-floor-usage',
        fu.some((t) => /人字拼/.test(t) && /客厅/.test(t) && /m²|sq ft/.test(t)) && fu.length === 2,
        fu.join(' | ').slice(0, 90)
      );

      /* 21.11 整图重标定 ×2：房间轮廓跟着墙走（面积 ×4） */
      const a11 = roomArea(rA);
      pushUndo('pb-rm-rescale', true);
      rescaleDocPlan(2);
      geoChanged();
      await tick();
      const a11b = roomArea(rooms21().find((r) => r.id === rA.id));
      T('pb-room-rescale', Math.abs(a11b / a11 - 4) < 0.01, '面积 ' + a11.toFixed(1) + ' → ' + a11b.toFixed(1) + 'ft²');
      undoStep();
      await tick();

      /* 21.12 删除（用户新建的房间整条删掉）+ 一步撤销回来；文档往返通过校验 */
      wallEdit.sel = { kind: 'room', id: rA.id };
      updateWallBarFromSel();
      const n12 = rooms21().length;
      key('Delete');
      await tick();
      const n12b = rooms21().length,
        m12 = msg21().slice(0, 24);
      const del12 = n12b === n12 - 1 && /已删除房间/.test(msg21());
      undoStep();
      await tick();
      const back12 = rooms21().some((r) => r.id === rA.id && r.floor && r.floor.mat === 'oakHerring');
      const v12 = SCHEMA.Project.validate(DOC);
      T(
        'pb-room-delete-undo-valid',
        del12 && back12 && v12.length === 0,
        '删=' + del12 + '（' + n12 + '→' + n12b + ' · ' + m12 + '）回=' + back12 + ' · validate 错误 ' + v12.length
      );

      /* 收尾：删掉这份户型 */
      await enterEdit();
      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();

      /* 21.13 内置户型：点一个有名字的房间 → 不新建房间，而是给那个房间挂上轮廓；名字固定（输入框禁用）；
         Delete 只清轮廓与地板、名字留着 */
      await enterEdit();
      await setTool('room');
      const L13 = LABELS.filter((l) => !l.small).find((l) => {
        const res = roomRegionAt(l.p[0], l.p[1]);
        return res.region && !LABELS.some((m) => m !== l && !m.small && GEO_PTS.pointInPoly(m.p, res.region.poly));
      });
      let ok13 = false,
        info13 = '内置户型里没有被墙单独围住的房间';
      if (L13) {
        const n13 = rooms21().length;
        await tap(L13.p[0], L13.p[1]);
        const r13 = selRoom();
        const nameLocked = Q('#rmName').disabled;
        key('Delete');
        await tick();
        const r13b = r13 ? rooms21().find((r) => r.id === r13.id) : null;
        ok13 = !!r13 && rooms21().length === n13 && nameLocked && !!r13b && !r13b.poly && !!r13b.label;
        info13 =
          '「' +
          L13.t +
          '」→ ' +
          (r13 ? r13.id : '?') +
          ' · 名字锁定=' +
          nameLocked +
          ' · Delete 后名字还在=' +
          !!(r13b && r13b.label);
      }
      T('pb-room-builtin-label', ok13, info13);
      await setTool('select');
      T(
        'pb-room-clean-exit',
        PLAN_ID !== p21Plan && PLAN_REG.plans.length === p21Plans && !rooms21().some((r) => r.poly || r.floor),
        'plans ' + p21Plans + '→' + PLAN_REG.plans.length
      );
    }

    /* ===== 22. G16：自己画的 L 形房子，地板轮廓 = 真实外轮廓（不是墙体包围盒那块矩形） ===== */
    {
      await enterEdit();
      await pbReset();
      const p22Plans = PLAN_REG.plans.length;
      Q('#btnPlanNew').click();
      await tick();
      const fp0 = floorPts();
      const X =
          Math.min.apply(
            null,
            fp0.map((p) => p[0])
          ) + 1,
        Y =
          Math.min.apply(
            null,
            fp0.map((p) => p[1])
          ) + 1;
      // 轴线：(0,0)-(14,0)-(14,6)-(7,6)-(7,12)-(0,12)，右下角缺一块 7×6
      const L = [
        [0, 0],
        [14, 0],
        [14, 6],
        [7, 6],
        [7, 12],
        [0, 12],
      ].map(([a, b]) => [X + a, Y + b]);
      const wd22 = cmToWd(12);
      L.forEach((p, i) => pushUserWall(p[0], p[1], L[(i + 1) % L.length][0], L[(i + 1) % L.length][1], 'w', wd22));
      geoChanged();
      await tick();
      const fp = floorPts();
      const notch = [X + 10.5, Y + 9],
        inside = [X + 3, Y + 9];
      T(
        'pb-footprint-l-shape',
        fp.length === 6 && !insideFloorPt(notch[0], notch[1]) && insideFloorPt(inside[0], inside[1]),
        '地板轮廓 ' +
          fp.length +
          ' 个角 · 缺口处 inside=' +
          insideFloorPt(notch[0], notch[1]) +
          ' · L 内 inside=' +
          insideFloorPt(inside[0], inside[1])
      );
      setView('3d');
      await wait3D();
      three.staticGroup.updateMatrixWorld(true);
      const rc22 = new THREE.Raycaster();
      const hitFloor = (x, y) => {
        rc22.set(new THREE.Vector3(x, 0.5, y), new THREE.Vector3(0, -1, 0));
        const hs = rc22
          .intersectObjects(three.staticGroup.children, true)
          .filter((h) => h.point.y > -0.02 && h.point.y < 0.05);
        return hs.length > 0;
      };
      T(
        'pb-footprint-3d-floor',
        hitFloor(inside[0], inside[1]) && !hitFloor(notch[0], notch[1]),
        'L 内有地板=' + hitFloor(inside[0], inside[1]) + ' · 缺口处有地板=' + hitFloor(notch[0], notch[1])
      );
      setView('2d');
      await tick();
      // 对照组：墙没围合（拆掉一面）→ 退回包围盒（4 个角），不会因为算不出外轮廓而没有地板
      DOC.walls = DOC.walls.slice(0, -1);
      geoChanged();
      await tick();
      T(
        'pb-footprint-open-falls-back',
        floorPts().length === 4,
        '墙没围合 → 地板轮廓 ' + floorPts().length + ' 个角（包围盒）'
      );
      await enterEdit();
      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      T(
        'pb-footprint-clean-exit',
        PLAN_REG.plans.length === p22Plans,
        'plans ' + p22Plans + '→' + PLAN_REG.plans.length
      );
    }

    /* ===== 23. S17 楼层与楼梯：加一层（带外墙）→ 家具归层 → 楼梯（2D 符号 / 3D 踏步 / 上层楼板开洞）→
       撤销跨层 → 改层高重排标高 → 往下加 / 删层 → 整图缩放带上所有楼层 → 导出往返 ===== */
    {
      /* 用户 2026-10-22：「对于 house 来说，多层以及楼梯，这个需求也非常要命」。
         独立量：层高 / 楼板厚取 ADR-0007 写下的口径（新建空白户型层高 8.8ft、楼板 1ft），
         踏步数 = 层间高差 / 17.5cm 四舍五入（ADR 的目标踢面），踏面 = 梯段长 / 踏步数（拐角平台 = 梯宽见方）。 */
      await enterEdit();
      await pbReset();
      const p23Plans = PLAN_REG.plans.length;
      const builtin23 = !docImported();
      // F3：楼层 = 面包屑第二段，内置户型也显示（只读）；「能不能加楼层」看下拉里的「＋ 往上加一层」
      const canAdd = () => Q('#lvAddUp').style.display !== 'none';
      const barB = getComputedStyle(Q('#levelBar')).display + (canAdd() ? '/可加层' : '/只读');
      const noteB = Q('#lvNote').textContent;
      Q('#btnPlanNew').click();
      await tick();
      const p23Plan = PLAN_ID;
      const barN = getComputedStyle(Q('#levelBar')).display + (canAdd() ? '/可加层' : '/只读');
      const lvBtns = () => Array.from(document.querySelectorAll('#lvBtns button'));
      T(
        'pb-lv-bar-self-contained',
        builtin23 &&
          barB === 'flex/只读' &&
          /只有一层/.test(noteB) &&
          barN === 'flex/可加层' &&
          lvBtns().length === 1 &&
          lvBtns()[0].textContent === '一层',
        '内置户型楼层条 ' +
          barB +
          ' · 空白户型 ' +
          barN +
          ' · 按钮 ' +
          lvBtns()
            .map((b) => b.textContent)
            .join('/')
      );

      const fp0 = floorPts();
      const X =
          Math.min.apply(
            null,
            fp0.map((p) => p[0])
          ) + 1,
        Y =
          Math.min.apply(
            null,
            fp0.map((p) => p[1])
          ) + 1;
      const HW = 24,
        HD = 16;
      const wd15 = cmToWd(15);
      // 顶边：墙 · 门洞（入户；比墙薄 —— 加层时补成实墙要取相邻外墙的厚度）· 墙；底边上叠一扇窗
      pushUserWall(X, Y, X + 3, Y, 'w', wd15);
      const op23 = pushUserWall(X + 3, Y, X + 6, Y, 'd', cmToWd(10));
      pushUserWall(X + 6, Y, X + HW, Y, 'w', wd15);
      pushUserWall(X + HW, Y, X + HW, Y + HD, 'w', wd15);
      pushUserWall(X + HW, Y + HD, X, Y + HD, 'w', wd15);
      pushUserWall(X, Y + HD, X, Y, 'w', wd15);
      const win23 = pushUserWindow(X + 15, Y + HD, X + 19, Y + HD, wd15);
      const inner23 = pushUserWall(X + 12, Y, X + 12, Y + HD, 'w', cmToWd(10)); // 内墙：不该被带到上一层
      // 窗的 wallId 指向一面不会被带上去的墙（DXF 导入的窗常挂在一面合并过的长墙上）：复制件必须断开引用，否则文档过不了校验
      win23.wallId = inner23.id;
      geoChanged();
      fit2DToContent();
      await tick();
      const ceil1 = DOC.ceilingH;

      /* 23.0b 带内置专属构件的户型（内置户型导出再导入）：不画楼层条、加楼层被拒并说明 —— 厨房 / 中岛 / 内部示意墙不分楼层 */
      DOC.plan = { inner: [] };
      levelBarUI();
      const barHard = Q('#lvAddUp').style.display;
      const refuse = addLevelUI('above');
      delete DOC.plan;
      levelBarUI();
      T(
        'pb-lv-refused-with-builtin-parts',
        barHard === 'none' && refuse === null && !hasLevelsNow() && Q('#lvAddUp').style.display !== 'none',
        '楼层条 ' +
          barHard +
          ' · addLevelUI → ' +
          refuse +
          ' · 去掉之后楼层条 ' +
          getComputedStyle(Q('#levelBar')).display
      );
      const segKey = (w) => {
        const g = w.geom,
          a = [g.x1, g.y1].map((v) => v.toFixed(2)).join(','),
          b = [g.x2, g.y2].map((v) => v.toFixed(2)).join(',');
        return a < b ? a + '|' + b : b + '|' + a;
      };
      const perim = new Set(DOC.walls.slice(0, 6).map(segKey)); // 外墙 5 段 + 门洞（上一层它是墙）

      /* 23.1 ＋ 加一层：切到新层；它带上本层的外壳 —— 5 段外墙 + 门洞补成的实墙（厚度 = 相邻外墙）+ 那扇窗，内墙与门不带；
         标高 = 层高 + 楼板 1ft；一步撤销 */
      const r1 = undoRing.length;
      Q('#lvAddUp').click();
      await tick();
      const lv2 = DOC.level;
      const L2 = DOC.levels.find((l) => l.id === lv2);
      const c1 = LV.levelContentOf(DOC, 'lv1');
      T(
        'pb-lv-add-up-shell',
        DOC.levels.length === 2 &&
          lv2 !== 'lv1' &&
          L2.name === '二层' &&
          Math.abs(L2.elev - (ceil1 + 1.0)) < 1e-6 &&
          DOC.walls.length === 6 &&
          DOC.walls.every((w) => perim.has(segKey(w)) && w.src === 'user' && w.kind === 'wall') &&
          Math.abs(DOC.walls.find((w) => segKey(w) === segKey(op23)).thick - wd15 / S) < 1e-9 &&
          DOC.windows.length === 1 &&
          segKey(DOC.windows[0]) === segKey(win23) &&
          DOC.windows[0].wallId === null &&
          DOC.doors.length === 0 &&
          c1.walls.length === 7 &&
          undoRing.length === r1 + 1 &&
          SCHEMA.Project.validate(DOC).length === 0,
        '楼层 ' +
          DOC.levels.map((l) => l.name + '@' + l.elev.toFixed(2)).join(',') +
          ' · 新层墙 ' +
          DOC.walls.length +
          '（门洞补墙厚 ' +
          (DOC.walls.find((w) => segKey(w) === segKey(op23)) || {}).thick +
          '）· 窗 ' +
          DOC.windows.length +
          ' · 一层墙 ' +
          c1.walls.length +
          ' · 撤销环 +' +
          (undoRing.length - r1)
      );

      /* 23.2 楼层条：高的在上（二层 on / 一层）；2D 上画着下一层的 7 段墙作参照（虚线、不吃指针） */
      const refLines = pbSvg.querySelectorAll('.lowerRef line').length;
      T(
        'pb-lv-bar-and-lower-ref',
        lvBtns()
          .map((b) => b.textContent + (b.classList.contains('on') ? '*' : ''))
          .join('/') === '二层*/一层' &&
          refLines === 7 &&
          getComputedStyle(pbSvg.querySelector('.lowerRef')).pointerEvents === 'none',
        '按钮 ' +
          lvBtns()
            .map((b) => b.textContent + (b.classList.contains('on') ? '*' : ''))
            .join('/') +
          ' · 参照墙线 ' +
          refLines
      );

      /* 23.3 家具归层：在二层放一件 → it.lv = 二层；切回一层看不见它、墙是一层的 7 段、层高回到一层的 */
      // 落地的普通家具（地毯 / 灯具不参与碰撞，压在楼梯口上也不红 —— 23.6b 要用它）
      addItem(CATALOG.find((c) => c.kind !== 'rug' && !isLight(c) && c.w >= 60 && c.d >= 40).id);
      await tick();
      const it23 = state.items[state.items.length - 1];
      const onSvg = (uid) => !!pbSvg.querySelector('[data-uid="' + uid + '"]');
      const seen2 = onSvg(it23.uid);
      Q('#lvBtns button[data-lv="lv1"]').click();
      await tick();
      T(
        'pb-lv-item-belongs',
        it23.lv === lv2 &&
          seen2 &&
          !onSvg(it23.uid) &&
          DOC.level === 'lv1' &&
          DOC.walls.length === 7 &&
          CEIL_H === ceil1,
        'it.lv=' +
          it23.lv +
          ' · 二层看得见=' +
          seen2 +
          ' · 切到一层后看得见=' +
          onSvg(it23.uid) +
          ' · 一层墙 ' +
          DOC.walls.length
      );

      /* 23.3b 撤销的合并键是实体 id，而复制上去的外墙与下层同 id：一层微调 w01 → 切到二层再微调它的 w01，
         必须是两步撤销（以前并成一步：撤一次同时退掉两层的改动并跳回一层） */
      await enterEdit();
      await setTool('select');
      const w01 = DOC.walls[0].id;
      const step = 1 / 30.48; // 方向键一下 = 1cm
      const gy = () => DOC.walls.find((w) => w.id === w01).geom.y1;
      const y1a = gy(),
        r3b = undoRing.length;
      wallEdit.sel = { kind: 'w', id: w01 };
      updateWallBarFromSel();
      key('ArrowDown');
      await tick();
      Q('#lvBtns button[data-lv="' + lv2 + '"]').click();
      await tick();
      const y2a = gy();
      wallEdit.sel = { kind: 'w', id: w01 };
      updateWallBarFromSel();
      key('ArrowDown');
      await tick();
      const steps3b = undoRing.length - r3b;
      undoStep();
      await tick();
      const lv1y = LV.levelContentOf(DOC, 'lv1').walls.find((w) => w.id === w01).geom.y1;
      const back1 = DOC.level === lv2 && Math.abs(gy() - y2a) < 1e-9 && Math.abs(lv1y - (y1a + step)) < 1e-6;
      undoStep();
      await tick();
      const back2 = DOC.level === 'lv1' && Math.abs(gy() - y1a) < 1e-9;
      T(
        'pb-lv-nudge-not-merged-across-levels',
        steps3b === 2 && back1 && back2,
        '两层各微调一次 → 撤销环 +' +
          steps3b +
          ' · 撤一次只退二层（一层那下还在）=' +
          back1 +
          ' · 再撤一次退一层=' +
          back2
      );
      wallEdit.sel = null;
      updateWallBarFromSel();

      /* 23.4 楼梯工具：在一层点 3 个点（L 形）+ 回车 → 一部楼梯；踏步数 / 踏面按独立量；2D 有踏步线 + 「上」 */
      await setTool('stair');
      const sp = [
        [X + 2, Y + 2],
        [X + 2, Y + 12],
        [X + 9, Y + 12],
      ];
      const r4 = undoRing.length;
      for (const p of sp) await tap(p[0], p[1]);
      key('Enter');
      await tick();
      const st = (DOC.stairs || [])[0];
      const lay = st ? stairLayoutOf(st) : null;
      const w4 = st ? st.w : 0;
      const rise4 = L2.elev - 0;
      const wantN = Math.round(rise4 / (17.5 / 30.48));
      const run4 = 10 - w4 / 2 + (7 - w4 / 2);
      const symN = pbSvg.querySelectorAll('.stairSym').length;
      T(
        'pb-lv-stair-draw',
        (DOC.stairs || []).length === 1 &&
          !!lay &&
          lay.stepsN === wantN &&
          lay.landings.length === 1 &&
          Math.abs(lay.tread - run4 / wantN) < 1e-6 &&
          Math.abs(lay.steps[lay.steps.length - 1].top - rise4) < 1e-6 &&
          wallEdit.sel &&
          wallEdit.sel.kind === 'stair' &&
          symN === 1 &&
          undoRing.length === r4 + 1 &&
          new RegExp(wantN + ' 级').test(Q('#wMsg').textContent),
        (lay ? lay.stepsN : '?') +
          ' 级（独立量 ' +
          wantN +
          '）· 踏面 ' +
          (lay ? (lay.tread * 30.48).toFixed(1) : '?') +
          'cm · 平台 ' +
          (lay ? lay.landings.length : '?') +
          ' · ' +
          Q('#wMsg').textContent.slice(0, 40)
      );

      /* 23.4b 双跑楼梯：梯宽 91cm、第一段斜着（不触发横平竖直吸附）—— 第 3 点吸到一个梯宽、点满 4 个点自动结束 →
         一部双跑楼梯（端点与梯宽各自取整到 0.01ft 也不许被判「放不下」：审查实测 91cm 时一半被拒）；
         整图 ×0.99 之后它还在、还是双跑（中段定回一个梯宽），撤销两步回到原样 */
      // 外轮廓 = 梯段 + 平台的并集（面积相等 = 没有碎缝 / 尖刺 / 自交）
      const ringArea = (P) =>
        Math.abs(P.reduce((t, p, i) => t + p[0] * P[(i + 1) % P.length][1] - P[(i + 1) % P.length][0] * p[1], 0) / 2);
      const outlineIsUnion = (L) =>
        !!L && Math.abs(ringArea(L.outline) - L.footprint.reduce((t, q) => t + ringArea(q), 0)) < 0.05;
      Q('#stW').value = '91';
      const w4b = FT2(91 / 30.48);
      const Q0 = [X + 14, Y + 2],
        Q1 = [X + 15.5, Y + 11]; // 偏 9.5°
      const dir4b = [
        (Q1[0] - Q0[0]) / Math.hypot(Q1[0] - Q0[0], Q1[1] - Q0[1]),
        (Q1[1] - Q0[1]) / Math.hypot(Q1[0] - Q0[0], Q1[1] - Q0[1]),
      ];
      const nrm4b = [-dir4b[1], dir4b[0]];
      const Q2 = [Q1[0] + nrm4b[0] * (w4b + 0.12), Q1[1] + nrm4b[1] * (w4b + 0.12)]; // 点得不准：吸附把它拉到正好一个梯宽
      const Q3 = [Q2[0] - dir4b[0] * 8, Q2[1] - dir4b[1] * 8];
      const n4b = DOC.stairs.length,
        r4b = undoRing.length;
      for (const p of [Q0, Q1, Q2, Q3]) await tap(p[0], p[1]);
      await tick();
      const st4b = DOC.stairs[DOC.stairs.length - 1];
      const ok4b =
        DOC.stairs.length === n4b + 1 &&
        Math.abs(st4b.w - w4b) < 1e-9 &&
        GEO_PTS.isDogLeg(st4b.path, st4b.w) &&
        !!stairLayoutOf(st4b) &&
        stairLayoutOf(st4b).landings.length === 2 &&
        outlineIsUnion(stairLayoutOf(st4b));
      pushUndo('pb-lv-dog-rescale', true);
      rescaleDocPlan(0.99);
      geoChanged();
      await tick();
      const st4c = DOC.stairs.find((x) => x.id === st4b.id);
      const ok4c =
        !!st4c &&
        !!stairLayoutOf(st4c) &&
        GEO_PTS.isDogLeg(st4c.path, st4c.w) &&
        pbSvg.querySelectorAll('.stairBad').length === 0;
      undoStep();
      await tick();
      undoStep();
      await tick();
      Q('#stW').value = '90';
      T(
        'pb-lv-dogleg-91cm-and-rescale',
        ok4b && ok4c && DOC.stairs.length === n4b && undoRing.length === r4b,
        '画出来=' +
          ok4b +
          '（梯宽 ' +
          (st4b ? st4b.w : '?') +
          '）· ×0.99 后仍是双跑=' +
          ok4c +
          ' · 撤销回到 ' +
          DOC.stairs.length +
          ' 部'
      );

      /* 23.4c 放不下的楼梯（手改 / 旧导出的文档里才会有）：图上照样画出来（红色虚线 +「?」）、点得中、提示说清、Delete 删得掉 */
      DOC.stairs.push({
        id: 'st99',
        path: [
          [X + 20, Y + 3],
          [X + 20, Y + 3.2],
        ],
        w: 3,
        src: 'user',
      });
      geoChanged();
      await tick();
      const bad = pbSvg.querySelector('.stairBad[data-stair="st99"]');
      const hitBad = pbSvg.querySelector('.stHit[data-stair="st99"]');
      wallEdit.sel = { kind: 'stair', id: 'st99' };
      updateWallBarFromSel();
      const msgBad = Q('#wMsg').textContent;
      key('Delete');
      await tick();
      T(
        'pb-lv-invalid-stair-visible-and-deletable',
        !!bad && !!hitBad && /放不下/.test(msgBad) && !DOC.stairs.some((x) => x.id === 'st99'),
        '画出来=' +
          !!bad +
          ' · 命中区=' +
          !!hitBad +
          ' · 提示「' +
          msgBad.slice(0, 24) +
          '」· 删掉=' +
          !DOC.stairs.some((x) => x.id === 'st99')
      );
      undoRing.length = r4b; // 这一步只是测试注入，不留在撤销环里
      updateUndoUI();

      /* 23.5 太陡要说：直跑 4ft 爬 9.8ft → 踏面不到 22cm → 提示「太陡」（红字），楼梯照样放下（用户自己决定） */
      const nS = DOC.stairs.length;
      for (const p of [
        [X + 16, Y + 3],
        [X + 16, Y + 7],
      ])
        await tap(p[0], p[1]);
      key('Enter');
      await tick();
      const steepMsg = Q('#wMsg').textContent;
      T(
        'pb-lv-stair-steep-warned',
        DOC.stairs.length === nS + 1 && /太陡/.test(steepMsg) && Q('#wMsg').classList.contains('err'),
        steepMsg.slice(0, 60)
      );
      undoStep();
      await tick();
      await setTool('select');

      /* 23.6 上一层看楼梯口：二层画虚线轮廓 +「下」，没有踏步线 */
      Q('#lvBtns button[data-lv="' + lv2 + '"]').click();
      await tick();
      const gh = pbSvg.querySelector('.stairGhost');
      T(
        'pb-lv-stair-ghost-above',
        !!gh && !pbSvg.querySelector('.stairSym') && gh.querySelector('.stairLbl').textContent === '下',
        '虚线轮廓 ' + !!gh + ' · 本层楼梯符号 ' + pbSvg.querySelectorAll('.stairSym').length
      );

      /* 23.6a 二层用楼梯工具在楼梯口里点：是在画一部新楼梯的起步点，不是去选（拖 / 删）下一层那部同 id 的楼梯 */
      await setTool('stair');
      await tap(X + 2, Y + 7);
      const startedHere = wallEdit.drawPts.length === 1 && !wallEdit.sel;
      key('Escape');
      await tick();
      await setTool('select');
      T(
        'pb-lv-stair-tool-ignores-ghost',
        startedHere && (LV.levelContentOf(DOC, 'lv1').stairs || []).length === 1 && (DOC.stairs || []).length === 0,
        '楼梯口里点一下 → 起步点=' +
          startedHere +
          ' · 一层楼梯还在=' +
          ((LV.levelContentOf(DOC, 'lv1').stairs || []).length === 1)
      );

      /* 23.6b 家具压在楼梯口上 = 红框（与家具互相重叠同一套反馈）；挪到房间另一头就不红；
         挪进 L 形两段梯段之间那块空地（凹口里）也不红 —— 洞是 L 形，不是凸包 */
      const furnG = () => pbSvg.querySelector('g.furn[data-uid="' + it23.uid + '"]');
      // 撤销 / 重做会换掉 state.items 里的对象（快照 JSON 重建）：按 uid 取活的那一件
      const live23 = () => state.items.find((i) => i.uid === it23.uid);
      const at0 = [live23().x, live23().y, live23().rot];
      const putAt = (x, y) => {
        Object.assign(live23(), { x, y, rot: 0 });
        drawFurniture();
      };
      putAt(X + 2, Y + 7);
      const onHole = furnG().classList.contains('onStair');
      putAt(X + 18, Y + 8);
      const away = furnG().classList.contains('onStair');
      putAt(X + 7, Y + 6); // 两段梯段之间（凸包会把这里也算成洞）
      const inNotch = furnG().classList.contains('onStair');
      Object.assign(live23(), { x: at0[0], y: at0[1], rot: at0[2] });
      drawFurniture();
      T(
        'pb-lv-furniture-on-stair-opening',
        onHole && !away && !inNotch,
        '压在楼梯口=' + onHole + ' · 房间另一头=' + away + ' · L 的凹口里=' + inNotch
      );

      /* 23.7 3D：两层各在自己的标高；从上往下打射线 —— 楼梯处穿过二层楼板的洞打到一层的踏步，别处打到二层地面 */
      setView('3d');
      await wait3D(80);
      const G = three.levelGroups;
      three.staticGroup.updateMatrixWorld(true);
      const rc23 = new THREE.Raycaster();
      const down23 = (x, y) => {
        rc23.set(new THREE.Vector3(x, 40, y), new THREE.Vector3(0, -1, 0));
        const hs = rc23.intersectObjects(three.staticGroup.children, true);
        return hs.length ? hs[0] : null;
      };
      const hSt = down23(X + 2, Y + 7),
        hFl = down23(X + 18, Y + 8);
      const furn23 = three.furnMap && three.furnMap.get(it23.uid);
      T(
        'pb-lv-3d-stack-and-hole',
        !!G &&
          G.size === 2 &&
          Math.abs(G.get('lv1').position.y) < 1e-9 &&
          Math.abs(G.get(lv2).position.y - L2.elev) < 1e-9 &&
          G.get('lv1').visible &&
          G.get(lv2).visible &&
          !!hSt &&
          !!hSt.object.material.userData.stair &&
          hSt.point.y > 0.3 &&
          hSt.point.y < L2.elev - 0.3 &&
          !!hFl &&
          Math.abs(hFl.point.y - L2.elev) < 0.05 &&
          !!furn23 &&
          Math.abs(furn23.g.position.y - L2.elev) < 0.05,
        '组 ' +
          (G ? [...G.keys()].map((k) => k + '@' + G.get(k).position.y.toFixed(2)).join(',') : '无') +
          ' · 楼梯处射线 y=' +
          (hSt ? hSt.point.y.toFixed(2) + (hSt.object.material.userData.stair ? '(踏步)' : '(别的)') : '无') +
          ' · 别处 y=' +
          (hFl ? hFl.point.y.toFixed(2) : '无') +
          ' · 家具 y=' +
          (furn23 ? furn23.g.position.y.toFixed(2) : '无')
      );

      /* 23.8 娃娃屋切到一层：二层（和它的家具）藏起来，相机整体下移一个标高差；室内视角显示全部楼层 */
      const ty0 = three.controls.target.y;
      Q('#lvBtns button[data-lv="lv1"]').click();
      await wait3D(80);
      const hid = !G.get(lv2).visible && G.get('lv1').visible && !furn23.g.visible;
      const dT = three.controls.target.y - ty0;
      setCamMode('fp');
      await tick();
      // setCamMode 末尾的 controls.update() 会把室内机位推高几厘米（S17 之前就这样）——
      // 这里断的是「站在这一层」：离这一层的眼高 < 0.5ft（站错层差的是一整个层高）
      const fpY = three.cam.position.y;
      const fpAll = G.get(lv2).visible && furn23.g.visible && Math.abs(fpY - eyeY()) < 0.5;
      setCamMode('doll');
      await tick();
      T(
        'pb-lv-3d-doll-shows-below',
        hid && Math.abs(dT + L2.elev) < 1e-6 && fpAll,
        '二层隐藏=' +
          hid +
          ' · 相机目标 Δy=' +
          dT.toFixed(2) +
          ' · 室内全显=' +
          fpAll +
          '（机位 y=' +
          fpY.toFixed(2) +
          '）'
      );

      /* 23.8b 在 3D 里点「＋ 加一层」：新楼层（连同带上来的外壳）当场出现在 3D 里 —— 切层不重建 3D，但加层改了内容的并集
         （审查实测：以前要等下一次改几何才出现，相机还被抬到一层空气里）；撤销后回到两层 */
      Q('#lvAddUp').click();
      await wait3D(80);
      const G8 = three.levelGroups,
        lv8 = DOC.level;
      const has8 = !!G8 && G8.size === 3 && G8.has(lv8) && G8.get(lv8).children.length > 0;
      undoStep();
      await wait3D(80);
      const back8 = three.levelGroups.size === 2 && DOC.level === 'lv1';
      T(
        'pb-lv-3d-add-level-appears',
        has8 && back8,
        '加层后 3D 组 ' +
          (G8 ? G8.size : 0) +
          ' 个（新层有构件=' +
          has8 +
          '）· 撤销后 ' +
          three.levelGroups.size +
          ' 个'
      );
      setView('2d');
      await tick();
      await enterEdit();

      /* 23.9 撤销跨层：撤掉「画楼梯」→ 楼梯没了；再撤「二层放家具」→ 视图回到二层、家具没了；重做两步全回来 */
      undoStep();
      await tick();
      const u1 = DOC.level === 'lv1' && (DOC.stairs || []).length === 0;
      undoStep();
      await tick();
      const u2 = DOC.level === lv2 && !state.items.some((i) => i.uid === it23.uid);
      redoStep();
      await tick();
      redoStep();
      await tick();
      const u3 =
        DOC.level === 'lv1' &&
        (DOC.stairs || []).length === 1 &&
        state.items.some((i) => i.uid === it23.uid && i.lv === lv2);
      T('pb-lv-undo-cross-level', u1 && u2 && u3, '撤楼梯=' + u1 + ' · 撤家具回到二层=' + u2 + ' · 重做两步=' + u3);

      /* 23.10 改一层层高 → 二层标高跟着重排（层高 + 楼板），楼梯跟着变高（踏步重算，最后一级仍齐平上层地面） */
      Q('#lvMore').click();
      await tick();
      Q('#lvCeil').value = '300';
      Q('#lvCeil').dispatchEvent(new Event('change'));
      await tick();
      const want10 = 300 / 30.48 + 1.0;
      const e10 = DOC.levels.find((l) => l.id === lv2).elev;
      const lay10 = stairLayoutOf(DOC.stairs[0]);
      T(
        'pb-lv-ceil-relayout',
        Math.abs(DOC.ceilingH - 300 / 30.48) < 1e-6 &&
          Math.abs(e10 - want10) < 1e-6 &&
          Math.abs(lay10.rise - want10) < 1e-6 &&
          Math.abs(lay10.steps[lay10.steps.length - 1].top - want10) < 1e-6 &&
          lay10.stepsN === Math.round(want10 / (17.5 / 30.48)),
        '二层标高 ' + e10.toFixed(3) + '（独立量 ' + want10.toFixed(3) + '）· 楼梯 ' + lay10.stepsN + ' 级'
      );
      undoStep();
      await tick();

      /* 23.10b 层高上下限按 cm 判：输入框允许的 610cm 收下（以前 610/30.48 = 20.013 > 20 被拒）、212cm 拒（门扇 207cm 会戳出天花）；
         吸顶灯按层高建模：改层高后 3D 里灯跟着上去，抬高量 = 层高差（以前签名里没有层高，只挪了位姿 → 抬高 0） */
      const setCeil = async (cm) => {
        Q('#lvCeil').value = String(cm);
        Q('#lvCeil').dispatchEvent(new Event('change'));
        await tick();
      };
      const r10 = undoRing.length;
      await setCeil(610);
      const took610 = Math.abs(DOC.ceilingH - 610 / 30.48) < 1e-6 && undoRing.length === r10 + 1;
      undoStep();
      await tick();
      await setCeil(212);
      const refused212 = Math.abs(DOC.ceilingH - ceil1) < 1e-9 && undoRing.length === r10;
      Q('#lvCeil').value = String(Math.round(ceil1 * 30.48));
      const lamp = CATALOG.find((c) => c.kind === 'ceilingLight');
      addItem(lamp.id);
      await tick();
      const lampIt = state.items[state.items.length - 1];
      const topOf = () => {
        const rec = three.furnMap.get(lampIt.uid);
        rec.g.updateMatrixWorld(true);
        return new THREE.Box3().setFromObject(rec.g).max.y;
      };
      setView('3d');
      await wait3D(80);
      const top0 = topOf();
      setView('2d');
      await tick();
      await setCeil(300);
      setView('3d');
      await wait3D(80);
      const top1 = topOf();
      setView('2d');
      await tick();
      await enterEdit();
      undoStep(); // 层高
      await tick();
      undoStep(); // 那盏灯
      await tick();
      T(
        'pb-lv-ceil-limits-and-lamp-follows',
        took610 &&
          refused212 &&
          Math.abs(top1 - top0 - (300 / 30.48 - ceil1)) < 0.02 &&
          !state.items.some((i) => i.uid === lampIt.uid),
        '610cm 收下=' +
          took610 +
          ' · 212cm 拒=' +
          refused212 +
          ' · 吸顶灯顶 ' +
          top0.toFixed(2) +
          ' → ' +
          top1.toFixed(2) +
          'ft（天花 ' +
          ceil1.toFixed(2) +
          ' → ' +
          (300 / 30.48).toFixed(2) +
          '）'
      );

      /* 23.11 往下加（地下室）：标高 = −(层高 + 楼板)；楼层条三个按钮自上而下；删它要点两次，删完回到相邻层 */
      Q('#lvAddDown').click();
      await tick();
      const b11 = DOC.levels.find((l) => l.id === DOC.level);
      const order11 = lvBtns()
        .map((b) => b.textContent)
        .join('/');
      Q('#lvDel').click();
      await tick();
      const armed = DOC.levels.length === 3;
      // 点亮「再点一次就删」之后切走再切回来：确认状态作废（换户型 / 撤销同理），这一下只是重新点亮
      const bId = DOC.level;
      Q('#lvBtns button[data-lv="lv1"]').click();
      await tick();
      Q('#lvBtns button[data-lv="' + bId + '"]').click();
      await tick();
      Q('#lvDel').click();
      await tick();
      const rearmed = DOC.levels.length === 3;
      Q('#lvDel').click();
      await tick();
      T(
        'pb-lv-basement-add-delete',
        b11.name === '地下室' &&
          Math.abs(b11.elev + (DOC.ceilingH + 1.0)) < 1e-6 &&
          order11 === '二层/一层/地下室' &&
          armed &&
          rearmed &&
          DOC.levels.length === 2 &&
          DOC.level === 'lv1',
        b11.name +
          '@' +
          b11.elev.toFixed(2) +
          ' · 条 ' +
          order11 +
          ' · 第一次点删除只是确认=' +
          armed +
          ' · 切走再回来要重新确认=' +
          rearmed +
          ' · 删后当前层 ' +
          DOC.level
      );

      /* 23.12 整图缩放 ×2：不在当前层的二层也一起缩（同一个中心）—— 否则上下层错位 */
      const k2 = LV.levelContentOf(DOC, lv2).walls[0].geom;
      const len2 = Math.hypot(k2.x2 - k2.x1, k2.y2 - k2.y1);
      const k1 = DOC.walls[0].geom;
      const len1 = Math.hypot(k1.x2 - k1.x1, k1.y2 - k1.y1);
      pushUndo('pb-lv-rescale', true);
      rescaleDocPlan(2);
      geoChanged();
      await tick();
      const g2 = LV.levelContentOf(DOC, lv2).walls[0].geom,
        g1 = DOC.walls[0].geom;
      const len2b = Math.hypot(g2.x2 - g2.x1, g2.y2 - g2.y1),
        len1b = Math.hypot(g1.x2 - g1.x1, g1.y2 - g1.y1);
      const same = Math.abs(g2.x1 - g1.x1) < 0.02 && Math.abs(g2.y1 - g1.y1) < 0.02; // 上下层同一面外墙仍重合
      T(
        'pb-lv-rescale-all-levels',
        Math.abs(len2b / len2 - 2) < 0.01 && Math.abs(len1b / len1 - 2) < 0.01 && same,
        '一层 ' +
          len1.toFixed(2) +
          '→' +
          len1b.toFixed(2) +
          ' · 二层 ' +
          len2.toFixed(2) +
          '→' +
          len2b.toFixed(2) +
          ' · 重合=' +
          same
      );
      undoStep();
      await tick();

      /* 23.13 导出往返：整栋（两层 + 当前层）过校验；不在当前层的那层也带上自己的地板轮廓 */
      const ex = JSON.parse(exportDocJSON());
      const im = importDocFromJSON(JSON.stringify(ex));
      const exL2 = (ex.levels || []).find((l) => l.id === lv2);
      T(
        'pb-lv-export-roundtrip',
        im.errs.length === 0 &&
          ex.levels.length === 2 &&
          ex.level === 'lv1' &&
          !!exL2 &&
          Array.isArray(exL2.floorOutline) &&
          exL2.floorOutline.length >= 4 &&
          exL2.walls.length === 6 &&
          exL2.windows.length === 1 &&
          (exL2.stairs || []).length === 0 &&
          (ex.stairs || []).length === 1,
        '校验错误 ' +
          im.errs.length +
          ' · 二层轮廓 ' +
          (exL2 && exL2.floorOutline ? exL2.floorOutline.length : 0) +
          ' 点'
      );

      /* 23.14 删掉二层：它的家具一起删（两步确认、可撤销）；撤销回来家具还在二层 */
      Q('#lvBtns button[data-lv="' + lv2 + '"]').click();
      await tick();
      const nI = state.items.length;
      Q('#lvDel').click();
      await tick();
      Q('#lvDel').click();
      await tick();
      const del14 = DOC.levels.length === 1 && state.items.length === nI - 1 && DOC.level === 'lv1';
      undoStep();
      await tick();
      const back14 = DOC.levels.length === 2 && state.items.some((i) => i.uid === it23.uid && i.lv === lv2);
      T('pb-lv-delete-with-items', del14 && back14, '删=' + del14 + ' · 撤销回来=' + back14);

      /* 23.15 每层一张图：加一层「不带外墙」的空楼层 → 导入底图时缺省「放进这一层」（不新建户型）；
         底图摆在房子正中；空楼层的地板轮廓沿用下一层的（不是底图那块带留白的包围盒）；一步撤销 */
      Q('#lvCopyShell').checked = false;
      Q('#lvAddUp').click();
      await tick();
      Q('#lvCopyShell').checked = true;
      const lv15 = DOC.level,
        plans15 = PLAN_REG.plans.length;
      const fpBelow = LV.levelContentOf(DOC, lv2) ? withLevel(lv2, () => floorPts()) : null;
      const cv15 = document.createElement('canvas');
      cv15.width = 400;
      cv15.height = 300;
      const g15 = cv15.getContext('2d');
      g15.fillStyle = '#fff';
      g15.fillRect(0, 0, 400, 300);
      g15.fillStyle = '#000';
      g15.fillRect(40, 30, 320, 240);
      const im15 = new Image();
      im15.src = cv15.toDataURL('image/png');
      _imgPending = { data: im15.src, w: 400, h: 300, name: 'pb-二层图', pts: [], _im: im15 };
      openImgModal();
      await tick();
      const destShown = getComputedStyle(Q('#imgDestRow')).display !== 'none',
        destDefault = Q('#imgDest').value,
        okText = Q('#imgOk').textContent;
      const r15 = undoRing.length;
      const trace0 = Q('#imgTraceChk').checked;
      Q('#imgTraceChk').checked = false; // 特征线提取是异步的，别让它在后面几步里才落地
      Q('#imgOk').click();
      await tick();
      Q('#imgTraceChk').checked = trace0;
      const bi15 = DOC.baseImage;
      const bb = (P) => {
        const xs = P.map((q) => q[0]),
          ys = P.map((q) => q[1]);
        return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      };
      const fpNow = floorPts();
      const [fx0, fy0, fx1, fy1] = bb(fpNow);
      const [bx0, by0, bx1, by1] = bb(fpBelow);
      const imgW = (400 * 0.01) / 0.3048,
        imgH = (300 * 0.01) / 0.3048; // 未标定：1px = 1cm
      const centered =
        !!bi15 &&
        Math.abs(bi15.ox + imgW / 2 - (bx0 + bx1) / 2) < 0.05 &&
        Math.abs(bi15.oy + imgH / 2 - (by0 + by1) / 2) < 0.05;
      const sameOutline =
        Math.abs(fx0 - bx0) < 1e-6 &&
        Math.abs(fy0 - by0) < 1e-6 &&
        Math.abs(fx1 - bx1) < 1e-6 &&
        Math.abs(fy1 - by1) < 1e-6;
      undoStep();
      await tick();
      const undone = DOC.level === lv15 && !DOC.baseImage;
      T(
        'pb-lv-image-per-level',
        destShown &&
          destDefault === 'level' &&
          okText === '导入到这一层' &&
          !!bi15 &&
          PLAN_REG.plans.length === plans15 &&
          DOC.walls.length === 0 &&
          centered &&
          sameOutline &&
          undoRing.length === r15 &&
          undone,
        '缺省=' +
          destDefault +
          ' · 按钮「' +
          okText +
          '」· 没新建户型=' +
          (PLAN_REG.plans.length === plans15) +
          ' · 居中=' +
          centered +
          ' · 空楼层轮廓沿用下层=' +
          sameOutline +
          ' · 撤销=' +
          undone
      );

      /* 收尾：删掉这份户型 */
      Q('#lvMore').click();
      await tick();
      await enterEdit();
      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      T(
        'pb-lv-clean-exit',
        PLAN_ID !== p23Plan && PLAN_REG.plans.length === p23Plans && !hasLevelsNow(),
        'plans ' + p23Plans + '→' + PLAN_REG.plans.length
      );
    }

    /* ===== 24. S18 摆家具：贴墙吸附（Alt 不吸）/ 拖动时的离墙距离 / 插进墙里 / 挡住门扇 ===== */
    {
      /* gap 审计 G6 / G7。独立量：墙皮 = 轴线 ± 画出来的半厚（pbDrawnThick 从 wallPolys 量，不照抄实现）；
         距离标注 = 家具边到墙皮的差；门扇扫过的扇形用 doorSweeps() 的几何，但「挡没挡」按家具摆的位置独立构造。 */
      await enterEdit();
      await pbReset();
      const p24Plans = PLAN_REG.plans.length;
      Q('#btnPlanNew').click();
      await tick();
      const p24Plan = PLAN_ID;
      const fp24 = floorPts();
      const X =
          Math.min.apply(
            null,
            fp24.map((p) => p[0])
          ) + 1,
        Y =
          Math.min.apply(
            null,
            fp24.map((p) => p[1])
          ) + 1;
      const RW = 16,
        RH = 12,
        wd15 = cmToWd(15);
      const wTop = pushUserWall(X, Y, X + RW, Y, 'w', wd15);
      pushUserWall(X + RW, Y, X + RW, Y + 4, 'w', wd15);
      pushUserWall(X + RW, Y + 4, X + RW, Y + 7, 'd', wd15); // 右墙上的门洞
      pushUserWall(X + RW, Y + 7, X + RW, Y + RH, 'w', wd15);
      pushUserWall(X + RW, Y + RH, X, Y + RH, 'w', wd15);
      pushUserWall(X, Y + RH, X, Y, 'w', wd15);
      const door24 = pushUserDoor(X + RW, Y + 4, X + RW, Y + 7);
      geoChanged();
      fit2DToContent();
      await tick();
      const half = pbDrawnThick(effWalls().find((s) => s._id === wTop.id)) / 2;
      const faceTop = Y + half,
        faceLeft = X + half;
      if (wallEdit.on) {
        Q('#btnWallEdit').click(); // 家具在普通模式里拖
        await tick();
      }
      const spec24 = CATALOG.find((c) => c.kind === 'sofa' && c.w >= 150 && c.d >= 70);
      addItem(spec24.id);
      await tick();
      const uid24 = state.items[state.items.length - 1].uid;
      const live = () => state.items.find((i) => i.uid === uid24);
      const W = cm2ft(spec24.w),
        D = cm2ft(spec24.d);
      const putAt = (x, y) => {
        Object.assign(live(), { x, y, rot: 0 });
        drawFurniture();
      };
      putAt(X + RW / 2, Y + RH / 2);
      await tick();
      const dragTo = async (fx, fy, extra) => {
        const [cx, cy] = SPT(live().x, live().y),
          [tx, ty] = SPT(fx, fy);
        fire('pointerdown', cx, cy);
        await tick();
        fire('pointermove', (cx + tx) / 2, (cy + ty) / 2, extra);
        await tick();
        fire('pointermove', tx, ty, extra);
        await tick();
        const mid = {
          guides: pbSvg.querySelectorAll('.distGuide').length,
          snap: pbSvg.querySelectorAll('.snapFace').length,
          lbls: Array.from(pbSvg.querySelectorAll('.distLbl')).map((t) => t.textContent),
          x: live().x,
          y: live().y,
        };
        fire('pointerup', tx, ty, extra);
        await tick();
        return mid;
      };
      const ppf = pxPerFtNow();

      /* 24.1 拖到离上墙皮 6 屏幕像素 → 贴上（上沿 = 墙皮）；拖动中贴上的那面墙皮描绿、四周有距离标注，
         左边那条读数 = 左沿到左墙皮的独立量；松手后标注消失 */
      const r1 = undoRing.length;
      const m1 = await dragTo(X + RW / 2, faceTop + D / 2 + 6 / ppf);
      const wantLeft = m1.x - W / 2 - faceLeft;
      T(
        'pb-place-snap-to-wall',
        Math.abs(live().y - D / 2 - faceTop) < 1e-3 && m1.snap === 1 && undoRing.length === r1 + 1,
        '上沿 ' +
          (live().y - D / 2).toFixed(4) +
          ' · 墙皮 ' +
          faceTop.toFixed(4) +
          ' · 描绿 ' +
          m1.snap +
          ' · 撤销环 +' +
          (undoRing.length - r1)
      );
      T(
        'pb-place-distance-guides',
        m1.guides >= 2 && m1.lbls.includes(fmtLen(wantLeft)) && pbSvg.querySelectorAll('.distGuides').length === 0,
        '拖动中标注 ' +
          m1.guides +
          ' 条（' +
          m1.lbls.join(' / ') +
          '）· 左边独立量 ' +
          fmtLen(wantLeft) +
          ' · 松手后 ' +
          pbSvg.querySelectorAll('.distGuides').length
      );

      /* 24.2 按住 Alt 拖到同一个位置 → 不吸（停在拖到的地方，离墙皮约 6px） */
      putAt(X + RW / 2, Y + RH / 2);
      await dragTo(X + RW / 2, faceTop + D / 2 + 6 / ppf, { altKey: true });
      const gapAlt = live().y - D / 2 - faceTop;
      T(
        'pb-place-alt-no-snap',
        gapAlt > 3 / ppf && gapAlt < 9 / ppf,
        'Alt 拖完离墙皮 ' + (gapAlt * ppf).toFixed(1) + 'px'
      );

      /* 24.3 拖进左上墙角（两面都在半径内）→ 两面都贴上 */
      putAt(X + RW / 2, Y + RH / 2);
      const m3 = await dragTo(faceLeft + W / 2 + 5 / ppf, faceTop + D / 2 + 5 / ppf);
      T(
        'pb-place-snap-corner',
        Math.abs(live().x - W / 2 - faceLeft) < 1e-3 && Math.abs(live().y - D / 2 - faceTop) < 1e-3 && m3.snap === 2,
        '左沿差 ' +
          (live().x - W / 2 - faceLeft).toExponential(1) +
          ' · 上沿差 ' +
          (live().y - D / 2 - faceTop).toExponential(1) +
          ' · 描绿 ' +
          m3.snap
      );

      /* 24.4 插进墙里 0.4ft → 红框 + 提示「插进墙里」；正好贴着（只碰边）→ 不红 */
      const furnG = () => pbSvg.querySelector('g.furn[data-uid="' + uid24 + '"]');
      putAt(X + RW / 2, faceTop + D / 2 - 0.4);
      const inW =
        furnG().classList.contains('inWall') &&
        /插进墙里/.test((furnG().querySelector('title') || {}).textContent || '');
      putAt(X + RW / 2, faceTop + D / 2);
      const flushOk = !furnG().classList.contains('inWall');
      T('pb-place-in-wall', inW && flushOk, '插进去 0.4ft 标红=' + inW + ' · 贴着不红=' + flushOk);

      /* 24.5 摆进门扇扫过的扇形 → 家具红框 +「挡住门」、扇形整个画红（data-door = 那扇门）；挪开 → 都没了 */
      const sw = doorSweeps().find((d) => d.id === door24.id);
      const cen = sw.poly.reduce((a, p) => [a[0] + p[0] / sw.poly.length, a[1] + p[1] / sw.poly.length], [0, 0]);
      putAt(cen[0], cen[1]);
      const blk =
        furnG().classList.contains('blocksDoor') && !!pbSvg.querySelector('.doorBlk[data-door="' + door24.id + '"]');
      putAt(X + 4, Y + RH / 2);
      const free = !furnG().classList.contains('blocksDoor') && pbSvg.querySelectorAll('.doorBlk').length === 0;
      T('pb-place-blocks-door', blk && free, '摆进扇形=' + blk + ' · 挪开后扇形消失=' + free);

      /* 24.6 对照组：地毯压到墙上不算插墙；吸顶灯在门扇上方不算挡门 */
      const rug = CATALOG.find((c) => c.kind === 'rug');
      addItem(rug.id);
      await tick();
      const rugIt = state.items[state.items.length - 1];
      Object.assign(rugIt, { x: X + RW / 2, y: faceTop + cm2ft(rug.d) / 2 - 0.5, rot: 0 });
      const lampC = CATALOG.find((c) => c.kind === 'ceilingLight');
      addItem(lampC.id);
      await tick();
      const lampIt = state.items[state.items.length - 1];
      Object.assign(lampIt, { x: cen[0], y: cen[1], rot: 0 });
      drawFurniture();
      const gR = pbSvg.querySelector('g.furn[data-uid="' + rugIt.uid + '"]'),
        gL = pbSvg.querySelector('g.furn[data-uid="' + lampIt.uid + '"]');
      T(
        'pb-place-rug-lamp-exempt',
        !!gR &&
          !gR.classList.contains('inWall') &&
          !!gL &&
          !gL.classList.contains('blocksDoor') &&
          pbSvg.querySelectorAll('.doorBlk').length === 0,
        '地毯压墙不红=' +
          (gR && !gR.classList.contains('inWall')) +
          ' · 吸顶灯在门扇上方不红=' +
          (gL && !gL.classList.contains('blocksDoor'))
      );

      /* 收尾：删掉这份户型 */
      await enterEdit();
      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      T(
        'pb-place-clean-exit',
        PLAN_ID !== p24Plan && PLAN_REG.plans.length === p24Plans,
        'plans ' + p24Plans + '→' + PLAN_REG.plans.length
      );
    }

    /* ===== 25. S19 家具离地（壁挂电视 / 搁板）：检视面板「离地」→ 2D 虚线 +「离地 xx」/ 3D 抬高 / 高度区间进碰撞、遮挡、挡门 ===== */
    {
      /* gap 审计 G9。独立量：3D 底面 = 离地值；碰撞 = 两件的高度区间是否相交（电视底 120cm > 电视柜顶 50cm → 不碰）；
         插座遮挡 = 面板 [h ± 半高] 与家具高度区间相交；挡门 = 整件是否高过门洞上沿（门扇 207cm）。 */
      await enterEdit();
      await pbReset();
      const p25Plans = PLAN_REG.plans.length;
      Q('#btnPlanNew').click();
      await tick();
      const p25Plan = PLAN_ID;
      const fp25 = floorPts();
      const X =
          Math.min.apply(
            null,
            fp25.map((p) => p[0])
          ) + 1,
        Y =
          Math.min.apply(
            null,
            fp25.map((p) => p[1])
          ) + 1;
      const RW = 16,
        RH = 12,
        wd15 = cmToWd(15);
      const wTop = pushUserWall(X, Y, X + RW, Y, 'w', wd15);
      pushUserWall(X + RW, Y, X + RW, Y + 4, 'w', wd15);
      pushUserWall(X + RW, Y + 4, X + RW, Y + 7, 'd', wd15);
      pushUserWall(X + RW, Y + 7, X + RW, Y + RH, 'w', wd15);
      pushUserWall(X + RW, Y + RH, X, Y + RH, 'w', wd15);
      pushUserWall(X, Y + RH, X, Y, 'w', wd15);
      const door25 = pushUserDoor(X + RW, Y + 4, X + RW, Y + 7);
      geoChanged();
      fit2DToContent();
      await tick();
      const half = pbDrawnThick(effWalls().find((s) => s._id === wTop.id)) / 2;
      const faceTop = Y + half;
      // 上墙上一个 30cm 的普通插座（点位工具同一条放置路径）
      const sn = pointSnap(X + 8, faceTop + 0.2, 'std', 'auto');
      const ol25 = pushUserOutlet(sn, 'std', 1, null);
      syncOutlets && syncOutlets();
      if (wallEdit.on) {
        Q('#btnWallEdit').click();
        await tick();
      }
      const mk = (name, w, d, h, x, y) => {
        const uid = uidSeq++;
        state.items.push({ uid, custom: { name, w, d, h, color: '#5a5f66' }, x, y, rot: 0 });
        return uid;
      };
      const tvU = mk('测试电视', 123, 8, 72, X + 8, faceTop + 4 / 30.48);
      const benchU = mk('测试电视柜', 180, 40, 50, X + 8, faceTop + 20 / 30.48);
      const shelfU = mk('测试搁板', 80, 20, 15, X + 4, Y + RH / 2);
      const it25 = (u) => state.items.find((i) => i.uid === u);
      const g25 = (u) => pbSvg.querySelector('g.furn[data-uid="' + u + '"]');
      drawFurniture();
      await tick();
      const setZ = async (cm) => {
        Q('#pZ').value = String(cm);
        Q('#pZ').dispatchEvent(new Event('change'));
        await tick();
      };

      /* 25.1 选中电视：「离地」框在；改成 120 → it.z = 120cm、一步撤销；重打 120 不占步；−5 / 超过「层高 − 件高」被拒且框回原值 */
      selected = tvU;
      drawFurniture();
      await tick();
      const rowShown = getComputedStyle(Q('#pZRow')).display !== 'none';
      const r1 = undoRing.length;
      await setZ(120);
      const z1 = it25(tvU).z,
        step1 = undoRing.length - r1;
      await setZ(120);
      const same = undoRing.length - r1;
      await setZ(-5);
      const neg = it25(tvU).z === z1 && Q('#pZ').value === '120';
      await setZ(Math.round(CEIL_H * 30.48) - 72 + 1);
      const tooHigh = it25(tvU).z === z1 && Q('#pZ').value === '120';
      T(
        'pb-z-props-field',
        rowShown && Math.abs(z1 - 120 / 30.48) < 1e-4 && step1 === 1 && same === 1 && neg && tooHigh,
        '框在=' +
          rowShown +
          ' · z=' +
          (z1 * 30.48).toFixed(1) +
          'cm · 撤销环 +' +
          step1 +
          '（重打后仍 +' +
          same +
          '）· 负数拒=' +
          neg +
          ' · 顶到天花拒=' +
          tooHigh
      );

      /* 25.2 2D：虚线外框 +「离地 120 cm」；画在落地家具之上（电视在电视柜上方，俯视看得见） */
      const gT = g25(tvU);
      const dash =
        gT && gT.querySelector('rect,circle') ? gT.querySelector('rect,circle').getAttribute('stroke-dasharray') : null;
      const lbl = gT && gT.querySelector('.zLbl') ? gT.querySelector('.zLbl').textContent : '';
      const order = [...gFurn.children].map((e) => +e.dataset.uid);
      T(
        'pb-z-2d-marked',
        !!gT &&
          gT.classList.contains('elevated') &&
          !!dash &&
          lbl === '离地 ' + fmtLen(120 / 30.48) &&
          order.indexOf(tvU) > order.indexOf(benchU),
        'class=' +
          (gT ? gT.getAttribute('class') : '?') +
          ' · 虚线=' +
          dash +
          ' · 标注「' +
          lbl +
          '」· 画在电视柜之上=' +
          (order.indexOf(tvU) > order.indexOf(benchU))
      );

      /* 25.2b 薄件（电视 8cm 深）：「离地」标注放到正面外侧、不压件名；转 180° 后字不倒、仍在正面那一侧
         （以前标注就在件名上叠着，转半圈后倒着写） */
      const lblBoxes = (u) => {
        const g = g25(u),
          z = g && g.querySelector('.zLbl'),
          nm = g && g.querySelector('text:not(.zLbl)');
        if (!z || !nm) return null;
        const a = z.getBoundingClientRect(),
          b = nm.getBoundingClientRect(),
          body = g.querySelector('rect,circle').getBoundingClientRect();
        const hit = !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
        return { hit, up: z.getScreenCTM().a > 0, zc: (a.top + a.bottom) / 2, bc: (body.top + body.bottom) / 2 };
      };
      const lb0 = lblBoxes(tvU);
      it25(tvU).rot = 180;
      drawFurniture();
      await tick();
      const lb1 = lblBoxes(tvU);
      it25(tvU).rot = 0;
      drawFurniture();
      T(
        'pb-z-label-clear',
        !!lb0 && !!lb1 && !lb0.hit && !lb1.hit && lb0.up && lb1.up && lb0.zc > lb0.bc && lb1.zc < lb1.bc,
        lb0 && lb1
          ? '0°：压件名=' +
              lb0.hit +
              ' 正立=' +
              lb0.up +
              ' 在正面（下）=' +
              (lb0.zc > lb0.bc) +
              ' · 180°：压件名=' +
              lb1.hit +
              ' 正立=' +
              lb1.up +
              ' 在正面（上）=' +
              (lb1.zc < lb1.bc)
          : '标注或件名缺失'
      );

      /* 25.3 碰撞按高度区间：电视（120–192cm）在电视柜（0–50cm）正上方 → 不算重叠；电视放回地上 → 重叠 */
      Object.assign(it25(tvU), { x: X + 8, y: faceTop + 20 / 30.48 }); // 与电视柜同一块占地
      drawFurniture();
      const noOv = !g25(tvU).classList.contains('overlap') && !g25(benchU).classList.contains('overlap');
      const zSave = it25(tvU).z;
      delete it25(tvU).z;
      drawFurniture();
      const ov = g25(tvU).classList.contains('overlap') && g25(benchU).classList.contains('overlap');
      it25(tvU).z = zSave;
      T('pb-z-overlap-by-height', noOv && ov, '挂在 120cm 不碰电视柜=' + noOv + ' · 放回地上就重叠=' + ov);

      /* 25.4 插座遮挡按高度区间：电视贴上墙、正对 30cm 的插座 —— 挂在 120cm 不挡，放到地上就挡 */
      Object.assign(it25(benchU), { x: X + 3, y: Y + RH - 2 }); // 电视柜挪开
      Object.assign(it25(tvU), { x: ol25.x, y: faceTop + 4 / 30.48 });
      drawFurniture();
      const freeHigh = !(ptBlocked.get(ol25.id) || []).length;
      delete it25(tvU).z;
      drawFurniture();
      const blkLow = (ptBlocked.get(ol25.id) || []).includes('测试电视');
      it25(tvU).z = zSave;
      drawFurniture();
      T('pb-z-outlet-by-height', freeHigh && blkLow, '挂在 120cm 不挡插座=' + freeHigh + ' · 放到地上挡=' + blkLow);

      /* 25.5 挡门按「是否整件高过门洞上沿」：搁板（高 15cm）底边 215cm → 门扇从它下面扫过，不算挡；底边 100cm → 挡 */
      const sw25 = doorSweeps().find((d) => d.id === door25.id);
      const cen25 = sw25.poly.reduce(
        (a, p) => [a[0] + p[0] / sw25.poly.length, a[1] + p[1] / sw25.poly.length],
        [0, 0]
      );
      Object.assign(it25(shelfU), { x: cen25[0], y: cen25[1], z: 215 / 30.48 });
      drawFurniture();
      const highOk = !g25(shelfU).classList.contains('blocksDoor');
      it25(shelfU).z = 100 / 30.48;
      drawFurniture();
      const lowBlk = g25(shelfU).classList.contains('blocksDoor');
      Object.assign(it25(shelfU), { x: X + 4, y: Y + RH / 2 });
      drawFurniture();
      T('pb-z-door-by-height', highOk && lowBlk, '底边 215cm 不挡门=' + highOk + ' · 底边 100cm 挡=' + lowBlk);

      /* 25.6 3D：电视的包围盒底面 = 离地 120cm（独立量）；搁板 100cm */
      setView('3d');
      await wait3D(80);
      await tick();
      const bb = (u) => {
        const rec = three.furnMap.get(u);
        rec.g.updateMatrixWorld(true);
        return new THREE.Box3().setFromObject(rec.g);
      };
      const tvMin = bb(tvU).min.y,
        shMin = bb(shelfU).min.y;
      setView('2d');
      await tick();
      T(
        'pb-z-3d-raised',
        Math.abs(tvMin - 120 / 30.48) < 0.03 && Math.abs(shMin - 100 / 30.48) < 0.03,
        '电视底 ' + (tvMin * 30.48).toFixed(1) + 'cm · 搁板底 ' + (shMin * 30.48).toFixed(1) + 'cm'
      );

      /* 25.7 撤销把离地退回去（面板跟着回去）；导入布局：z 原样收下、非法的 z（负数）被丢掉 */
      selected = tvU;
      drawFurniture();
      await tick();
      const ringU = undoRing.length;
      await setZ(150);
      undoStep();
      await tick();
      const undoOk =
        Math.abs((state.items.find((i) => i.uid === tvU).z || 0) - zSave) < 1e-9 && undoRing.length === ringU;
      const lay = {
        items: [
          { uid: 9001, custom: { name: '导入电视', w: 100, d: 8, h: 60 }, x: X + 5, y: Y + 3, rot: 0, z: 110 / 30.48 },
          { uid: 9002, custom: { name: '坏离地', w: 50, d: 30, h: 40 }, x: X + 9, y: Y + 6, rot: 0, z: -3 },
        ],
        customCat: [],
      };
      const toastTxt = () => (Q('#toast') || {}).textContent || '';
      for (let tryN = 0; tryN < 3; tryN++) {
        const before = toastTxt();
        const dt = new DataTransfer();
        dt.items.add(new File([JSON.stringify(lay)], '家具布局.json', { type: 'application/json' }));
        Q('#fileJson').files = dt.files;
        Q('#fileJson').dispatchEvent(new Event('change', { bubbles: true }));
        let got = false;
        for (let i = 0; i < 40 && !got; i++) {
          await tick();
          got = toastTxt() !== before && /已导入布局/.test(toastTxt());
        }
        if (got) break;
      }
      const iA = state.items.find((i) => i.uid === 9001),
        iB = state.items.find((i) => i.uid === 9002);
      T(
        'pb-z-undo-and-import',
        undoOk && !!iA && Math.abs(iA.z - 110 / 30.48) < 1e-9 && !!iB && !('z' in iB),
        '撤销回到 120=' +
          undoOk +
          ' · 导入 z=110 收下=' +
          !!(iA && Math.abs(iA.z - 110 / 30.48) < 1e-9) +
          ' · 负数被丢=' +
          !!(iB && !('z' in iB))
      );

      /* 收尾：删掉这份户型 */
      await enterEdit();
      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      T(
        'pb-z-clean-exit',
        PLAN_ID !== p25Plan && PLAN_REG.plans.length === p25Plans,
        'plans ' + p25Plans + '→' + PLAN_REG.plans.length
      );
    }

    /* ===== 26. S20 多选（Shift+点 / 框选 / 整组拖 / 整组快捷键 / 面板 / 清单行）+ 采购清单导出 ===== */
    {
      /* gap 审计 G12 / G13。独立量：整组拖 = 每件位移都等于被拖那件的位移；整组转 = 每件到组中心的距离不变、
         朝向都加同一个角；每个动作一步撤销；导出的合计 = 界面「合计约」那一行（四舍五入）；CSV 每格能还原。 */
      await enterEdit();
      await pbReset();
      const p26Plans = PLAN_REG.plans.length;
      Q('#btnPlanNew').click();
      await tick();
      const p26Plan = PLAN_ID;
      if (wallEdit.on) {
        Q('#btnWallEdit').click();
        await tick();
      }
      const fp26 = floorPts();
      const X = Math.min.apply(
          null,
          fp26.map((p) => p[0])
        ),
        Y = Math.min.apply(
          null,
          fp26.map((p) => p[1])
        );
      const mk = (ref, x, y) => {
        const uid = uidSeq++;
        state.items.push({ uid, ref, x, y, rot: 0 });
        return uid;
      };
      const uA = mk('sansevieria-8', X + 3, Y + 3),
        uB = mk('knapper', X + 6, Y + 3),
        uC = mk('ficus-lyrata-12', X + 12, Y + 3),
        uD = mk('tv-55', X + 4, Y + 9);
      selOnly(null);
      fit2DToContent();
      drawFurniture();
      await tick();
      const it26 = (u) => state.items.find((i) => i.uid === u);
      const pos = (u) => [it26(u).x, it26(u).y];
      const srt = (a) => a.slice().sort((p, q) => p - q);
      const same = (a, b) => JSON.stringify(srt(a)) === JSON.stringify(srt(b));
      const clickItem = async (u, sh) => {
        const [x, y] = SPT(...pos(u));
        fire('pointerdown', x, y, { shiftKey: !!sh });
        await tick();
        fire('pointerup', x, y, { shiftKey: !!sh, buttons: 0 });
        await tick();
      };

      /* 26.1 点一件 → 只选它；Shift+点另两件 → 三件；再 Shift+点中间那件 → 减掉它。多选时：每件一个选中框、
         整组外包框 +「已选 N 件」、没有旋转手柄；检视面板「已选 2 件」+ 整组按钮 */
      await clickItem(uA);
      const s1 = selUids().slice();
      await clickItem(uB, true);
      await clickItem(uC, true);
      const s3 = selUids().slice();
      await clickItem(uB, true);
      const s2 = selUids().slice();
      const boxes = pbSvg.querySelectorAll('#ctxDims .selBox').length;
      T(
        'pb-ms-shift-click',
        same(s1, [uA]) &&
          same(s3, [uA, uB, uC]) &&
          same(s2, [uA, uC]) &&
          boxes === 2 &&
          !!pbSvg.querySelector('.selGroupBox') &&
          /已选 2 件/.test((pbSvg.querySelector('.selGroupLbl') || {}).textContent || '') &&
          !pbSvg.querySelector('#ctxDims .rotHandle') &&
          Q('#pTitle').textContent === '已选 2 件' &&
          getComputedStyle(Q('#pGroup')).display !== 'none' &&
          getComputedStyle(Q('#pFields')).display === 'none',
        '点 A=' +
          JSON.stringify(s1) +
          ' · +B+C=' +
          s3.length +
          ' 件 · −B=' +
          s2.length +
          ' 件 · 选中框 ' +
          boxes +
          ' · 面板「' +
          Q('#pTitle').textContent +
          '」'
      );

      /* 26.2 拖组里的一件 = 整组走（位移逐件相等），组外的不动；一步撤销；4px 手抖不算拖 */
      const a0 = pos(uA),
        b0 = pos(uB),
        c0 = pos(uC);
      const r2 = undoRing.length;
      const [cx, cy] = SPT(...c0);
      fire('pointerdown', cx, cy);
      await tick();
      fire('pointermove', cx + 3, cy + 2);
      await tick();
      const jitterStill = pos(uC)[0] === c0[0] && pos(uC)[1] === c0[1] && undoRing.length === r2;
      fire('pointermove', cx + 40, cy + 10);
      await tick();
      fire('pointermove', cx + 70, cy + 25);
      await tick();
      fire('pointerup', cx + 70, cy + 25, { buttons: 0 });
      await tick();
      const dA = [pos(uA)[0] - a0[0], pos(uA)[1] - a0[1]],
        dC = [pos(uC)[0] - c0[0], pos(uC)[1] - c0[1]];
      T(
        'pb-ms-group-drag',
        jitterStill &&
          Math.abs(dA[0] - dC[0]) < 1e-3 &&
          Math.abs(dA[1] - dC[1]) < 1e-3 &&
          dC[0] > 1 &&
          pos(uB)[0] === b0[0] &&
          pos(uB)[1] === b0[1] &&
          undoRing.length === r2 + 1 &&
          same(selUids(), [uA, uC]),
        '手抖 3px 不动=' +
          jitterStill +
          ' · A 位移 (' +
          dA.map((v) => v.toFixed(2)) +
          ') · C 位移 (' +
          dC.map((v) => v.toFixed(2)) +
          ') · B 没动=' +
          (pos(uB)[0] === b0[0]) +
          ' · 撤销环 +' +
          (undoRing.length - r2)
      );

      /* 26.3 点组里的一件、没拖 → 塌缩成只选它 */
      await clickItem(uA);
      T(
        'pb-ms-click-collapses',
        same(selUids(), [uA]) && Q('#pTitle').textContent !== '已选 2 件',
        '选择集 ' + JSON.stringify(selUids())
      );

      /* 26.4 Shift+在空白处拖 = 框选：框住中心的件，与现有选择取并集；拖动中有框、框住的件描出来；松手框消失；只选不改场景 */
      // 摆回一排（A 比起点右 0.5ft：与撤销环顶上那份快照不同，下面「一步撤销」的计数才有意义）
      Object.assign(it26(uA), { x: X + 3.5, y: Y + 3 });
      Object.assign(it26(uB), { x: X + 6, y: Y + 3 });
      Object.assign(it26(uC), { x: X + 12, y: Y + 3 });
      selOnly(uD);
      drawFurniture();
      await tick();
      const r4 = undoRing.length;
      const [m0x, m0y] = SPT(X + 1.2, Y + 1.2),
        [m1x, m1y] = SPT(X + 7.5, Y + 4.8);
      fire('pointerdown', m0x, m0y, { shiftKey: true });
      await tick();
      fire('pointermove', (m0x + m1x) / 2, (m0y + m1y) / 2, { shiftKey: true });
      await tick();
      const marqShown = !!pbSvg.querySelector('rect.marquee');
      fire('pointermove', m1x, m1y, { shiftKey: true });
      await tick();
      const hitMarked = pbSvg.querySelectorAll('.furn.marqHit').length;
      fire('pointerup', m1x, m1y, { shiftKey: true, buttons: 0 });
      await tick();
      T(
        'pb-ms-marquee',
        same(selUids(), [uA, uB, uD]) &&
          marqShown &&
          hitMarked === 2 &&
          !pbSvg.querySelector('rect.marquee') &&
          !pbSvg.querySelector('.furn.marqHit') &&
          undoRing.length === r4,
        '选择集 ' +
          JSON.stringify(srt(selUids())) +
          '（期望 A B + 原来的 D）· 拖动中有框=' +
          marqShown +
          ' · 框住描出 ' +
          hitMarked +
          ' 件 · 撤销环 +' +
          (undoRing.length - r4)
      );

      /* 26.5 R = 整组绕组中心转 15°：每件到中心的距离不变、方位角 +15°、朝向 +15°；一步撤销；Ctrl+Z 全回去 */
      selSetMany([uA, uB], uB);
      drawFurniture();
      const grp = () => [it26(uA), it26(uB)];
      let gx0 = Infinity,
        gy0 = Infinity,
        gx1 = -Infinity,
        gy1 = -Infinity;
      for (const g of grp())
        for (const c of obbCorners(g, itemSpec(g))) {
          gx0 = Math.min(gx0, c[0]);
          gy0 = Math.min(gy0, c[1]);
          gx1 = Math.max(gx1, c[0]);
          gy1 = Math.max(gy1, c[1]);
        }
      const gc = [(gx0 + gx1) / 2, (gy0 + gy1) / 2];
      const pol = (g) => [Math.hypot(g.x - gc[0], g.y - gc[1]), (Math.atan2(g.y - gc[1], g.x - gc[0]) * 180) / Math.PI];
      const before5 = grp().map((g) => ({ p: pol(g), rot: g.rot }));
      const r5 = undoRing.length;
      key('r');
      await tick();
      const after5 = grp().map((g) => ({ p: pol(g), rot: g.rot }));
      const dAng = (a, b) => ((b - a + 540) % 360) - 180;
      const rotOk = after5.every(
        (q, k) =>
          Math.abs(q.p[0] - before5[k].p[0]) < 1e-3 &&
          Math.abs(dAng(before5[k].p[1], q.p[1]) - 15) < 0.01 &&
          Math.abs(q.rot - (before5[k].rot + 15)) < 1e-9
      );
      const step5 = undoRing.length - r5;
      undoStep();
      await tick();
      const back5 =
        Math.abs(it26(uA).x - (X + 3.5)) < 1e-9 && Math.abs(it26(uB).x - (X + 6)) < 1e-9 && it26(uA).rot === 0;
      T(
        'pb-ms-rotate-group',
        rotOk && step5 === 1 && back5,
        '半径 / 方位角 +15° / 朝向 +15°=' + rotOk + ' · 撤销环 +' + step5 + ' · Ctrl+Z 回原位=' + back5
      );

      /* 26.6 Ctrl/⌘+D = 整组复制（偏移 1.5ft，副本成为选择集、主选 = 主选的副本）；方向键 = 整组平移；Delete = 全删；各一步撤销。
         S23：复制从 D 改成 Ctrl/⌘+D（D 让给「镜头往右」）——光按 D 不复制、只平移图纸 */
      selSetMany([uA, uB], uB);
      drawFurniture();
      const n6 = state.items.length,
        r6 = undoRing.length,
        vx6 = vb.x;
      key('d');
      await tick();
      const plainD = state.items.length === n6 && vb.x > vx6 && undoRing.length === r6;
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true, cancelable: true })
      );
      await tick();
      const cp = selItems();
      const dupOk =
        state.items.length === n6 + 2 &&
        cp.length === 2 &&
        cp.every((c) => c.uid !== uA && c.uid !== uB) &&
        cp.some((c) => c.ref === 'knapper' && c.uid === selected && Math.abs(c.x - (X + 7.5)) < 1e-9) &&
        undoRing.length === r6 + 1;
      const r6b = undoRing.length,
        cx6 = cp.map((c) => c.x);
      key('ArrowRight');
      key('ArrowRight');
      await tick();
      const nudgeOk =
        selItems().every((c, k) => Math.abs(c.x - (cx6[k] + 2 / 30.48)) < 1e-9) && undoRing.length === r6b + 1; // S23：1cm 一步
      const r6c = undoRing.length;
      key('Delete');
      await tick();
      const delOk = state.items.length === n6 && selected === null && undoRing.length === r6c + 1;
      undoStep();
      await tick();
      const undelOk = state.items.length === n6 + 2;
      undoStep();
      undoStep();
      await tick();
      T(
        'pb-ms-dup-nudge-delete',
        plainD && dupOk && nudgeOk && delOk && undelOk && state.items.length === n6,
        '光按 D 不复制、图纸往右平移=' +
          plainD +
          ' · Ctrl+D 复制 +2 且副本被选中=' +
          dupOk +
          ' · 方向键两下整组 +2cm 一步撤销=' +
          nudgeOk +
          ' · Delete 两件一起删=' +
          delOk +
          ' · 撤销回来=' +
          undelOk
      );

      /* 26.7 旧坑：单选时复制与方向键以前不进撤销环（复制完 Ctrl+Z 撤的是上一个动作） */
      selOnly(uD);
      drawFurniture();
      const n7 = state.items.length,
        r7 = undoRing.length;
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true, cancelable: true })
      );
      await tick();
      const d7 = state.items.length === n7 + 1 && undoRing.length === r7 + 1;
      undoStep();
      await tick();
      const d7back = state.items.length === n7;
      selOnly(uD);
      const x7 = it26(uD).x,
        r7b = undoRing.length;
      key('ArrowLeft');
      await tick();
      const a7 = Math.abs(it26(uD).x - (x7 - 1 / 30.48)) < 1e-9 && undoRing.length === r7b + 1; // S23：1cm
      undoStep();
      await tick();
      T(
        'pb-ms-single-dup-nudge-undoable',
        d7 && d7back && a7 && Math.abs(it26(uD).x - x7) < 1e-9,
        'Ctrl+D 一步撤销=' + d7 + ' · 撤回=' + d7back + ' · 方向键一步撤销=' + a7
      );

      /* 26.8 面板整组按钮（+90° 一步撤销）、Esc / 「取消多选」全不选；清单行 Shift+点 = 加减、普通点 = 只选它 */
      selSetMany([uA, uB], uA);
      drawFurniture();
      const r8 = undoRing.length,
        rot8 = it26(uB).rot;
      Q('#pgRot90').click();
      await tick();
      const rot90 = it26(uB).rot === (rot8 + 90) % 360 && undoRing.length === r8 + 1;
      key('Escape');
      await tick();
      const escOk = selected === null && selUids().length === 0;
      undoStep();
      await tick();
      const rowOf = (u) =>
        [...Q('#plRows').querySelectorAll('.plRow')].find((r) => r.textContent.indexOf(itemName(it26(u))) >= 0);
      rowOf(uA).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await tick();
      rowOf(uC).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
      await tick();
      const rowsSel = [...Q('#plRows').querySelectorAll('.plRow.sel')].length;
      const listOk = same(selUids(), [uA, uC]) && rowsSel === 2;
      Q('#pgNone').click();
      await tick();
      T(
        'pb-ms-panel-and-list',
        rot90 && escOk && listOk && selUids().length === 0,
        '整组 +90° 一步撤销=' + rot90 + ' · Esc 全不选=' + escOk + ' · 清单行 Shift+点 → ' + rowsSel + ' 行高亮'
      );

      /* 26.9 采购清单：同一件聚成一行；公寓自带灯具不进行；目录里没有的件单独成行；合计 = 界面那一行（四舍五入）；
         通用件 / 自定义件没价也进件数；CSV 带 BOM、公式字符被转义；文本一件一行 */
      mk('sansevieria-8', X + 15, Y + 9);
      const light = CATALOG.find((c) => isBuiltIn(c));
      mk(light.id, X + 10, Y + 10);
      const uG = uidSeq++;
      state.items.push({ uid: uG, ref: 'bench-gone-26', x: X + 16, y: Y + 6, rot: 0 });
      const uE = uidSeq++;
      state.items.push({
        uid: uE,
        custom: { name: '=1+1 自制柜', w: 80, d: 40, h: 90, color: '#888888' },
        x: X + 8,
        y: Y + 10,
        rot: 0,
      });
      drawFurniture();
      await tick();
      const totNum = () => {
        const m = (Q('#totals').textContent || '').match(/合计约\s*≈?\s*(?:US|CA)\$([\d,]+)/);
        return m ? +m[1].replace(/,/g, '') : NaN;
      };
      const L = shoppingListNow();
      const rowS = L.rows.find((r) => /SANSEVIERIA/.test(r.name));
      const rowG = L.rows.find((r) => r.ghost);
      const rowE = L.rows.find((r) => r.cat === '自定义');
      const rowTv = L.rows.find((r) => /电视 55/.test(r.name));
      const sumUsd = 24.99 * 2 + 129.99 + 69.99;
      const csv = CATPACK.shoppingCSV(L, { currency: 'US$' });
      const txt = CATPACK.shoppingText(L, { title: 'T', money: (v) => fmtMoney2(v) });
      T(
        'pb-shop-list',
        !!rowS &&
          rowS.qty === 2 &&
          Math.abs(rowS.subtotal - 49.98) < 1e-9 &&
          !L.rows.some((r) => r.name === light.name) &&
          L.builtin === 1 &&
          !!rowG &&
          rowG.unit === null &&
          L.ghost === 1 &&
          !!rowE &&
          rowE.why === '自定义件，无价' &&
          !!rowTv &&
          rowTv.why === '无独立售价' &&
          L.buy === 6 &&
          Math.abs(L.total - sumUsd) < 1e-6 &&
          Math.round(L.total) === totNum(),
        '虎尾兰 ×' +
          (rowS && rowS.qty) +
          ' · 行数 ' +
          L.rows.length +
          ' · 采购 ' +
          L.buy +
          ' 件 · 合计 ' +
          L.total.toFixed(2) +
          ' vs 界面 ' +
          totNum() +
          ' · 灯具不进行=' +
          !L.rows.some((r) => r.name === light.name)
      );
      T(
        'pb-shop-csv-text',
        csv.charCodeAt(0) === 0xfeff &&
          csv.indexOf('"\'=1+1 自制柜"') > 0 &&
          csv.indexOf('"SANSEVIERIA 虎尾兰（盆径 20）","2","24.99","49.98"') > 0 &&
          /"合计","6","","249\.96"/.test(csv) &&
          txt.indexOf('· SANSEVIERIA 虎尾兰（盆径 20） — US$24.99 × 2 = US$49.98 ') > 0 &&
          txt.split('\n').slice(-1)[0] ===
            '采购 6 件 · 合计约 US$249.96（2 件无价、1 件房子自带的灯不计价、1 件目录里没有（不计价））',
        'CSV ' + csv.length + ' 字 · 文本末行「' + txt.split('\n').slice(-1)[0] + '」'
      );

      /* 26.10 加元：琴叶榕加拿大无售 → 不计价、尾巴单数「加拿大无售」；合计仍与界面一致 */
      setCurrency('cad');
      await tick();
      const Lc = shoppingListNow();
      const sumCad = 24.99 * 2 + 74.99;
      T(
        'pb-shop-cad',
        Lc.na === 1 &&
          Math.abs(Lc.total - sumCad) < 1e-6 &&
          Math.round(Lc.total) === totNum() &&
          CATPACK.shoppingTail(Lc).indexOf('1 件加拿大无售') >= 0 &&
          CATPACK.shoppingCSV(Lc, { currency: 'CA$' }).indexOf('单价（CA$）') > 0,
        '加拿大无售 ' + Lc.na + ' · 合计 ' + Lc.total.toFixed(2) + ' vs 界面 ' + totNum()
      );
      setCurrency('usd');
      await tick();

      /* 26.11 按钮：「导出 CSV」下载的就是这份 CSV（文件名带户型名）；「复制清单」写进剪贴板的就是这份文本；
         剪贴板被拒 → 弹出文本框全选（不能点了没反应） */
      const origClick = HTMLAnchorElement.prototype.click;
      let dl = null;
      HTMLAnchorElement.prototype.click = function () {
        dl = { name: this.download, href: this.href };
      };
      Q('#plCsv').click();
      HTMLAnchorElement.prototype.click = origClick;
      let dlText = '';
      if (dl) dlText = await (await fetch(dl.href)).text();
      const clip = navigator.clipboard;
      const origWrite = clip && clip.writeText;
      let copied = null;
      if (clip)
        clip.writeText = async (t) => {
          copied = t;
        };
      Q('#plCopy').click();
      for (let i = 0; i < 10 && copied === null; i++) await tick();
      if (clip)
        clip.writeText = async () => {
          throw new Error('denied');
        };
      const origExec = document.execCommand;
      document.execCommand = () => false;
      Q('#plCopy').click();
      for (let i = 0; i < 10 && getComputedStyle(Q('#shopModal')).display === 'none'; i++) await tick();
      const modalShown = getComputedStyle(Q('#shopModal')).display !== 'none';
      const ta = Q('#shopText');
      const selAll = ta.selectionStart === 0 && ta.selectionEnd === ta.value.length && ta.value.length > 20;
      document.execCommand = origExec;
      if (clip) clip.writeText = origWrite;
      Q('#shopClose').click();
      await tick();
      T(
        'pb-shop-buttons',
        !!dl &&
          /-采购清单\.csv$/.test(dl.name) &&
          dlText.replace(/^\uFEFF/, '') ===
            CATPACK.shoppingCSV(shoppingListNow(), { currency: 'US$' }).replace(/^\uFEFF/, '') &&
          typeof copied === 'string' &&
          copied.split('\n').slice(1).join('\n') ===
            CATPACK.shoppingText(shoppingListNow(), { title: '', money: (v) => fmtMoney2(v) })
              .split('\n')
              .slice(1)
              .join('\n') &&
          modalShown &&
          selAll &&
          getComputedStyle(Q('#shopModal')).display === 'none',
        '下载 ' +
          (dl ? dl.name : '没触发') +
          ' · 内容一致=' +
          (dlText.replace(/^\uFEFF/, '') ===
            CATPACK.shoppingCSV(shoppingListNow(), { currency: 'US$' }).replace(/^\uFEFF/, '')) +
          ' · 复制 ' +
          (copied ? copied.split('\n').length + ' 行' : '没写') +
          ' · 剪贴板被拒 → 文本框=' +
          modalShown +
          ' 全选=' +
          selAll
      );

      /* 26.12 多层：清单按楼层分组（文本里【一层】/【二层】）；多选不跨楼层（切层后选择集塌掉） */
      selSetMany([uA, uB], uA);
      const up = addLevelUI('above');
      await tick();
      addItem('knapper');
      await tick();
      const Lm = shoppingListNow();
      const tm = CATPACK.shoppingText(Lm, { title: 'T', money: (v) => fmtMoney2(v) });
      const lvNames = LV.sortedLevels(DOC).map((l) => l.name);
      T(
        'pb-shop-levels',
        !!up &&
          Lm.levels === 2 &&
          tm.indexOf('【' + lvNames[0] + '】') > 0 &&
          tm.indexOf('【' + lvNames[1] + '】') > tm.indexOf('【' + lvNames[0] + '】') &&
          Lm.rows.filter((r) => r.level === lvNames[1]).length === 1 &&
          selUids().length === 1,
        '楼层 ' + lvNames.join(' / ') + ' · 行数 ' + Lm.rows.length + ' · 切层后选择集 ' + selUids().length + ' 件'
      );

      /* 收尾：删掉这份户型 */
      await enterEdit();
      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      T(
        'pb-ms-clean-exit',
        PLAN_ID !== p26Plan && PLAN_REG.plans.length === p26Plans,
        'plans ' + p26Plans + '→' + PLAN_REG.plans.length
      );
    }

    /* ===== 27. S21 窗帘 + 墙色：房间工具里选墙色 / 给这间房的窗配窗帘；窗工具条里逐扇改；2D 符号；3D 刷墙（窗洞 / 门洞留白）与窗帘 ===== */
    {
      /* gap 审计 G14 / G15。独立量：从房间中心朝四面墙打射线 —— 实墙那面、窗台以下、门头以上打到「漆」；
         窗玻璃高度、门洞中段打不到漆（打到的是玻璃 / 穿过去）；窗帘挂在房间这一侧（中点在房间轮廓里）、离地 ≈1cm 到帘杆。 */
      await enterEdit();
      await pbReset();
      const p27Plans = PLAN_REG.plans.length;
      Q('#btnPlanNew').click();
      await tick();
      const p27Plan = PLAN_ID;
      const fp27 = floorPts();
      const X =
          Math.min.apply(
            null,
            fp27.map((p) => p[0])
          ) + 1,
        Y =
          Math.min.apply(
            null,
            fp27.map((p) => p[1])
          ) + 1;
      const RW = 16,
        RH = 12,
        wd15 = cmToWd(15);
      pushUserWall(X, Y, X + 4, Y, 'w', wd15);
      const win27 = pushUserWindow(X + 4, Y, X + 9, Y, wd15);
      pushUserWall(X + 9, Y, X + RW, Y, 'w', wd15);
      pushUserWall(X + RW, Y, X + RW, Y + 4, 'w', wd15);
      pushUserWall(X + RW, Y + 4, X + RW, Y + 7, 'd', wd15);
      pushUserDoor(X + RW, Y + 4, X + RW, Y + 7);
      pushUserWall(X + RW, Y + 7, X + RW, Y + RH, 'w', wd15);
      pushUserWall(X + RW, Y + RH, X, Y + RH, 'w', wd15);
      pushUserWall(X, Y + RH, X, Y, 'w', wd15);
      geoChanged();
      fit2DToContent();
      await tick();
      const winE = () => DOC.windows.find((w) => w.id === win27.id) || DOC.windows[0];
      const r27 = pickRoomAt(X + 8, Y + 6);
      await tick();
      const room = () => effRooms().find((r) => r.id === r27.id);

      /* 27.1 房间工具条：墙色 / 窗帘两个控件在；选「鼠尾草绿」→ wallColor 写进去、一步撤销；重选同一个不占步；这间房认出 1 扇窗 */
      // QA Q09：墙色 / 窗帘只在「装修」里（改户型选中房间只管名称和范围）—— 到装修里看，再回来（选中的房间两边都保留）
      enterArea('deco');
      await tick();
      const shown =
        getComputedStyle(Q('#rmWallL')).display !== 'none' && getComputedStyle(Q('#rmCurtainL')).display !== 'none';
      const wins = roomWindows(room());
      const r1 = undoRing.length;
      Q('#rmWall').value = '#b9c2b2';
      Q('#rmWall').dispatchEvent(new Event('change'));
      await tick();
      const step1 = undoRing.length - r1;
      Q('#rmWall').dispatchEvent(new Event('change'));
      await tick();
      T(
        'pb-wc-room-paint-set',
        !!r27 &&
          shown &&
          wins.length === 1 &&
          wins[0].win.id === winE().id &&
          room().wallColor === '#b9c2b2' &&
          step1 === 1 &&
          undoRing.length - r1 === 1 &&
          /鼠尾草绿/.test(Q('#wMsg').textContent),
        '控件在=' +
          shown +
          ' · 认出窗 ' +
          wins.length +
          ' 扇 · wallColor=' +
          room().wallColor +
          ' · 撤销环 +' +
          step1 +
          '（重选同色后仍 +' +
          (undoRing.length - r1) +
          '）'
      );

      /* 27.2 窗帘：这间房「落地帘」+ 深灰蓝 → 窗的 curtain = {drape, #3b4250, side 朝房间}；一步撤销；2D 两道波浪线在房间那一侧 */
      Q('#rmCurtainC').value = '#3b4250';
      const r2 = undoRing.length;
      Q('#rmCurtain').value = 'drape';
      Q('#rmCurtain').dispatchEvent(new Event('change'));
      await tick();
      const cw = winE().curtain || {};
      const syms = [...pbSvg.querySelectorAll('.curtainSym[data-win="' + winE().id + '"]')];
      const symY = syms.length
        ? syms.every((pl) =>
            pl
              .getAttribute('points')
              .split(' ')
              .every((q) => +q.split(',')[1] / S > Y)
          )
        : false;
      T(
        'pb-wc-room-curtain-set',
        cw.style === 'drape' &&
          cw.color === '#3b4250' &&
          (cw.side === 1 || cw.side === -1) &&
          undoRing.length === r2 + 1 &&
          syms.length === 2 &&
          symY,
        'curtain=' +
          JSON.stringify(cw) +
          ' · 撤销环 +' +
          (undoRing.length - r2) +
          ' · 2D 符号 ' +
          syms.length +
          ' 道、全在房间那一侧（窗在上墙、房间在下）=' +
          symY
      );

      /* 27.3 3D：从房间中心朝四面打射线（独立量：射线 + 材质身上的标记，不读实现的段表） */
      if (wallEdit.on) {
        setWallEdit(false); // 现在在「装修」里（27.1），点「改户型」是切过去而不是退出
        await tick();
      }
      setView('3d');
      await tick();
      await tick();
      for (let i = 0; i < 20 && geoDirty3D; i++) await tick();
      three.staticGroup.updateMatrixWorld(true);
      const rc = new THREE.Raycaster();
      const firstHit = (ox, oy, oz, dx, dz) => {
        rc.set(new THREE.Vector3(ox, oy, oz), new THREE.Vector3(dx, 0, dz).normalize());
        rc.far = 30;
        const hits = rc.intersectObject(three.staticGroup, true).filter((h) => h.object.visible);
        return hits[0] || null;
      };
      const isPaint = (h) => !!(h && h.object.material && h.object.material.userData.roomPaint === r27.id);
      const cx = X + RW / 2,
        cy = Y + RH / 2;
      const hLeft = firstHit(cx, 4, cy, -1, 0); // 实墙
      const hWinSill = firstHit(X + 6.5, 1.2, cy, 0, -1); // 窗台以下（窗台 2.2ft）
      const hWinGlass = firstHit(X + 6.5, 4.5, cy, 0, -1); // 窗玻璃高度
      const hWinHead = firstHit(X + 6.5, 7.9, cy, 0, -1); // 过梁以上（窗头 7.38ft）
      const hDoorMid = firstHit(cx, 3, Y + 5.5, 1, 0); // 门洞中段
      const hDoorHead = firstHit(cx, 7.5, Y + 5.5, 1, 0); // 门头以上（6.8ft）
      const paintCol = hLeft && hLeft.object.material.color;
      const want = new THREE.Color('#b9c2b2').convertSRGBToLinear();
      T(
        'pb-wc-paint-3d',
        isPaint(hLeft) &&
          isPaint(hWinSill) &&
          !isPaint(hWinGlass) &&
          isPaint(hWinHead) &&
          !isPaint(hDoorMid) &&
          isPaint(hDoorHead) &&
          !!paintCol &&
          Math.abs(paintCol.r - want.r) < 1e-3 &&
          Math.abs(paintCol.g - want.g) < 1e-3,
        '实墙=' +
          isPaint(hLeft) +
          ' · 窗台下=' +
          isPaint(hWinSill) +
          ' · 玻璃高度（不该刷）=' +
          isPaint(hWinGlass) +
          ' · 过梁上=' +
          isPaint(hWinHead) +
          ' · 门洞中段（不该刷）=' +
          isPaint(hDoorMid) +
          ' · 门头上=' +
          isPaint(hDoorHead)
      );
      const curtMeshes = [];
      three.staticGroup.traverse((o) => {
        if (o.isMesh && o.material && o.material.userData && o.material.userData.curtain === 'drape')
          curtMeshes.push(o);
      });
      const cb = new THREE.Box3();
      for (const m of curtMeshes) cb.expandByObject(m);
      const cc = new THREE.Vector3();
      cb.getCenter(cc);
      T(
        'pb-wc-curtain-3d',
        curtMeshes.length >= 1 &&
          cb.min.y < 0.1 &&
          cb.max.y > winE().head &&
          cb.max.y < CEIL_H &&
          cc.z > Y &&
          cc.z < Y + 1.2 &&
          cb.min.x < X + 4 &&
          cb.max.x > X + 9,
        '帘 mesh ' +
          curtMeshes.length +
          ' · 高 ' +
          cb.min.y.toFixed(2) +
          '→' +
          cb.max.y.toFixed(2) +
          'ft（窗头 ' +
          winE().head.toFixed(2) +
          ' / 层高 ' +
          CEIL_H.toFixed(2) +
          '）· 离墙中线 ' +
          (cc.z - Y).toFixed(2) +
          'ft（房间一侧）· 横向 ' +
          cb.min.x.toFixed(1) +
          '→' +
          cb.max.x.toFixed(1)
      );
      // 从房间往窗看（窗玻璃高度）：先打到的是窗帘？落地帘收在两侧，窗中间是空的 —— 打到的应是玻璃不是帘
      const hMidWin = firstHit(X + 6.5, 4.5, cy, 0, -1);
      const hSideWin = firstHit(X + 4.2, 4.5, cy, 0, -1);
      const isCurt = (h) =>
        !!(h && h.object.material && h.object.material.userData && h.object.material.userData.curtain);
      T(
        'pb-wc-curtain-open-sides',
        !isCurt(hMidWin) && isCurt(hSideWin),
        '窗中间打到窗帘=' + isCurt(hMidWin) + ' · 靠窗边打到窗帘=' + isCurt(hSideWin)
      );
      setView('2d');
      await tick();

      /* 27.4 窗工具条逐扇改：选中这扇窗 → 「窗帘：落地帘」→ 点一下 = 纱帘（一步撤销）→ 再点三下 = 落地帘+纱帘 → 卷帘 → 无；
         换一侧 = side 取反；颜色框改色一步撤销 */
      await enterEdit();
      wallEdit.sel = { kind: 'w', id: winE().id };
      drawWallEdit();
      updateWallBarFromSel();
      await tick();
      const t0 = Q('#wWinCurtain').textContent;
      const r4 = undoRing.length;
      Q('#wWinCurtain').click();
      await tick();
      const s1 = winE().curtain && winE().curtain.style,
        st1 = undoRing.length - r4;
      const side0 = winE().curtain.side;
      Q('#wWinCurtainSide').click();
      await tick();
      const flipped = winE().curtain.side === -side0;
      Q('#wWinCurtainC').value = '#a8786a';
      Q('#wWinCurtainC').dispatchEvent(new Event('change'));
      await tick();
      const recol = winE().curtain.color === '#a8786a';
      Q('#wWinCurtain').click();
      await tick();
      const s2 = winE().curtain.style;
      Q('#wWinCurtain').click();
      await tick();
      const s3 = winE().curtain.style;
      Q('#wWinCurtain').click();
      await tick();
      const none = !winE().curtain && Q('#wWinCurtain').textContent === '窗帘：无';
      T(
        'pb-wc-window-cycle',
        t0 === '窗帘：落地帘' &&
          s1 === 'sheer' &&
          st1 === 1 &&
          flipped &&
          recol &&
          s2 === 'drapeSheer' &&
          s3 === 'roller' &&
          none,
        '「' +
          t0 +
          '」→ ' +
          s1 +
          '（+' +
          st1 +
          ' 步）→ 换侧=' +
          flipped +
          ' · 改色=' +
          recol +
          ' → ' +
          s2 +
          ' → ' +
          s3 +
          ' → 无=' +
          none
      );

      /* 27.5 撤销回到「落地帘 + 墙色」那一步；导出再导入：窗帘与墙色原样带过去、过校验 */
      for (let i = 0; i < 6; i++) undoStep();
      await tick();
      const backOk = winE().curtain && winE().curtain.style === 'drape' && room().wallColor === '#b9c2b2';
      const json = exportDocJSON();
      const imp = importDocFromJSON(json);
      const iw = imp.doc && imp.doc.windows.find((w) => w.curtain);
      const ir = imp.doc && imp.doc.rooms.find((r) => r.wallColor);
      T(
        'pb-wc-undo-export',
        backOk && imp.errs.length === 0 && !!iw && iw.curtain.color === '#3b4250' && !!ir && ir.wallColor === '#b9c2b2',
        '撤销 6 步回到落地帘 + 墙色=' +
          !!backOk +
          ' · 导入校验错 ' +
          imp.errs.length +
          ' · 窗帘 ' +
          (iw ? JSON.stringify(iw.curtain) : '丢了') +
          ' · 墙色 ' +
          (ir ? ir.wallColor : '丢了')
      );

      /* 27.6 墙色「白墙（缺省）」= 删掉字段；房间的窗帘「不挂」= 去掉这间房所有窗的窗帘 */
      wallEdit.sel = { kind: 'room', id: r27.id };
      updateWallBarFromSel();
      Q('#rmWall').value = '';
      Q('#rmWall').dispatchEvent(new Event('change'));
      Q('#rmCurtain').value = 'none';
      Q('#rmCurtain').dispatchEvent(new Event('change'));
      await tick();
      T(
        'pb-wc-clear',
        !('wallColor' in room()) && !winE().curtain && !pbSvg.querySelector('.curtainSym'),
        'wallColor 字段还在=' + ('wallColor' in room()) + ' · 窗帘还在=' + !!winE().curtain
      );

      /* 收尾：删掉这份户型 */
      await enterEdit();
      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      T(
        'pb-wc-clean-exit',
        PLAN_ID !== p27Plan && PLAN_REG.plans.length === p27Plans,
        'plans ' + p27Plans + '→' + PLAN_REG.plans.length
      );
    }

    /* ===== 28. S17b 矢量图纸导入为一层（确认框「放到哪」）+ 楼层条 ⚙「移动这一层」 ===== */
    {
      /* 独立量：新层的包围盒中心 = 一层地板轮廓的中心（自己按墙算）；整层拖完每面墙 / 窗 / 房间 / 家具的位移都等于拖的距离、
         别的层一个坐标不动；拖一次 / 连按方向键各一步撤销。 */
      await enterEdit();
      await pbReset();
      const p28Plans = PLAN_REG.plans.length;
      Q('#btnPlanNew').click();
      await tick();
      const p28Plan = PLAN_ID;
      const fp28 = floorPts();
      const X =
          Math.min.apply(
            null,
            fp28.map((p) => p[0])
          ) + 1,
        Y =
          Math.min.apply(
            null,
            fp28.map((p) => p[1])
          ) + 1;
      const wd = cmToWd(15);
      pushUserWall(X, Y, X + 16, Y, 'w', wd);
      pushUserWall(X + 16, Y, X + 16, Y + 12, 'w', wd);
      pushUserWall(X + 16, Y + 12, X, Y + 12, 'w', wd);
      pushUserWall(X, Y + 12, X, Y, 'w', wd);
      geoChanged();
      fit2DToContent();
      await tick();
      if (wallEdit.on) {
        Q('#btnWallEdit').click();
        await tick();
      }
      const lv1Walls = JSON.stringify(DOC.walls);
      // 「导入」的那张图：10×8 的一圈墙 + 一扇窗 + 一个房间标签，坐标离这份户型很远（图纸原点不同）
      const sg = (x1, y1, x2, y2) => ({ t: 'seg', x1, y1, x2, y2 });
      const src = SCHEMA.Project.blankDoc('二层.dxf');
      src.walls = [
        { id: 'w01', kind: 'wall', geom: sg(100, 100, 110, 100), thick: 0.5 },
        { id: 'w02', kind: 'wall', geom: sg(110, 100, 110, 108), thick: 0.5 },
        { id: 'w03', kind: 'wall', geom: sg(110, 108, 100, 108), thick: 0.5 },
        { id: 'w04', kind: 'wall', geom: sg(100, 108, 100, 100), thick: 0.5 },
      ];
      src.windows = [
        {
          id: 'n01',
          geom: sg(103, 100, 107, 100),
          wallId: null,
          pos: 0.5,
          width: 4,
          sill: 2.2,
          head: 7.4,
          style: 'fixed',
          frame: '#1c2528',
          glass: 0.18,
          thick: 0.5,
        },
      ];
      src.rooms = [{ id: 'r01', label: '主卧', pos: [105, 104] }];

      /* 28.1 确认框：自包含户型里有「放到哪」，选「往上加一层」后说明与按钮文字跟着变 */
      vecDestPrep('dxf');
      const rowShown = getComputedStyle(Q('#dxfDestRow')).display !== 'none';
      Q('#dxfInfo').innerHTML = '<div class="dxfNote">x</div>';
      Q('#dxfDest').value = 'above';
      Q('#dxfDest').dispatchEvent(new Event('change'));
      const noteLv = Q('#dxfInfo .dxfNote').textContent,
        btnLv = Q('#dxfOk').textContent;
      Q('#dxfDest').value = 'new';
      Q('#dxfDest').dispatchEvent(new Event('change'));
      T(
        'pb-vl-dialog-dest',
        rowShown &&
          /新的一层/.test(noteLv) &&
          btnLv === '导入为新的一层' &&
          Q('#dxfOk').textContent === '导入（新建一份户型）',
        '「放到哪」在=' + rowShown + ' · 选新楼层后按钮「' + btnLv + '」· 说明「' + noteLv.slice(0, 24) + '…」'
      );

      /* 28.2 导入为一层：多一层、切过去、内容摆到地板中央、一层不动、整份文档过校验、一步撤销 */
      const r2 = undoRing.length;
      const lv = vectorToLevel(src, 'above');
      await tick();
      const bb = LV.levelBBox(DOC);
      const fpc = [X + 8, Y + 6]; // 一层那一圈墙的中心（自己按画的墙算）
      const lv1Now = JSON.stringify(LV.levelContentOf(DOC, 'lv1').walls);
      T(
        'pb-vl-import-as-level',
        !!lv &&
          hasLevelsNow() &&
          DOC.levels.length === 2 &&
          DOC.level === lv.id &&
          DOC.walls.length === 4 &&
          DOC.windows.length === 1 &&
          !!bb &&
          Math.abs((bb.x0 + bb.x1) / 2 - fpc[0]) < 0.05 &&
          Math.abs((bb.y0 + bb.y1) / 2 - fpc[1]) < 0.05 &&
          lv1Now === lv1Walls &&
          SCHEMA.Project.validate(DOC).length === 0 &&
          undoRing.length === r2 + 1,
        '楼层 ' +
          (DOC.levels || []).length +
          ' · 当前 ' +
          DOC.level +
          ' · 新层中心 (' +
          (bb ? [((bb.x0 + bb.x1) / 2).toFixed(2), ((bb.y0 + bb.y1) / 2).toFixed(2)] : '?') +
          ') vs 一层中心 (' +
          fpc.map((v) => v.toFixed(2)) +
          ') · 一层没动=' +
          (lv1Now === lv1Walls) +
          ' · 撤销环 +' +
          (undoRing.length - r2)
      );
      undoStep();
      await tick();
      const undone = !hasLevelsNow() && JSON.stringify(DOC.walls) === lv1Walls;
      redoStep();
      await tick();
      T(
        'pb-vl-undo-redo',
        undone && hasLevelsNow() && DOC.walls.length === 4,
        '撤销回单层=' + undone + ' · 重做又回来=' + hasLevelsNow()
      );

      /* 28.3 只收单层图纸：自带楼层的文件被拒、户型与撤销环都不动 */
      const multi = SCHEMA.Project.blankDoc('多层');
      LV.enableLevels(multi);
      LV.addLevel(multi, { where: 'above' });
      const n3 = DOC.levels.length,
        r3 = undoRing.length;
      const rej = vectorToLevel(multi, 'above');
      T(
        'pb-vl-reject-multi',
        rej === null && DOC.levels.length === n3 && undoRing.length === r3,
        '返回 ' + rej + ' · 楼层 ' + DOC.levels.length + ' · 撤销环 +' + (undoRing.length - r3)
      );

      /* 28.4 移动这一层：⚙ 面板里有按钮（多层时）→ 拖平面图 = 这一层整体平移（墙 / 窗 / 房间 / 这一层的家具一起），一层不动；
         3px 手抖不算；一次拖动一步撤销 */
      addItem('knapper');
      await tick();
      const it28 = state.items[state.items.length - 1];
      const shot = () => ({
        w: DOC.walls.map((w) => [w.geom.x1, w.geom.y1]),
        n: [DOC.windows[0].geom.x1, DOC.windows[0].geom.y1],
        r: DOC.rooms[0].pos.slice(),
        it: [state.items.find((i) => i.uid === it28.uid).x, state.items.find((i) => i.uid === it28.uid).y],
      });
      Q('#lvMore').click();
      await tick();
      const btnShown = getComputedStyle(Q('#lvMove')).display !== 'none';
      Q('#lvMove').click();
      await tick();
      const on = !!lvMove && Q('#lvMove').textContent === '完成移动';
      const s0 = shot(),
        r4 = undoRing.length;
      const [ax, ay] = SPT(X + 11, Y + 8); // 别从左上角起拖：楼层条与打开的 ⚙ 面板盖在那儿
      fire('pointerdown', ax, ay);
      await tick();
      fire('pointermove', ax + 3, ay);
      await tick();
      const jitter = JSON.stringify(shot()) === JSON.stringify(s0);
      fire('pointermove', ax + 30, ay + 10);
      await tick();
      fire('pointermove', ax + 60, ay + 24);
      await tick();
      fire('pointerup', ax + 60, ay + 24, { buttons: 0 });
      await tick();
      const s1 = shot(),
        ppf = pxPerFtNow();
      const want = [60 / ppf, 24 / ppf];
      const near = (a, b) => Math.abs(a - b) < 0.02;
      const allMoved =
        s1.w.every((p, k) => near(p[0] - s0.w[k][0], want[0]) && near(p[1] - s0.w[k][1], want[1])) &&
        near(s1.n[0] - s0.n[0], want[0]) &&
        near(s1.r[1] - s0.r[1], want[1]) &&
        near(s1.it[0] - s0.it[0], want[0]);
      T(
        'pb-vl-move-level-drag',
        btnShown &&
          on &&
          jitter &&
          allMoved &&
          JSON.stringify(LV.levelContentOf(DOC, 'lv1').walls) === lv1Walls &&
          undoRing.length === r4 + 1,
        '按钮在=' +
          btnShown +
          ' · 进模式=' +
          on +
          ' · 3px 不动=' +
          jitter +
          ' · 墙 / 窗 / 房间 / 家具同位移 (' +
          want.map((v) => v.toFixed(2)) +
          'ft)=' +
          allMoved +
          ' · 一层没动=' +
          (JSON.stringify(LV.levelContentOf(DOC, 'lv1').walls) === lv1Walls) +
          ' · 撤销环 +' +
          (undoRing.length - r4)
      );

      /* 28.5 方向键：→ 三下 = +3cm（一步撤销）、Shift+↓ = +10cm；Esc 完成（按钮回原样） */
      const s2 = shot(),
        r5 = undoRing.length;
      key('ArrowRight');
      key('ArrowRight');
      key('ArrowRight');
      await tick();
      const s3 = shot();
      const three1 = near(s3.w[0][0] - s2.w[0][0], 3 / 30.48) && undoRing.length === r5 + 1;
      key('ArrowDown', document.body, true);
      await tick();
      const s4 = shot();
      const shiftDown = near(s4.w[0][1] - s3.w[0][1], 10 / 30.48);
      key('Escape');
      await tick();
      T(
        'pb-vl-move-level-keys',
        three1 && shiftDown && !lvMove && Q('#lvMove').textContent === '移动这一层',
        '→×3 = +' +
          ((s3.w[0][0] - s2.w[0][0]) * 30.48).toFixed(1) +
          'cm（一步撤销=' +
          (undoRing.length >= r5 + 1) +
          '）· Shift+↓ = +' +
          ((s4.w[0][1] - s3.w[0][1]) * 30.48).toFixed(1) +
          'cm · Esc 退出=' +
          !lvMove
      );

      /* 收尾：删掉这份户型 */
      await enterEdit();
      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      T(
        'pb-vl-clean-exit',
        PLAN_ID !== p28Plan && PLAN_REG.plans.length === p28Plans,
        'plans ' + p28Plans + '→' + PLAN_REG.plans.length
      );
    }

    /* ===== 29. bug 猎 ㉛：S17–S21 的新字段 × 已有的复制 / 搬移 / 改层高路径 ===== */
    {
      await enterEdit();
      await pbReset();
      const p29Plans = PLAN_REG.plans.length;
      Q('#btnPlanNew').click();
      await tick();
      const p29Plan = PLAN_ID;
      const fp29 = floorPts();
      const X =
          Math.min.apply(
            null,
            fp29.map((p) => p[0])
          ) + 1,
        Y =
          Math.min.apply(
            null,
            fp29.map((p) => p[1])
          ) + 1;
      const wd = cmToWd(15);
      pushUserWall(X, Y, X + 4, Y, 'w', wd);
      const win29 = pushUserWindow(X + 4, Y, X + 9, Y, wd);
      pushUserWall(X + 9, Y, X + 16, Y, 'w', wd);
      pushUserWall(X + 16, Y, X + 16, Y + 12, 'w', wd);
      pushUserWall(X + 16, Y + 12, X, Y + 12, 'w', wd);
      pushUserWall(X, Y + 12, X, Y, 'w', wd);
      win29.curtain = { style: 'drape', color: '#3b4250' };
      geoChanged();
      fit2DToContent();
      await tick();
      if (wallEdit.on) {
        Q('#btnWallEdit').click();
        await tick();
      }

      /* 29.1 #70「＋ 加一层」带上外墙与窗时，窗帘（这一层房间的软装）不跟着复制上去：新楼层的窗是光的 */
      Q('#lvCopyShell').checked = true;
      const up = addLevelUI('above');
      await tick();
      const upWins = DOC.windows || [];
      T(
        'pb-hunt31-shell-no-curtain',
        !!up && upWins.length === 1 && !upWins[0].curtain && !!LV.levelContentOf(DOC, 'lv1').windows[0].curtain,
        '新楼层的窗 ' +
          upWins.length +
          ' 扇 · 带着窗帘=' +
          !!(upWins[0] && upWins[0].curtain) +
          ' · 一层的窗帘还在=' +
          !!LV.levelContentOf(DOC, 'lv1').windows[0].curtain
      );

      /* 29.2 #71 层高改低以后：顶到天花的件（离地 + 件高 > 层高）要标红并说清原因；没顶到的对照组不标 */
      const mkC = (name, w, d, h, x, y, zCm) => {
        const uid = uidSeq++;
        const it = { uid, custom: { name, w, d, h, color: '#5a5f66' }, x, y, rot: 0, lv: DOC.level };
        if (zCm) it.z = zCm / 30.48;
        state.items.push(it);
        return uid;
      };
      const uShelf = mkC('测试吊柜', 120, 40, 80, X + 4, Y + 3, 150); // 顶 230cm
      const uWard = mkC('测试高柜', 100, 60, 240, X + 12, Y + 6, 0); // 顶 240cm
      const uLow = mkC('测试矮柜', 100, 40, 80, X + 6, Y + 9, 0); // 顶 80cm（对照组）
      drawFurniture();
      await tick();
      const ok0 = ![uShelf, uWard, uLow].some((u) => (furnWhy.get(u) || []).includes('tooTall'));
      setLevelCeilUI(220);
      await tick();
      const ceilToast = (Q('#toast') || {}).textContent || '';
      const why = (u) => furnWhy.get(u) || [];
      const gShelf = pbSvg.querySelector('g.furn[data-uid="' + uShelf + '"]');
      T(
        'pb-hunt31-ceiling-too-tall-flagged',
        ok0 &&
          why(uShelf).includes('tooTall') &&
          why(uWard).includes('tooTall') &&
          !why(uLow).includes('tooTall') &&
          !!gShelf &&
          gShelf.classList.contains('tooTall') &&
          /天花/.test((gShelf.querySelector('title') || {}).textContent || '') &&
          /2 件.*顶到天花/.test(ceilToast),
        '改层高前都不标=' +
          ok0 +
          ' · 提示「' +
          ceilToast +
          '」' +
          ' · 层高 220cm 后：吊柜（顶 230）' +
          JSON.stringify(why(uShelf)) +
          ' · 高柜（顶 240）' +
          JSON.stringify(why(uWard)) +
          ' · 矮柜' +
          JSON.stringify(why(uLow))
      );
      setLevelCeilUI(268);
      state.items = state.items.filter((i) => ![uShelf, uWard, uLow].includes(i.uid));
      drawFurniture();

      /* 29.3 #72「移动这一层」：量尺寸标注跨的是这一层的几何，要跟着一起搬（与整图缩放 #48 同一条规则） */
      meas.list = [
        [
          [X + 1, Y + 1],
          [X + 6, Y + 1],
        ],
      ];
      const m0 = JSON.stringify(meas.list);
      setLvMove(true);
      key('ArrowRight', document.body, true); // Shift+→ = 10cm
      await tick();
      const dx = 10 / 30.48;
      const m1 = meas.list[0];
      T(
        'pb-hunt31-lvmove-moves-measurements',
        Math.abs(m1[0][0] - (X + 1 + dx)) < 1e-3 &&
          Math.abs(m1[1][0] - (X + 6 + dx)) < 1e-3 &&
          Math.abs(m1[0][1] - (Y + 1)) < 1e-6,
        '标注 ' + m0 + ' → ' + JSON.stringify(meas.list) + '（墙挪了 +' + (dx * 30.48).toFixed(0) + 'cm）'
      );

      /* 29.4 #73「移动这一层」不能把底图的特征线弄没：特征线存的是图片像素坐标、跟着底图的偏移走，搬一次不需要重算 */
      const cv29 = document.createElement('canvas');
      cv29.width = 100;
      cv29.height = 100;
      cv29.getContext('2d').fillRect(10, 10, 50, 4);
      DOC.baseImage = { data: cv29.toDataURL('image/png'), w: 100, h: 100, mPerPx: 0.05, ox: X, oy: Y };
      _traceCache = { key: DOC.baseImage.data, segs: [{ a: { x: 10, y: 10 }, b: { x: 60, y: 10 } }] };
      showTrace = true;
      const t0 = traceSegsDoc();
      key('ArrowDown', document.body, true); // Shift+↓ = 10cm
      await tick();
      const t1 = traceSegsDoc();
      T(
        'pb-hunt31-lvmove-keeps-trace',
        !!t0 &&
          !!t1 &&
          Math.abs(t1[0].a[1] - t0[0].a[1] - 10 / 30.48) < 1e-3 &&
          Math.abs(t1[0].a[0] - t0[0].a[0]) < 1e-6,
        '搬之前特征线 ' +
          (t0 ? t0.length : 0) +
          ' 条 · 搬之后 ' +
          (t1
            ? t1.length + ' 条、跟着下移 ' + ((t1[0].a[1] - t0[0].a[1]) * 30.48).toFixed(1) + 'cm'
            : '没了（缓存被清掉）')
      );

      /* 29.5（防御性统一）「移动这一层」与「移动底图」只能开一个：两个都开着时按一下方向键，底图被挪两次（底图模式一次 + 整层一次） */
      setImgMove(true);
      const exA = !!imgMove && !lvMove;
      setLvMove(true);
      const exB = !!lvMove && !imgMove;
      T(
        'pb-hunt31-move-modes-exclusive',
        exA && exB,
        '开「移动底图」后「移动这一层」关了=' + exA + ' · 再开「移动这一层」后「移动底图」关了=' + exB
      );
      setLvMove(false);
      if (imgMove) setImgMove(false);
      showTrace = false;
      _traceCache = null;
      delete DOC.baseImage;
      meas.list = [];

      /* 收尾：删掉这份户型 */
      await enterEdit();
      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      T(
        'pb-hunt31-clean-exit',
        PLAN_ID !== p29Plan && PLAN_REG.plans.length === p29Plans,
        'plans ' + p29Plans + '→' + PLAN_REG.plans.length
      );
    }

    /* ===== 30. bug 猎 ㉝：2D 的点选 / 拖动 × 目录里没有了的件（幽灵件） ===== */
    {
      await pbReset();
      if (wallEdit.on) {
        Q('#btnWallEdit').click();
        await tick();
      }
      fit2DToContent();
      await tick();
      const [gx, gy] = pbFree;
      const uG = uidSeq++;
      const keep30 = state.items; // 这一节只摆这一件：别让前面几节留下的家具盖在落点上
      state.items = [{ uid: uG, ref: 'pb-hunt33-no-such-item', x: gx, y: gy, rot: 0 }];
      selOnly(null);
      drawFurniture();
      await tick();

      /* 30.1 #75 幽灵件（目录条目被移除 / 旧布局引用了下架的条目）在 2D 里点得中：
         代码注释与 3D 都承诺「还能看见、能选、能删」，2D 的占位符号却不接点击（点上去 = 平移画布 + 取消选择） */
      await tap(gx, gy);
      const picked = selected === uG;
      const title = Q('#pTitle').textContent;
      T(
        'pb-hunt33-ghost-click-selects',
        picked && /目录里没有这件/.test(title),
        '点占位符号后选中=' + picked + '（selected=' + selected + '）· 面板「' + title + '」'
      );

      /* 30.2 #75 拖得动、一步撤销（没有尺寸的件不做贴墙吸附，不报错）。撤销环可能已经满了（50 步）：
         「压了一步」按栈顶换没换判，「只一步」按撤销一次就回到原位判 */
      const top0 = undoRing[undoRing.length - 1];
      const [sx, sy] = SPT(gx, gy);
      fire('pointerdown', sx, sy);
      await tick();
      fire('pointermove', sx + 20, sy);
      await tick();
      fire('pointermove', sx + 44, sy + 10);
      await tick();
      fire('pointerup', sx + 44, sy + 10, { buttons: 0 });
      await tick();
      const itG = state.items.find((i) => i.uid === uG);
      const want = 44 / pxPerFtNow(),
        moved = itG ? itG.x - gx : NaN;
      const pushed = undoRing[undoRing.length - 1] !== top0;
      if (pushed) {
        undoStep(); // 没压步就别撤：撤掉的会是前面几节的某一步
        await tick();
      }
      const back = state.items.find((i) => i.uid === uG);
      const oneStep = pushed && !!back && Math.abs(back.x - gx) < 1e-6;
      T(
        'pb-hunt33-ghost-drag-moves',
        Math.abs(moved - want) < 0.08 && pushed && oneStep,
        '拖 44px（≈' +
          want.toFixed(2) +
          'ft）→ 挪了 ' +
          moved.toFixed(2) +
          'ft · 进撤销环=' +
          pushed +
          ' · 撤销一次回到原位=' +
          oneStep
      );
      state.items = keep30;
      selOnly(null);
      drawFurniture();
    }

    /* ===== 31. bug 猎 ㉞：镜子的实景反射 × 楼层显隐 / 数量上限 =====
       镜子在光栅视图里靠「镜面前烘一张立方体贴图」反射房间（S6 / S19b）。判据（与实现无关）：
       每面看得见的镜子，贴图都要是「按现在这份可见性烘出来的那张」——拿它与当场重烘一张比；
       一张都没有 = 退回环境全景（窗外城市），那正是 S19b 修过的那个 bug。 */
    {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await enterEdit();
      await pbReset();
      const p31Plans = PLAN_REG.plans.length;
      Q('#btnPlanNew').click();
      await tick();
      const p31Plan = PLAN_ID;
      const fp31 = floorPts();
      const X =
          Math.min.apply(
            null,
            fp31.map((p) => p[0])
          ) + 1,
        Y =
          Math.min.apply(
            null,
            fp31.map((p) => p[1])
          ) + 1;
      const wd = cmToWd(15);
      pushUserWall(X, Y, X + 16, Y, 'w', wd);
      pushUserWall(X + 16, Y, X + 16, Y + 12, 'w', wd);
      pushUserWall(X + 16, Y + 12, X, Y + 12, 'w', wd);
      pushUserWall(X, Y + 12, X, Y, 'w', wd);
      geoChanged();
      if (wallEdit.on) {
        Q('#btnWallEdit').click();
        await tick();
      }
      Q('#lvCopyShell').checked = true;
      addLevelUI('above');
      await tick();
      const lv2 = DOC.level;
      // 二层北墙上挂一面镜子（真实放置路径：贴墙吸附 → 朝向房间里）
      const sn = fixtureWallSnap(X + 8, Y + 0.6, 'mirror');
      pushUserFixture('mirror', sn ? sn.cx : X + 8, sn ? sn.cy : Y + 0.6, sn ? sn.rot : 0);
      geoChanged();
      // 回一层看 3D 娃娃屋：二层（连同它的镜子）这时是藏着的
      Q('#lvBtns button[data-lv="lv1"]').click();
      await tick();
      setView('3d');
      await wait3D(80);
      await sleep(600);
      const faceOf = (n) => (Math.abs(n[0]) > Math.abs(n[2]) ? (n[0] > 0 ? 0 : 1) : n[2] > 0 ? 4 : 5);
      const meanOf = (m) => {
        const rt = m && m.userData.mirrorEnv;
        if (!rt) return null;
        const N = rt.width,
          buf = new Uint8Array(N * N * 4);
        three.renderer.readRenderTargetPixels(rt, 0, 0, N, N, buf, faceOf(m.userData.mirrorN || [0, 0, 1]));
        let s = 0,
          k = 0;
        for (let y = N / 4; y < (3 * N) / 4; y++)
          for (let x = N / 4; x < (3 * N) / 4; x++) {
            const i = (y * N + x) * 4;
            s += 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
            k++;
          }
        return s / k;
      };

      /* 31.1 #76 切到镜子所在的那一层：它的反射要按「这一层看得见」重烘（以前它停在一层视角时烘的那张：
         二层的墙都藏着，镜子里只有背景色） */
      Q('#lvBtns button[data-lv="' + lv2 + '"]').click();
      await sleep(900);
      const mm = (three.mirrors || [])[0];
      const shownNow =
        !!mm &&
        (() => {
          for (let p = mm; p; p = p.parent) if (!p.visible) return false;
          return true;
        })();
      const lumNow = meanOf(mm);
      installMirrorProbes();
      const lumFresh = meanOf(mm);
      T(
        'pb-hunt34-mirror-rebaked-when-level-shown',
        shownNow && lumNow != null && lumFresh != null && lumFresh > 40 && Math.abs(lumNow - lumFresh) < lumFresh * 0.2,
        '镜子在显示=' +
          shownNow +
          ' · 镜面朝向那一面的平均亮度：现在 ' +
          (lumNow == null ? '无贴图' : lumNow.toFixed(1)) +
          ' / 当场重烘 ' +
          (lumFresh == null ? '无贴图' : lumFresh.toFixed(1))
      );

      /* 31.2 #77 七面落地镜（家具）+ 一面洁具镜子：每面都要有房间的反射，不能退回环境全景（窗外城市）。
         以前洁具 4 面 + 家具 2 面各自封顶 → 第三面落地镜起 envMap 是空的；现在超出烘焙预算的借最近那面烘好的 */
      const n0 = state.items.length;
      for (let k = 0; k < 7; k++)
        state.items.push({ uid: uidSeq++, ref: 'knapper', x: X + 2 + k * 2, y: Y + 9, rot: 180, lv: lv2 });
      drawFurniture();
      await sleep(1500);
      const all31 = (three.mirrors || []).concat(furnMirrorMeshes());
      const owners = all31.filter((m) => m.userData.mirrorEnv).map((m) => m.userData.mirrorEnv.texture);
      const noEnv = all31.filter((m) => !(m.material.envMap && m.material.envMap.isCubeTexture));
      const dangling = all31.filter((m) => m.material.envMap && !owners.includes(m.material.envMap));
      T(
        'pb-hunt34-every-mirror-reflects-room',
        all31.length === 8 && noEnv.length === 0 && dangling.length === 0,
        '镜子 ' +
          all31.length +
          ' 面（洁具 ' +
          (three.mirrors || []).length +
          ' + 落地镜 ' +
          furnMirrorMeshes().length +
          '）· 自己烘的 ' +
          owners.length +
          ' · 没有房间反射（退回环境全景）的 ' +
          noEnv.length +
          ' · 贴图不归任何一面镜子（已释放 / 悬空）的 ' +
          dangling.length
      );
      state.items.splice(n0);
      drawFurniture();
      setView('2d');
      await tick();

      /* 收尾：删掉这份户型 */
      await enterEdit();
      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      T(
        'pb-hunt34-clean-exit',
        PLAN_ID !== p31Plan && PLAN_REG.plans.length === p31Plans,
        'plans ' + p31Plans + '→' + PLAN_REG.plans.length
      );
    }

    /* ===== 32. bug 猎 ㉟：改层高 × 墙面点位的离地高（轮㉛ #71 的同一类：一条上限只写在点位面板一个入口上） ===== */
    {
      await enterEdit();
      await pbReset();
      const p32Plans = PLAN_REG.plans.length;
      Q('#btnPlanNew').click();
      await tick();
      const p32Plan = PLAN_ID;
      const fp32 = floorPts();
      const X =
          Math.min.apply(
            null,
            fp32.map((p) => p[0])
          ) + 1,
        Y =
          Math.min.apply(
            null,
            fp32.map((p) => p[1])
          ) + 1;
      const wd = cmToWd(15);
      const wTop = pushUserWall(X, Y, X + 16, Y, 'w', wd);
      pushUserWall(X + 16, Y, X + 16, Y + 12, 'w', wd);
      pushUserWall(X + 16, Y + 12, X, Y + 12, 'w', wd);
      pushUserWall(X, Y + 12, X, Y, 'w', wd);
      geoChanged();
      fit2DToContent();
      await tick();
      const faceTop = Y + pbDrawnThick(effWalls().find((s) => s._id === wTop.id)) / 2;
      // 北墙上：一个 30cm 的插座（对照组）+ 一个装在 250cm 的送风口（层高 268cm 时合法：点位面板的上限是 层高 − 6cm）
      const oLow = pushUserOutlet(pointSnap(X + 5, faceTop + 0.2, 'std', 'auto'), 'std', 1, null);
      const oHigh = pushUserOutlet(
        pointSnap(X + 11, faceTop + 0.2, 'supplyVent', 'wall'),
        'supplyVent',
        1,
        250 / 30.48
      );
      syncOutlets();
      geoChanged();
      if (wallEdit.on) {
        Q('#btnWallEdit').click();
        await tick();
      }
      drawFurniture();
      await tick();
      const symOf = (o) => pbSvg.querySelector('[data-outlet="' + o.id + '"].outletSym');
      const flagged = (o) => !!symOf(o) && symOf(o).classList.contains('olTooHigh');
      const pre = !!oLow && !!oHigh && Math.abs(oHigh.h * 30.48 - 250) < 1 && !flagged(oLow) && !flagged(oHigh);

      /* 32.1 #78 层高 268→220cm：250cm 的送风口高过天花（3D 里面板飘在墙顶之上）→ 标出来、悬停说清、改层高的提示说出个数；
         30cm 的插座不标 */
      setLevelCeilUI(220);
      await tick();
      const msg = (Q('#toast') || {}).textContent || '';
      const tt = symOf(oHigh) ? (symOf(oHigh).querySelector('title') || {}).textContent || '' : '';
      T(
        'pb-hunt35-points-above-ceiling-flagged',
        pre && flagged(oHigh) && !flagged(oLow) && /天花/.test(tt) && /1 个点位.*天花/.test(msg),
        '前提（两个点位都放上了、改之前都不标）=' +
          pre +
          ' · 层高 220cm 后：送风口（250cm）标了=' +
          flagged(oHigh) +
          '、插座（30cm）标了=' +
          flagged(oLow) +
          ' · 悬停「' +
          tt +
          '」· 提示「' +
          msg +
          '」'
      );
      setLevelCeilUI(268);
      await tick();
      T('pb-hunt35-flag-clears', !flagged(oHigh), '层高改回 268cm 后送风口还标着=' + flagged(oHigh));

      /* 收尾：删掉这份户型 */
      await enterEdit();
      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      T(
        'pb-hunt35-clean-exit',
        PLAN_ID !== p32Plan && PLAN_REG.plans.length === p32Plans,
        'plans ' + p32Plans + '→' + PLAN_REG.plans.length
      );
    }

    /* ===== 33. bug 猎 ㊱：房间轮廓 × 改墙（S16 的轮廓是点选那一刻按墙算出来的快照） =====
       轮廓有六个消费端：2D 地板底纹、面积、采购清单的地板用量、3D 地板、墙色（roomPaintRuns）、这间房有哪几扇窗（窗帘）。
       墙挪了轮廓不动 = 六处一起按旧墙算。判据（独立量）：面积 = 墙皮围成的净宽 × 净深。 */
    {
      await enterEdit();
      await pbReset();
      const p33Plans = PLAN_REG.plans.length;
      Q('#btnPlanNew').click();
      await tick();
      const p33Plan = PLAN_ID;
      const fp33 = floorPts();
      const X =
          Math.min.apply(
            null,
            fp33.map((p) => p[0])
          ) + 1,
        Y =
          Math.min.apply(
            null,
            fp33.map((p) => p[1])
          ) + 1;
      const AW = 12,
        BW = 7,
        RH = 10,
        wd = cmToWd(12);
      pushUserWall(X, Y, X + AW + BW, Y, 'w', wd);
      pushUserWall(X + AW + BW, Y, X + AW + BW, Y + RH, 'w', wd);
      pushUserWall(X + AW + BW, Y + RH, X, Y + RH, 'w', wd);
      const wWest = pushUserWall(X, Y + RH, X, Y, 'w', wd);
      const wMid = pushUserWall(X + AW, Y, X + AW, Y + RH, 'w', wd);
      geoChanged();
      fit2DToContent();
      drawWallEdit();
      await tick();
      const t = pbDrawnThick(effWalls().find((s) => s._id === wMid.id));
      await setTool('room');
      await tap(X + 3, Y + 3);
      const rA = (DOC.rooms || [])[(DOC.rooms || []).length - 1];
      if (rA) {
        rA.floor = { mat: 'oakHerring' };
        rA.wallColor = '#b9c2b2';
      }
      const areaOf = () => (rA ? roomArea(rA) : 0);
      const use = () => (floorUsage().get('oakHerring') || {}).area || 0;
      const a0 = areaOf(),
        want0 = (AW - t) * (RH - t);

      /* 33.1 #79 选中隔墙、Shift+→ ×6（往 B 那边挪 30cm）：A 的轮廓 / 面积 / 地板用量跟着变大 */
      await setTool('select');
      await tap(X + AW, Y + RH / 2);
      const selOk = !!wallEdit.sel && wallEdit.sel.id === wMid.id;
      for (let k = 0; k < 3; k++) key('ArrowRight', document.body, true); // 30cm（S23 起 Shift = 10cm 一步）
      await tick();
      const d = 30 / 30.48,
        want1 = (AW + d - t) * (RH - t);
      const a1 = areaOf();
      const paintAtNewFace = rA
        ? roomPaintRuns(rA).some(
            (q) => Math.abs(q.a[0] - (X + AW + d - t / 2)) < 0.05 && Math.abs(q.b[0] - (X + AW + d - t / 2)) < 0.05
          )
        : false;
      T(
        'pb-hunt36-room-follows-moved-wall',
        !!rA &&
          Math.abs(a0 - want0) / want0 < 0.01 &&
          selOk &&
          Math.abs(a1 - want1) / want1 < 0.01 &&
          Math.abs(use() - a1) < 1e-6 &&
          paintAtNewFace,
        '点选时 ' +
          a0.toFixed(2) +
          'ft²（独立量 ' +
          want0.toFixed(2) +
          '）· 选中隔墙=' +
          selOk +
          ' · 隔墙挪 30cm 后 ' +
          a1.toFixed(2) +
          'ft²（独立量 ' +
          want1.toFixed(2) +
          '）· 地板用量 ' +
          use().toFixed(2) +
          ' · 挪过去的墙皮上有漆=' +
          paintAtNewFace
      );

      /* 33.2 撤销：墙与轮廓一起回去（一步） */
      undoStep();
      await tick();
      const rA2 = (DOC.rooms || []).find((r) => rA && r.id === rA.id);
      T(
        'pb-hunt36-room-undo-with-wall',
        !!rA2 && Math.abs(roomArea(rA2) - a0) < 1e-6,
        '撤销一步后面积 ' + (rA2 ? roomArea(rA2).toFixed(2) : '?') + 'ft²（挪之前 ' + a0.toFixed(2) + '）'
      );

      /* 33.3 对照：两间都点过（都有轮廓）之后拆掉它们之间的隔墙 → 一块被两间同时认领 → 两间都留着原来的轮廓 */
      await setTool('room');
      await tap(X + AW + 3, Y + 5);
      const rB = (DOC.rooms || []).find((r) => rA && r.id !== rA.id && r.poly);
      const keepA = rA2 ? JSON.stringify(rA2.poly) : '',
        keepB = rB ? JSON.stringify(rB.poly) : '';
      const midSaved = DOC.walls.find((w) => w.id === wMid.id);
      DOC.walls = DOC.walls.filter((w) => w.id !== wMid.id);
      geoChanged();
      await tick();
      const nowA = (DOC.rooms || []).find((r) => rA && r.id === rA.id),
        nowB = (DOC.rooms || []).find((r) => rB && r.id === rB.id);
      T(
        'pb-hunt36-room-kept-when-merged',
        !!rB && !!nowA && !!nowB && JSON.stringify(nowA.poly) === keepA && JSON.stringify(nowB.poly) === keepB,
        '两间都有轮廓=' +
          !!rB +
          ' · 拆隔墙后 A 没变=' +
          (!!nowA && JSON.stringify(nowA.poly) === keepA) +
          ' · B 没变=' +
          (!!nowB && JSON.stringify(nowB.poly) === keepB)
      );
      DOC.walls.push(midSaved);
      geoChanged();
      await tick();

      /* 33.4 对照：墙上开了缺口（删掉西墙，这块漏到室外）→ 轮廓保留原样，不替用户猜 */
      const keep = rA2 ? JSON.stringify(rA2.poly) : '';
      DOC.walls = DOC.walls.filter((w) => w.id !== wWest.id);
      geoChanged();
      await tick();
      const rA3 = (DOC.rooms || []).find((r) => rA && r.id === rA.id);
      T(
        'pb-hunt36-room-kept-when-leaking',
        !!rA3 && JSON.stringify(rA3.poly) === keep,
        '删掉西墙后轮廓没变=' + (!!rA3 && JSON.stringify(rA3.poly) === keep)
      );

      /* 收尾：删掉这份户型 */
      await enterEdit();
      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      T(
        'pb-hunt36-clean-exit',
        PLAN_ID !== p33Plan && PLAN_REG.plans.length === p33Plans,
        'plans ' + p33Plans + '→' + PLAN_REG.plans.length
      );
    }

    /* ===== 34. bug 猎 ㊲：采购清单导出 × 界面上同一张清单的「地板用量」那一节 ===== */
    {
      await enterEdit();
      await pbReset();
      const p34Plans = PLAN_REG.plans.length;
      Q('#btnPlanNew').click();
      await tick();
      const p34Plan = PLAN_ID;
      const fp34 = floorPts();
      const X =
          Math.min.apply(
            null,
            fp34.map((p) => p[0])
          ) + 1,
        Y =
          Math.min.apply(
            null,
            fp34.map((p) => p[1])
          ) + 1;
      const wd = cmToWd(12);
      pushUserWall(X, Y, X + 12, Y, 'w', wd);
      pushUserWall(X + 12, Y, X + 12, Y + 10, 'w', wd);
      pushUserWall(X + 12, Y + 10, X, Y + 10, 'w', wd);
      pushUserWall(X, Y + 10, X, Y, 'w', wd);
      geoChanged();
      fit2DToContent();
      drawWallEdit();
      await tick();
      await setTool('room');
      await tap(X + 3, Y + 3);
      Q('#rmFloor').value = 'oakHerring';
      Q('#rmFloor').dispatchEvent(new Event('change'));
      await tick();
      if (wallEdit.on) {
        Q('#btnWallEdit').click();
        await tick();
      }
      const rowTxt = Array.from(document.querySelectorAll('#plRows .floorRow')).map((r) => r.textContent);
      // 界面上那一行写的面积（独立读界面，不调实现）
      const uiArea = (rowTxt[0] || '').match(/([\d.]+) m²/);
      const grab = async () => {
        const origClick = HTMLAnchorElement.prototype.click;
        let dl = null;
        HTMLAnchorElement.prototype.click = function () {
          dl = { name: this.download, href: this.href };
        };
        Q('#plCsv').click();
        HTMLAnchorElement.prototype.click = origClick;
        const csv = dl ? await (await fetch(dl.href)).text() : '';
        const clip = navigator.clipboard;
        const origWrite = clip && clip.writeText;
        let copied = null;
        if (clip)
          clip.writeText = async (t) => {
            copied = t;
          };
        Q('#plCopy').click();
        for (let i = 0; i < 10 && copied === null; i++) await tick();
        if (clip) clip.writeText = origWrite;
        return { csv, copied: copied || '' };
      };

      /* 34.1 #80 只铺了地板、还没摆家具：两个按钮都不能说「清单是空的」，导出里有那一行地板 */
      const g1 = await grab();
      const okEmpty = /自然橡木/.test(g1.csv) && /自然橡木/.test(g1.copied);

      /* 34.2 #80 摆一件家具：CSV 里地板那一行（分类「地板」、数量 = 界面上那个面积）在合计行之前；纯文本最后一节是地板用量 */
      addItem('kivik3');
      await tick();
      const g2 = await grab();
      const lines = g2.csv.replace(/^\uFEFF/, '').split('\r\n');
      const fl = lines.findIndex((l) => /^"","地板","自然橡木/.test(l)),
        tot = lines.findIndex((l) => /^"","","合计"/.test(l));
      const flArea = fl >= 0 ? (lines[fl].split('","')[3] || '').replace(/"/g, '') : '';
      const tl = g2.copied.split('\n');
      T(
        'pb-hunt37-export-has-floor-usage',
        rowTxt.length === 1 &&
          !!uiArea &&
          okEmpty &&
          fl > 0 &&
          tot > fl &&
          +flArea === +uiArea[1] &&
          /用在：/.test(lines[fl]) &&
          tl.indexOf('地板用量（按房间面积，不含损耗）') > tl.findIndex((l) => /^采购 1 件/.test(l)) &&
          /· 自然橡木.* — [\d.]+ m²（/.test(g2.copied),
        '界面 ' +
          JSON.stringify(rowTxt) +
          ' · 只有地板时两个按钮都导出了=' +
          okEmpty +
          ' · CSV 地板行 #' +
          fl +
          '（数量 ' +
          flArea +
          '）合计行 #' +
          tot +
          ' · 文本最后几行 ' +
          JSON.stringify(tl.slice(-3))
      );

      /* 34.3 #81 多层：家具是整栋一张单（每行标楼层），地板用量却只算当前这一层——加一层（带外壳）、二层那间也铺同一种，
         在哪一层看都是两间的面积之和、两间都列出来（标楼层） */
      const area1 = (floorUsage().get('oakHerring') || {}).area || 0;
      Q('#lvCopyShell').checked = true;
      addLevelUI('above');
      await tick();
      await enterEdit();
      await setTool('room');
      await tap(X + 3, Y + 3);
      Q('#rmFloor').value = 'oakHerring';
      Q('#rmFloor').dispatchEvent(new Event('change'));
      await tick();
      const onUp = floorUsage().get('oakHerring') || { area: 0, rooms: [] };
      Q('#lvBtns button[data-lv="lv1"]').click();
      await tick();
      const onDown = floorUsage().get('oakHerring') || { area: 0, rooms: [] };
      const rowDown = Array.from(document.querySelectorAll('#plRows .floorRow')).map((r) => r.textContent);
      T(
        'pb-hunt37-floor-usage-whole-house',
        area1 > 0 &&
          Math.abs(onUp.area - 2 * area1) < 1e-6 &&
          Math.abs(onDown.area - 2 * area1) < 1e-6 &&
          onDown.rooms.length === 2 &&
          /一层/.test(onDown.rooms.join()) &&
          /二层/.test(onDown.rooms.join()) &&
          rowDown.length === 1 &&
          /二层/.test(rowDown[0]),
        '一层那间 ' +
          area1.toFixed(2) +
          'ft² · 在二层看 ' +
          onUp.area.toFixed(2) +
          ' · 回一层看 ' +
          onDown.area.toFixed(2) +
          '（' +
          onDown.rooms.join('、') +
          '）· 界面「' +
          (rowDown[0] || '') +
          '」'
      );

      /* 收尾：删掉这份户型 */
      await enterEdit();
      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      T(
        'pb-hunt37-clean-exit',
        PLAN_ID !== p34Plan && PLAN_REG.plans.length === p34Plans,
        'plans ' + p34Plans + '→' + PLAN_REG.plans.length
      );
    }

    /* ===== 35. bug 猎 ㊳：墙换类型（窗 / 开口 / 门洞）× 挂在它上面的点位 ===== */
    {
      await enterEdit();
      await pbReset();
      const p35Plans = PLAN_REG.plans.length;
      Q('#btnPlanNew').click();
      await tick();
      const p35Plan = PLAN_ID;
      const fp35 = floorPts();
      const X =
          Math.min.apply(
            null,
            fp35.map((p) => p[0])
          ) + 1,
        Y =
          Math.min.apply(
            null,
            fp35.map((p) => p[1])
          ) + 1;
      const wd = cmToWd(15);
      const wN = pushUserWall(X, Y, X + 16, Y, 'w', wd);
      const wE = pushUserWall(X + 16, Y, X + 16, Y + 12, 'w', wd);
      pushUserWall(X + 16, Y + 12, X, Y + 12, 'w', wd);
      pushUserWall(X, Y + 12, X, Y, 'w', wd);
      geoChanged();
      fit2DToContent();
      await tick();
      const tN = pbDrawnThick(effWalls().find((s) => s._id === wN.id)) / 2,
        tE = pbDrawnThick(effWalls().find((s) => s._id === wE.id)) / 2;
      const oN = pushUserOutlet(pointSnap(X + 8, Y + tN + 0.2, 'std', 'wall'), 'std', 1, null);
      const oE = pushUserOutlet(pointSnap(X + 16 - tE - 0.2, Y + 6, 'std', 'wall'), 'std', 1, null);
      syncOutlets();
      geoChanged();
      await tick();
      const ids = () => (DOC.outlets || []).map((o) => o.id);
      const pre = !!oN && !!oE && oN.hostId === wN.id && oE.hostId === wE.id;

      /* 35.1 #82 北墙改成「窗」：挂在它上面的插座不能留在窗洞里（以前留着：宿主不再是实墙 → 派生位姿算不出来，
         缓存坐标原地不动，2D / 3D 里它悬在窗上）；隔壁那面墙上的不动；提示说出去掉了几个；一步撤销连插座一起回来 */
      await setTool('select');
      await tap(X + 4, Y);
      const selN = !!wallEdit.sel && wallEdit.sel.id === wN.id;
      Q('#wType').value = 'g';
      Q('#wType').dispatchEvent(new Event('change'));
      await tick();
      const after = ids();
      const msg = (Q('#wMsg') || {}).textContent || '';
      const isWin = (DOC.windows || []).some((w) => w.id === wN.id);
      undoStep();
      await tick();
      const back = ids();
      T(
        'pb-hunt38-wall-to-window-drops-its-points',
        pre &&
          selN &&
          isWin &&
          !after.includes(oN.id) &&
          after.includes(oE.id) &&
          /1 个点位/.test(msg) &&
          back.includes(oN.id) &&
          back.includes(oE.id) &&
          (DOC.walls || []).some((w) => w.id === wN.id),
        '前提=' +
          pre +
          ' · 选中北墙=' +
          selN +
          ' · 改成窗=' +
          isWin +
          ' · 之后点位 ' +
          JSON.stringify(after) +
          ' · 提示「' +
          msg.slice(0, 40) +
          '」· 撤销后 ' +
          JSON.stringify(back)
      );

      /* 35.2 #82 改成「开口」也一样（开口上挂不了插座）；撤销回来 */
      await tap(X + 4, Y);
      Q('#wType').value = 'o';
      Q('#wType').dispatchEvent(new Event('change'));
      await tick();
      const afterO = ids();
      undoStep();
      await tick();
      T(
        'pb-hunt38-wall-to-opening-drops-its-points',
        !afterO.includes(oN.id) && afterO.includes(oE.id) && ids().includes(oN.id),
        '改成开口后点位 ' + JSON.stringify(afterO) + ' · 撤销后 ' + JSON.stringify(ids())
      );

      /* 收尾：删掉这份户型 */
      await enterEdit();
      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      T(
        'pb-hunt38-clean-exit',
        PLAN_ID !== p35Plan && PLAN_REG.plans.length === p35Plans,
        'plans ' + p35Plans + '→' + PLAN_REG.plans.length
      );
    }

    /* ===== 36. bug 猎 ㊴：房间轮廓重算（轮㊱）× 隔墙挪过了标签点 ===== */
    {
      await enterEdit();
      await pbReset();
      const p36Plans = PLAN_REG.plans.length;
      Q('#btnPlanNew').click();
      await tick();
      const p36Plan = PLAN_ID;
      const fp36 = floorPts();
      const X =
          Math.min.apply(
            null,
            fp36.map((p) => p[0])
          ) + 1,
        Y =
          Math.min.apply(
            null,
            fp36.map((p) => p[1])
          ) + 1;
      const AW = 12,
        BW = 7,
        RH = 10,
        wd = cmToWd(12);
      pushUserWall(X, Y, X + AW + BW, Y, 'w', wd);
      pushUserWall(X + AW + BW, Y, X + AW + BW, Y + RH, 'w', wd);
      pushUserWall(X + AW + BW, Y + RH, X, Y + RH, 'w', wd);
      pushUserWall(X, Y + RH, X, Y, 'w', wd);
      const wMid = pushUserWall(X + AW, Y, X + AW, Y + RH, 'w', wd);
      geoChanged();
      fit2DToContent();
      drawWallEdit();
      await tick();
      const t = pbDrawnThick(effWalls().find((s) => s._id === wMid.id));
      await setTool('room');
      await tap(X + 3, Y + 3);
      const rA = (DOC.rooms || [])[(DOC.rooms || []).length - 1];
      const pos0 = rA ? rA.pos.slice() : null;
      const moveMid = (x) => {
        const w = DOC.walls.find((e) => e.id === wMid.id);
        w.geom.x1 = x;
        w.geom.x2 = x;
        geoChanged();
      };

      /* 36.1 对照：隔墙往 A 里挪 2ft（标签点还在 A 里）→ 轮廓变小，名字不跳 */
      moveMid(X + AW - 2);
      await tick();
      const a1 = rA ? roomArea(rA) : 0,
        want1 = (AW - 2 - t) * (RH - t);
      T(
        'pb-hunt39-shrink-keeps-label',
        !!rA && Math.abs(a1 - want1) / want1 < 0.01 && JSON.stringify(rA.pos) === JSON.stringify(pos0),
        '面积 ' +
          a1.toFixed(2) +
          'ft²（独立量 ' +
          want1.toFixed(2) +
          '）· 标签点没动=' +
          (rA && JSON.stringify(rA.pos) === JSON.stringify(pos0))
      );

      /* 36.2 #83 隔墙一直挪到 A 的标签点另一边（A 只剩 3ft 宽）：标签点落进了隔壁那块。A 要收成剩下那 3ft，
         不能把隔壁（变成 16ft 宽的那块）认成自己——以前「过半落在对方里」就算同一间：上一步 10ft 宽的 A 有 7/10 在隔壁那块里；
         也不能停在旧轮廓上不动。用户建的房间标签点跟着挪进新轮廓 */
      moveMid(X + 3);
      await tick();
      const a2 = rA ? roomArea(rA) : 0,
        want2 = (3 - t) * (RH - t),
        wrong = (AW + BW - 3 - t) * (RH - t);
      T(
        'pb-hunt39-wall-past-label-no-neighbor-capture',
        !!rA && Math.abs(a2 - want2) / want2 < 0.01 && ptInPoly(rA.pos, rA.poly),
        '面积 ' +
          a2.toFixed(2) +
          'ft²（剩下那块的独立量 ' +
          want2.toFixed(2) +
          '；隔壁那块 ' +
          wrong.toFixed(2) +
          '）· 标签点在轮廓里=' +
          (rA && ptInPoly(rA.pos, rA.poly))
      );

      /* 收尾：删掉这份户型 */
      await enterEdit();
      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      T(
        'pb-hunt39-clean-exit',
        PLAN_ID !== p36Plan && PLAN_REG.plans.length === p36Plans,
        'plans ' + p36Plans + '→' + PLAN_REG.plans.length
      );
    }

    /* ===== 37. bug 猎 ㊷：换过类型的墙 / 窗（id 跨数组保留）× 编辑层按 id 前缀找实体 ===== */
    {
      await enterEdit();
      await pbReset();
      const p37Plans = PLAN_REG.plans.length;
      Q('#btnPlanNew').click();
      await tick();
      const p37Plan = PLAN_ID;
      const fp37 = floorPts();
      const X =
          Math.min.apply(
            null,
            fp37.map((p) => p[0])
          ) + 1,
        Y =
          Math.min.apply(
            null,
            fp37.map((p) => p[1])
          ) + 1;
      const wd = cmToWd(15);
      const wN = pushUserWall(X, Y, X + 16, Y, 'w', wd);
      pushUserWall(X + 16, Y, X + 16, Y + 12, 'w', wd);
      pushUserWall(X + 16, Y + 12, X + 10, Y + 12, 'w', wd);
      const nS = pushUserWindow(X + 10, Y + 12, X + 5, Y + 12, wd);
      pushUserWall(X + 5, Y + 12, X, Y + 12, 'w', wd);
      pushUserWall(X, Y + 12, X, Y, 'w', wd);
      geoChanged();
      fit2DToContent();
      await tick();
      await setTool('select');
      const vis37 = (sel) => {
        const el = Q(sel);
        return !!el && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
      };

      /* 37.1 #86 北墙换成窗（winFromWall 保留 id「w…」、实体搬进 windows 数组）→ 再点它：选得中、窗的工具条在、
         「窗帘」按钮挂得上帘、Delete 真的删掉（以前 entById 按 id 前缀去 walls 里找 → 找不到：工具条空的、
         窗的按钮全不起作用、Delete 什么都没删却说「已删除」） */
      await tap(X + 8, Y);
      Q('#wType').value = 'g';
      Q('#wType').dispatchEvent(new Event('change'));
      await tick();
      wallEdit.sel = null;
      updateWallBarFromSel();
      await tap(X + 8, Y);
      const selOk = !!wallEdit.sel && wallEdit.sel.id === wN.id && !!selWallSeg();
      const winCtl = vis37('#winCtl');
      Q('#wWinCurtain').click();
      await tick();
      const wEnt = (DOC.windows || []).find((w) => w.id === wN.id);
      const curtained = !!(wEnt && wEnt.curtain);
      key('Delete');
      await tick();
      const gone = !(DOC.windows || []).some((w) => w.id === wN.id) && !(DOC.walls || []).some((w) => w.id === wN.id);
      T(
        'pb-hunt42-converted-window-editable',
        selOk && winCtl && curtained && gone,
        '选得中=' + selOk + ' · 窗工具条在=' + winCtl + ' · 挂上窗帘=' + curtained + ' · Delete 真删掉=' + gone
      );

      /* 37.2 #86 反过来：画的窗（id「n…」）换成实墙 → 再点它：选得中、改厚度生效、Delete 真的删掉 */
      await tap(X + 7.5, Y + 12);
      Q('#wType').value = 'w';
      Q('#wType').dispatchEvent(new Event('change'));
      await tick();
      wallEdit.sel = null;
      updateWallBarFromSel();
      await tap(X + 7.5, Y + 12);
      const selOk2 = !!wallEdit.sel && wallEdit.sel.id === nS.id && !!selWallSeg();
      Q('#wThick').value = '24';
      Q('#wThick').dispatchEvent(new Event('change'));
      await tick();
      const wEnt2 = (DOC.walls || []).find((w) => w.id === nS.id);
      const thickOk = !!wEnt2 && Math.abs(wEnt2.thick * 30.48 - 24) < 0.6;
      key('Delete');
      await tick();
      const gone2 = !(DOC.walls || []).some((w) => w.id === nS.id) && !(DOC.windows || []).some((w) => w.id === nS.id);
      T(
        'pb-hunt42-converted-wall-editable',
        selOk2 && thickOk && gone2,
        '选得中=' + selOk2 + ' · 改厚度 24cm 生效=' + thickOk + ' · Delete 真删掉=' + gone2
      );

      /* 37.3 #87 墙换成窗之后再画一段墙：新墙的 id 不能与那扇（还叫「w…」的）窗撞上——nextId 以前只查本数组，
         换走的正好是编号最大的那段墙时，下一段新墙就拿到同一个 id（之后两个实体按 id 互相遮挡：选中 / 删除 / 撤销键都串） */
      const wLast = DOC.walls[DOC.walls.length - 1];
      const lastId = wLast.id;
      setSegType(wLast, 'g');
      geoChanged();
      await tick();
      const wNew = pushUserWall(X + 2, Y + 3, X + 6, Y + 3, 'w', wd);
      const allIds = DOC.walls.map((w) => w.id).concat(DOC.windows.map((w) => w.id));
      T(
        'pb-hunt42-next-wall-id-unique',
        (DOC.windows || []).some((w) => w.id === lastId) &&
          wNew.id !== lastId &&
          new Set(allIds).size === allIds.length,
        '换成窗的那段 ' +
          lastId +
          ' · 新墙 ' +
          wNew.id +
          ' · 墙 + 窗的 id 有重复=' +
          (new Set(allIds).size !== allIds.length)
      );

      /* 收尾：删掉这份户型 */
      await enterEdit();
      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      T(
        'pb-hunt42-clean-exit',
        PLAN_ID !== p37Plan && PLAN_REG.plans.length === p37Plans,
        'plans ' + p37Plans + '→' + PLAN_REG.plans.length
      );
    }

    /* ===== 38. S22a 开窗 / 改窗（加窗工具、在这段开窗、加门点实墙、窗台 / 窗高、沿墙滑、改宽） ===== */
    {
      await enterEdit();
      await pbReset();
      const p38Plans = PLAN_REG.plans.length;
      Q('#btnPlanNew').click();
      await tick();
      const p38Plan = PLAN_ID;
      const fp38 = floorPts();
      const X =
          Math.min.apply(
            null,
            fp38.map((p) => p[0])
          ) + 1,
        Y =
          Math.min.apply(
            null,
            fp38.map((p) => p[1])
          ) + 1;
      const wd = cmToWd(15);
      const wN = pushUserWall(X, Y, X + 16, Y, 'w', wd);
      const wE = pushUserWall(X + 16, Y, X + 16, Y + 12, 'w', wd);
      const wS = pushUserWall(X + 16, Y + 12, X, Y + 12, 'w', wd);
      pushUserWall(X, Y + 12, X, Y, 'w', wd);
      geoChanged();
      fit2DToContent();
      await tick();
      const tN = pbDrawnThick(effWalls().find((s) => s._id === wN.id));
      // 北墙上三个插座：左段（at 2ft）/ 将来窗口里（at 8ft）/ 右段（at 13ft）
      const olAt = (at) => pushUserOutlet(pointSnap(X + at, Y + tN / 2 + 0.2, 'std', 'wall'), 'std', 1, null);
      const o1 = olAt(2),
        o2 = olAt(8),
        o3 = olAt(13);
      syncOutlets();
      geoChanged();
      await tick();
      const pose = (o) => {
        const q = outletPose(o);
        return q ? [q.x, q.y] : null;
      };
      const o3pose0 = pose(o3);
      const geomOf = (id) => {
        const e = entById(id);
        return e ? [e.geom.x1, e.geom.y1, e.geom.x2, e.geom.y2] : null;
      };
      const wN0 = JSON.stringify(geomOf(wN.id));
      const near = (a, b, tol) => Math.abs(a - b) < (tol || 1e-3);
      const winW = 120 / 30.48;

      /* 38.1 加窗工具：悬停在北墙上 → 蓝色预览（窗那一截 + 宽 + 两头各剩多少墙） */
      await setTool('win');
      const [hx, hy] = SPT(X + 8, Y);
      fire('pointermove', hx, hy, { buttons: 0 });
      await tick();
      const pv = wallEdit.winPreview;
      const pvEl = pbSvg.querySelector('g.winPreview');
      T(
        'pb-s22-win-preview',
        !!pv &&
          pv.id === wN.id &&
          near(pv.b - pv.a, winW, 0.01) &&
          near((pv.a + pv.b) / 2, 8, 0.01) &&
          !!pvEl &&
          pvEl.querySelectorAll('text').length === 3,
        pv
          ? '预览 [' +
              pv.a.toFixed(2) +
              ', ' +
              pv.b.toFixed(2) +
              ']ft · 标签 ' +
              (pvEl ? pvEl.querySelectorAll('text').length : 0) +
              ' 个'
          : '没有预览'
      );

      /* 38.2 点一下 = 开窗：北墙拆成「墙｜窗｜墙」，窗宽 120cm、居中（吸到中点）、窗厚 = 墙厚；
         挂在北墙上的插座：左段那个不动、窗里那个去掉（提示说个数）、右段那个改挂到新墙段且位置不变；一步撤销 */
      const r2 = undoRing.length;
      await tap(X + 8, Y);
      const win = (DOC.windows || []).find((w) => w.src === 'user');
      const right = (DOC.walls || []).find(
        (w) =>
          w.id !== wN.id &&
          w.id !== wE.id &&
          w.id !== wS.id &&
          w.src === 'user' &&
          near(w.geom.y1, Y) &&
          near(w.geom.y2, Y)
      );
      const gW = win ? win.geom : null,
        gL = entById(wN.id).geom;
      const msg2 = Q('#wMsg').textContent;
      const ok2 =
        !!win &&
        !!right &&
        near(Math.hypot(gW.x2 - gW.x1, gW.y2 - gW.y1), winW, 1e-3) &&
        near((gW.x1 + gW.x2) / 2, X + 8, 1e-3) &&
        near(gL.x2, gW.x1, 1e-4) &&
        near(right.geom.x1, gW.x2, 1e-4) &&
        near(right.geom.x2, X + 16, 1e-4) &&
        near(win.thick, wN.thick, 1e-6) &&
        undoRing.length === r2 + 1;
      const ol2 = (DOC.outlets || []).map((o) => o.id);
      const o3now = (DOC.outlets || []).find((o) => o.id === o3.id);
      const okOl =
        ol2.includes(o1.id) &&
        !ol2.includes(o2.id) &&
        !!o3now &&
        o3now.hostId === right.id &&
        near(pose(o3now)[0], o3pose0[0], 2e-3) &&
        near(pose(o3now)[1], o3pose0[1], 2e-3) &&
        /1 个点位/.test(msg2);
      T(
        'pb-s22-win-insert-splits-wall',
        ok2 && okOl && wallEdit.sel && wallEdit.sel.id === (win && win.id),
        '窗 ' +
          (gW
            ? (Math.hypot(gW.x2 - gW.x1, gW.y2 - gW.y1) * 30.48).toFixed(1) +
              'cm 中心 ' +
              ((gW.x1 + gW.x2) / 2 - X).toFixed(3)
            : '无') +
          ' · 左段到 ' +
          (gL.x2 - X).toFixed(3) +
          ' · 右段从 ' +
          (right ? (right.geom.x1 - X).toFixed(3) : '无') +
          ' · 厚 ' +
          (win ? win.thick.toFixed(4) : '?') +
          ' vs ' +
          wN.thick.toFixed(4) +
          ' · 选中 ' +
          JSON.stringify(wallEdit.sel) +
          ' · 插座 ' +
          JSON.stringify(ol2) +
          ' · 右段那个挂到新墙=' +
          (!!o3now && o3now.hostId === (right && right.id)) +
          ' · 提示「' +
          msg2.slice(0, 40) +
          '」· 撤销环 +' +
          (undoRing.length - r2)
      );

      /* 38.3 撤销：回到一整段北墙、三个插座原样 */
      undoStep();
      await tick();
      const back3 =
        JSON.stringify(geomOf(wN.id)) === wN0 &&
        !(DOC.windows || []).some((w) => w.src === 'user') &&
        (DOC.outlets || []).length === 3;
      T(
        'pb-s22-win-insert-undo',
        back3,
        '北墙复原=' +
          (JSON.stringify(geomOf(wN.id)) === wN0) +
          ' · 窗 ' +
          (DOC.windows || []).length +
          ' · 插座 ' +
          (DOC.outlets || []).length
      );

      /* 38.3b W12 删窗 = 墙封回去（与「加窗」互逆）：再开一扇 → Delete → 北墙又是完整一段（几何 = 开窗前）、拆出来的右段不在了、
         右段那个插座挂回北墙且位置不变、一步撤销、提示说「封上」；Ctrl+Z 两次回到开窗前（窗里那个插座也回来）。
         以前 Delete = 只删窗那一截 → 墙上留个洞（2D 一道缺口、3D 一个落地的洞） */
      {
        const h0 = undoRing.length;
        await tap(X + 8, Y);
        const winB = (DOC.windows || []).find((w) => w.src === 'user');
        const selIsWin = !!winB && !!wallEdit.sel && wallEdit.sel.id === winB.id;
        const h1 = undoRing.length;
        key('Delete');
        await tick();
        const nUser = (DOC.walls || []).filter(
          (w) => w.src === 'user' && near(w.geom.y1, Y) && near(w.geom.y2, Y)
        ).length;
        const o3b = (DOC.outlets || []).find((o) => o.id === o3.id);
        const msgB = Q('#wMsg').textContent,
          gNB = JSON.stringify(geomOf(wN.id));
        const closed =
          selIsWin &&
          !(DOC.windows || []).some((w) => w.src === 'user') &&
          gNB === wN0 &&
          nUser === 1 &&
          !!o3b &&
          o3b.hostId === wN.id &&
          near(pose(o3b)[0], o3pose0[0], 2e-3) &&
          near(pose(o3b)[1], o3pose0[1], 2e-3) &&
          undoRing.length === h1 + 1 &&
          /封/.test(msgB);
        undoStep();
        await tick();
        const winBack = (DOC.windows || []).some((w) => w.src === 'user');
        undoStep();
        await tick();
        const orig =
          JSON.stringify(geomOf(wN.id)) === wN0 &&
          !(DOC.windows || []).some((w) => w.src === 'user') &&
          (DOC.outlets || []).length === 3 &&
          undoRing.length === h0;
        T(
          'pb-s22-win-delete-closes-wall',
          closed && winBack && orig,
          '选中窗=' +
            selIsWin +
            ' · Delete 后北墙=' +
            (gNB === wN0 ? '整段' : gNB) +
            ' · 北边用户墙 ' +
            nUser +
            ' 段 · 插座挂回北墙=' +
            !!(o3b && o3b.hostId === wN.id) +
            ' · 「' +
            msgB.slice(0, 30) +
            '」 · 撤一步窗回来=' +
            winBack +
            ' · 再撤一步回到开窗前=' +
            orig
        );
      }

      /* 38.4 中点吸附：离中点 0.4 个吸附半径点下 → 吸到正中；按住 Alt 同一处 → 不吸 */
      const rSnap = 10 / pxPerFt();
      const offX = 8 + rSnap * 0.4;
      const [ax, ay] = SPT(X + offX, Y);
      fire('pointerdown', ax, ay, { altKey: true });
      await tick();
      fire('pointerup', ax, ay, { altKey: true, buttons: 0 });
      await tick();
      const wAlt = (DOC.windows || []).find((w) => w.src === 'user');
      const cAlt = wAlt ? (wAlt.geom.x1 + wAlt.geom.x2) / 2 - X : NaN;
      undoStep();
      await tick();
      await tap(X + offX, Y);
      const wSnap = (DOC.windows || []).find((w) => w.src === 'user');
      const cSnap = wSnap ? (wSnap.geom.x1 + wSnap.geom.x2) / 2 - X : NaN;
      T(
        'pb-s22-win-mid-snap-alt',
        near(cSnap, 8, 1e-3) && near(cAlt, offX, 0.02),
        '吸附半径 ' +
          rSnap.toFixed(3) +
          'ft · 点在 ' +
          offX.toFixed(3) +
          ' → 不按 Alt 中心 ' +
          cSnap.toFixed(3) +
          ' · 按 Alt ' +
          cAlt.toFixed(3)
      );

      /* 38.5 选择工具拖窗身 = 沿墙滑（斜着拖也只取沿墙分量）、两头的墙跟着伸缩；Esc 中途回滚——款式不变
         （回滚以前把整个视图写回去，窗的 slider 键把平开 / 上悬改成了固定）；拖动中的「离左端 · 离右端」跟着窗走 */
      await setTool('select');
      const w5 = wSnap;
      const g5 = Object.assign({}, w5.geom);
      const ppf = pxPerFtNow();
      const [sx, sy] = SPT((g5.x1 + g5.x2) / 2, Y);
      fire('pointerdown', sx, sy);
      await tick();
      fire('pointermove', sx + ppf * 1, sy + ppf * 0.5);
      await tick();
      fire('pointermove', sx + ppf * 2, sy + ppf * 0.5);
      await tick();
      fire('pointerup', sx + ppf * 2, sy + ppf * 0.5, { buttons: 0 });
      await tick();
      const g5b = entById(w5.id).geom,
        gL5 = entById(wN.id).geom;
      const rt5 = (DOC.walls || []).find(
        (w) => w.src === 'user' && w.id !== wN.id && near(w.geom.y1, Y) && near(w.geom.y2, Y) && near(w.geom.x2, X + 16)
      );
      const slid = g5b.x1 - g5.x1;
      const ok5 =
        near(slid, 2, 0.05) &&
        near(g5b.y1, Y, 1e-6) &&
        near(g5b.y2, Y, 1e-6) &&
        near(gL5.x2, g5b.x1, 1e-4) &&
        !!rt5 &&
        near(rt5.geom.x1, g5b.x2, 1e-4);
      entById(w5.id).style = 'casement';
      fire('pointerdown', SPT((g5b.x1 + g5b.x2) / 2, Y)[0], sy);
      await tick();
      fire('pointermove', SPT((g5b.x1 + g5b.x2) / 2, Y)[0] + ppf * 1.5, sy);
      await tick();
      // 独立量：拖动中左墙从它的起点量到窗左端、右墙从窗右端量到它的终点（拐角）
      const gm5 = entById(w5.id).geom,
        wantL5 = (gm5.x1 - entById(wN.id).geom.x1) * 30.48,
        wantR5 = (X + 16 - gm5.x2) * 30.48;
      const mm5 = /离左端 ([\d.]+) cm · 离右端 ([\d.]+) cm/.exec(Q('#wMsg').textContent) || [];
      const liveRuns = Math.abs(+mm5[1] - wantL5) <= 0.6 && Math.abs(+mm5[2] - wantR5) <= 0.6;
      key('Escape');
      await tick();
      fire('pointerup', SPT((g5b.x1 + g5b.x2) / 2, Y)[0] + ppf * 1.5, sy, { buttons: 0 });
      await tick();
      const rolled =
        near(entById(w5.id).geom.x1, g5b.x1, 1e-6) &&
        near(entById(wN.id).geom.x2, g5b.x1, 1e-6) &&
        entById(w5.id).style === 'casement';
      T(
        'pb-s22-win-slide-along-wall',
        ok5 && rolled,
        '拖 (2, 0.5)ft → 沿墙挪了 ' +
          slid.toFixed(3) +
          'ft · 离开墙线=' +
          !near(g5b.y1, Y, 1e-6) +
          ' · 两头的墙贴着=' +
          (near(gL5.x2, g5b.x1, 1e-4) && !!rt5 && near(rt5.geom.x1, g5b.x2, 1e-4)) +
          ' · Esc 回滚=' +
          rolled +
          '（款式 ' +
          entById(w5.id).style +
          '）· 拖动中提示 ' +
          (mm5[0] || '（没有）') +
          ' vs 量出来 ' +
          wantL5.toFixed(1) +
          ' / ' +
          wantR5.toFixed(1)
      );
      entById(w5.id).style = 'fixed';
      T(
        'pb-s22-win-drag-runs-live',
        liveRuns,
        (mm5[0] || Q('#wMsg').textContent) + ' vs 量出来 ' + wantL5.toFixed(1) + ' / ' + wantR5.toFixed(1)
      );

      /* 38.5b 拖窗的端点 = 改宽（另一端不动、这一头的墙跟着伸缩）；松手后 width 字段 = 几何长度；Ctrl+Z 一步回去 */
      {
        const ge = Object.assign({}, entById(w5.id).geom),
          [ex, ey] = SPT(ge.x2, Y),
          h0 = undoRing.length;
        const hEl = document.elementFromPoint(ex, ey);
        fire('pointerdown', ex, ey);
        await tick();
        fire('pointermove', ex + ppf * 0.25, ey);
        await tick();
        fire('pointermove', ex + ppf * 0.5, ey);
        await tick();
        const gx = entById(w5.id).geom,
          wantR = (X + 16 - gx.x2) * 30.48;
        const mR = /离右端 ([\d.]+) cm/.exec(Q('#wMsg').textContent) || [];
        fire('pointerup', ex + ppf * 0.5, ey, { buttons: 0 });
        await tick();
        const ga = entById(w5.id).geom,
          ent = entById(w5.id),
          rtE = (DOC.walls || []).find(
            (w) =>
              w.src === 'user' && w.id !== wN.id && near(w.geom.y1, Y) && near(w.geom.y2, Y) && near(w.geom.x2, X + 16)
          );
        const okE =
          !!hEl &&
          hEl.classList.contains('wEnd') &&
          near(ga.x1, ge.x1, 1e-6) &&
          near(ga.x2 - ge.x2, 0.5, 0.02) &&
          near(ent.width, ga.x2 - ga.x1, 0.006) &&
          !!rtE &&
          near(rtE.geom.x1, ga.x2, 1e-4) &&
          Math.abs(+mR[1] - wantR) <= 0.6 &&
          undoRing.length === h0 + 1;
        const dUndo = undoRing.length - h0;
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })
        );
        await tick();
        const gu = entById(w5.id).geom;
        await tap((gu.x1 + gu.x2) / 2, Y); // 撤销会清掉编辑层的选中（快照里的实体可能已不在）→ 重新点选，后面几条接着用
        T(
          'pb-s22-win-end-drag-width',
          okE && near(gu.x2, ge.x2, 1e-6),
          '抓到端点=' +
            !!(hEl && hEl.classList.contains('wEnd')) +
            ' · 右端 +' +
            (ga.x2 - ge.x2).toFixed(3) +
            'ft · 左端不动=' +
            near(ga.x1, ge.x1, 1e-6) +
            ' · width ' +
            (ent.width * 30.48).toFixed(1) +
            'cm vs 几何 ' +
            ((ga.x2 - ga.x1) * 30.48).toFixed(1) +
            'cm · 右墙贴着=' +
            !!(rtE && near(rtE.geom.x1, ga.x2, 1e-4)) +
            ' · 拖动中 ' +
            (mR[0] || '（没有）') +
            ' vs ' +
            wantR.toFixed(1) +
            ' · 撤销 +' +
            dUndo +
            ' · Ctrl+Z 回到原宽=' +
            near(gu.x2, ge.x2, 1e-6)
        );
      }

      /* 38.6 方向键 = 沿墙挪：→ 1cm、Shift+→ 10cm；↑（垂直于这扇窗）不动；挪到头 = 右边的墙留最短一截 */
      const x6 = entById(w5.id).geom.x1;
      key('ArrowRight');
      await tick();
      const d1 = entById(w5.id).geom.x1 - x6;
      key('ArrowRight', null, true);
      await tick();
      const d2 = entById(w5.id).geom.x1 - x6 - d1;
      key('ArrowUp');
      await tick();
      const up = entById(w5.id).geom.y1 - Y;
      for (let k = 0; k < 80; k++) key('ArrowRight', null, true);
      await tick();
      const rt6 = (DOC.walls || []).find(
        (w) => w.src === 'user' && w.id !== wN.id && near(w.geom.y1, Y) && near(w.geom.y2, Y) && near(w.geom.x2, X + 16)
      );
      const stub = rt6 ? Math.hypot(rt6.geom.x2 - rt6.geom.x1, rt6.geom.y2 - rt6.geom.y1) : NaN;
      // 右段上挂着 38.2 改挂过去的那个插座：窗推到头 = 墙垛缩到插座左沿为止（不盖住插座），没有插座时才是 STUB_MIN
      const o36 = (DOC.outlets || []).find((o) => o.id === o3.id && o.hostId === (rt6 && rt6.id));
      const want6 = o36 ? Math.max(STUB_MIN, X + 16 - (pose(o36)[0] - cmFt(ptDef('std').plate[0]) / 2)) : STUB_MIN;
      const why6 = Q('#wMsg').textContent;
      T(
        'pb-s22-win-arrow-along-wall',
        near(d1, 1 / 30.48, 1e-3) &&
          near(d2, 10 / 30.48, 1e-3) &&
          Math.abs(up) < 1e-9 &&
          near(stub, want6, 0.011) &&
          (!o36 || /点位挡着/.test(why6)),
        '→ ' +
          (d1 * 30.48).toFixed(2) +
          'cm · Shift+→ ' +
          (d2 * 30.48).toFixed(2) +
          'cm · ↑ 离开墙线 ' +
          up.toFixed(4) +
          'ft · 挪到头右边剩 ' +
          (stub * 30.48).toFixed(1) +
          'cm（应为 ' +
          (want6 * 30.48).toFixed(1) +
          'cm：' +
          (o36 ? '插座挡着' : '最短墙垛') +
          '）· 「' +
          why6.slice(0, 30) +
          '」'
      );

      /* 38.7 改宽（长 → 改这段）= 中心不动、两头的墙跟着伸缩（以前伸进相邻的墙里）；先挪回中间 */
      {
        const g = entById(w5.id).geom,
          kk = Math.round((((g.x1 + g.x2) / 2 - X - 8) * 30.48) / 10);
        for (let k = 0; k < kk; k++) key('ArrowLeft', null, true);
        await tick();
      }
      const g7 = Object.assign({}, entById(w5.id).geom),
        c7 = (g7.x1 + g7.x2) / 2;
      Q('#wLen').value = '150';
      Q('#wLenApply').click();
      await tick();
      const g7b = entById(w5.id).geom,
        gL7 = entById(wN.id).geom;
      const rt7 = (DOC.walls || []).find(
        (w) => w.src === 'user' && w.id !== wN.id && near(w.geom.y1, Y) && near(w.geom.y2, Y) && near(w.geom.x2, X + 16)
      );
      T(
        'pb-s22-win-width-follows-walls',
        near(g7b.x2 - g7b.x1, 150 / 30.48, 2e-3) &&
          near((g7b.x1 + g7b.x2) / 2, c7, 2e-3) &&
          near(gL7.x2, g7b.x1, 1e-4) &&
          !!rt7 &&
          near(rt7.geom.x1, g7b.x2, 1e-4),
        '宽 ' +
          ((g7b.x2 - g7b.x1) * 30.48).toFixed(1) +
          'cm · 中心 ' +
          ((g7b.x1 + g7b.x2) / 2 - c7).toFixed(4) +
          ' · 左墙贴着=' +
          near(gL7.x2, g7b.x1, 1e-4) +
          ' · 右墙贴着=' +
          (!!rt7 && near(rt7.geom.x1, g7b.x2, 1e-4))
      );

      /* 38.8 窗台 / 窗高：输入 90 / 150 → 实体 90 / 240；超出天花的组合被拒、数值不变 */
      Q('#wWinSill').value = '90';
      Q('#wWinSill').dispatchEvent(new Event('change'));
      Q('#wWinH').value = '150';
      Q('#wWinH').dispatchEvent(new Event('change'));
      await tick();
      const e8 = entById(w5.id);
      const okH = near(e8.sill * 30.48, 90, 0.6) && near(e8.head * 30.48, 240, 0.6) && !e8.fullHeight;
      Q('#wWinSill').value = '200';
      Q('#wWinSill').dispatchEvent(new Event('change'));
      await tick();
      const refused =
        near(entById(w5.id).sill * 30.48, 90, 0.6) &&
        /天花/.test(Q('#wMsg').textContent) &&
        Q('#wWinSill').value === '90';
      T(
        'pb-s22-win-sill-height',
        okH && refused,
        '窗台 ' +
          (e8.sill * 30.48).toFixed(1) +
          ' · 窗顶 ' +
          (e8.head * 30.48).toFixed(1) +
          ' · 200 + 150 被拒=' +
          refused
      );

      /* 38.9 3D：窗前一道水平射线——窗台以下打到墙、窗台与窗顶之间打到玻璃、窗顶以上打到墙 */
      setView('3d');
      await wait3D(80);
      three.staticGroup.updateMatrixWorld(true);
      const rc9 = new THREE.Raycaster();
      const cx9 = (entById(w5.id).geom.x1 + entById(w5.id).geom.x2) / 2;
      const hitAt = (yCm) => {
        rc9.set(new THREE.Vector3(cx9, yCm / 30.48, Y + 3), new THREE.Vector3(0, 0, -1));
        const h = rc9.intersectObjects(three.staticGroup.children, true).filter((x) => x.object.visible)[0];
        return h ? (h.object.material.transparent && h.object.material.opacity < 0.5 ? 'glass' : 'solid') : 'none';
      };
      const h9 = [hitAt(45), hitAt(165), hitAt(255)];
      setView('2d');
      await tick();
      T('pb-s22-win-3d-heights', h9.join(',') === 'solid,glass,solid', '离地 45 / 165 / 255cm → ' + h9.join(' / '));

      /* 38.10「在这段开窗」：选中东墙（12ft）→ 中点开一扇；再画一段 3ft 短墙选中它 → 整段换成窗 */
      await enterEdit();
      await setTool('select');
      await tap(X + 16, Y + 3);
      const btnShown = getComputedStyle(Q('#wOpenWin')).display !== 'none';
      Q('#wOpenWin').click();
      await tick();
      const wE2 = (DOC.windows || []).find(
        (w) => w.src === 'user' && near(w.geom.x1, X + 16) && near(w.geom.x2, X + 16)
      );
      const cE = wE2 ? (wE2.geom.y1 + wE2.geom.y2) / 2 - Y : NaN;
      const short = pushUserWall(X + 4, Y + 6, X + 7, Y + 6, 'w', wd);
      geoChanged();
      await tick();
      wallEdit.sel = { kind: 'w', id: short.id };
      updateWallBarFromSel();
      Q('#wOpenWin').click();
      await tick();
      const whole =
        (DOC.windows || []).some((w) => w.id === short.id) && !(DOC.walls || []).some((w) => w.id === short.id);
      T(
        'pb-s22-win-open-in-selected-wall',
        btnShown && !!wE2 && near(cE, 6, 1e-3) && whole,
        '按钮在=' + btnShown + ' · 东墙开窗中心 ' + cE.toFixed(3) + 'ft（中点 6）· 3ft 短墙整段换成窗=' + whole
      );

      /* 38.11 加门：点在实墙（南墙）上 = 先开门洞再放门（缺省 80cm），选中这扇门 */
      await setTool('door');
      const nD0 = (DOC.doors || []).length;
      await tap(X + 5, Y + 12);
      const dNew = (DOC.doors || [])[(DOC.doors || []).length - 1];
      const gap = (DOC.walls || []).find(
        (w) => w.kind === 'opening' && dNew && near(w.geom.x1, dNew.geom.x1) && near(w.geom.y1, dNew.geom.y1)
      );
      T(
        'pb-s22-door-on-solid-wall',
        (DOC.doors || []).length === nD0 + 1 &&
          !!gap &&
          near(Math.hypot(dNew.geom.x2 - dNew.geom.x1, dNew.geom.y2 - dNew.geom.y1), 80 / 30.48, 1e-3) &&
          wallEdit.sel &&
          wallEdit.sel.kind === 'door',
        '门 ' +
          nD0 +
          '→' +
          (DOC.doors || []).length +
          ' · 门洞在=' +
          !!gap +
          ' · 宽 ' +
          (dNew ? (Math.hypot(dNew.geom.x2 - dNew.geom.x1, dNew.geom.y2 - dNew.geom.y1) * 30.48).toFixed(1) : '?') +
          'cm'
      );

      /* 38.12 常用尺寸：选「卫生间高窗」→ 三个框填好；开出来的窗就是这个尺寸 */
      await setTool('win');
      Q('#waPreset').value = '60,140,60';
      Q('#waPreset').dispatchEvent(new Event('change'));
      const filled = Q('#waW').value === '60' && Q('#waSill').value === '140' && Q('#waH').value === '60';
      await tap(X + 3, Y + 12);
      const wb = entById(wallEdit.sel && wallEdit.sel.id);
      T(
        'pb-s22-win-preset',
        filled &&
          !!wb &&
          near(Math.hypot(wb.geom.x2 - wb.geom.x1, wb.geom.y2 - wb.geom.y1), 60 / 30.48, 1e-3) &&
          near(wb.sill * 30.48, 140, 0.6) &&
          near((wb.head - wb.sill) * 30.48, 60, 0.6),
        '框里 ' +
          [Q('#waW').value, Q('#waSill').value, Q('#waH').value].join(' / ') +
          ' · 开出来 ' +
          (wb && wb.geom
            ? (Math.hypot(wb.geom.x2 - wb.geom.x1, wb.geom.y2 - wb.geom.y1) * 30.48).toFixed(0) +
              'cm · 窗台 ' +
              (wb.sill * 30.48).toFixed(0)
            : '—')
      );
      Q('#waW').value = '120';
      Q('#waSill').value = '67';
      Q('#waH').value = '158';

      /* 38.12b 工具条的窗台 / 窗高也要过同一道关：窗台 300（天花 ~259）/ 窗台 240 + 窗高 158 → 不开窗、说明为什么、文档仍然合法
         （以前照开：窗台 300 / 窗顶 251 = 窗台高过窗顶，validate 判这份文档坏了 → 刷新后内置户型的改动被整份丢掉、
         自己画的户型「读不动」；240 + 158 则悄悄缩成 11cm 高的窗）；窗台 0 + 窗高顶到天花 = 落地窗，照开 */
      {
        await setTool('win');
        const nWin = (DOC.windows || []).length;
        const tryOpen = async (sill, h, at) => {
          Q('#waSill').value = String(sill);
          Q('#waH').value = String(h);
          await tap(at[0], at[1]);
          return {
            n: (DOC.windows || []).length,
            msg: Q('#wMsg').textContent,
            errs: SCHEMA.Project.validate(DOC).length,
          };
        };
        const r1 = await tryOpen(300, 158, [X + 12, Y + 12]);
        const r2 = await tryOpen(240, 158, [X + 12, Y + 12]);
        const r3 = await tryOpen(0, 300, [X + 12, Y + 12]);
        const wFull = (DOC.windows || [])[(DOC.windows || []).length - 1];
        T(
          'pb-s22-win-tool-heights-checked',
          r1.n === nWin &&
            /天花/.test(r1.msg) &&
            r2.n === nWin &&
            /天花/.test(r2.msg) &&
            r3.n === nWin + 1 &&
            !!wFull &&
            !!wFull.fullHeight &&
            r1.errs + r2.errs + r3.errs === 0,
          '窗台 300：开了 ' +
            (r1.n - nWin) +
            ' 扇「' +
            r1.msg.slice(0, 30) +
            '」 · 240 + 158：开了 ' +
            (r2.n - nWin) +
            ' 扇 · 0 + 300：开了 ' +
            (r3.n - nWin) +
            ' 扇（落地=' +
            !!(wFull && wFull.fullHeight) +
            '）· validate 报错 ' +
            (r1.errs + r2.errs + r3.errs)
        );
        Q('#waSill').value = '67';
        Q('#waH').value = '158';
        await setTool('select');
      }

      /* 38.13 #88 短墙垛（< 15cm，两个端点都在门端附近）：拖门离开它 = 墙垛伸长、远端（拐角）不动；拖回去 = 墙垛缩到最短为止、
         不钻进拐角的墙（以前两个端点都认成「跟着走」→ 整段平移：往外拖一步都拖不动，往里拖墙垛被推进拐角）。
         开窗时窗离墙端只留 ~5cm 的墙垛，这种短墙垛很常见 */
      await setTool('select');
      const Y13 = Y + 6; // 房间中间一道隔墙（视图只框地面，画在外面会出屏）
      pushUserWall(X + 1, Y13, X + 10, Y13, 'w', wd);
      pushUserWall(X + 10, Y13, X + 13, Y13, 'd', wd);
      const stub13 = pushUserWall(X + 13, Y13, X + 13.3, Y13, 'w', wd);
      pushUserWall(X + 13.3, Y13, X + 13.3, Y13 + 3, 'w', wd);
      const door13 = pushUserDoor(X + 10, Y13, X + 13, Y13);
      geoChanged();
      fit2DToContent();
      await tick();
      const dragDoor13 = async (dxFt) => {
        const dg = entById(door13.id).geom,
          [cx, cy] = SPT((dg.x1 + dg.x2) / 2, Y13),
          ppf = pxPerFtNow();
        fire('pointerdown', cx, cy);
        await tick();
        fire('pointermove', cx + (dxFt / 2) * ppf, cy);
        await tick();
        fire('pointermove', cx + dxFt * ppf, cy);
        await tick();
        fire('pointerup', cx + dxFt * ppf, cy);
        await tick();
      };
      await dragDoor13(-1);
      const sg13a = Object.assign({}, entById(stub13.id).geom),
        dg13a = Object.assign({}, entById(door13.id).geom);
      await dragDoor13(2);
      const sg13b = entById(stub13.id).geom,
        dg13b = entById(door13.id).geom;
      T(
        'pb-s22-door-short-stub-follows',
        near(dg13a.x1, X + 9, 0.02) &&
          near(sg13a.x1, dg13a.x2, 1e-4) &&
          near(sg13a.x2, X + 13.3, 1e-4) &&
          near(sg13b.x2, X + 13.3, 1e-4) &&
          near(sg13b.x1, dg13b.x2, 1e-4) &&
          near(sg13b.x2 - sg13b.x1, STUB_MIN, 0.011),
        '往外拖 1ft：门 ' +
          (dg13a.x1 - X).toFixed(3) +
          ' · 墙垛 ' +
          (sg13a.x1 - X).toFixed(3) +
          '→' +
          (sg13a.x2 - X).toFixed(3) +
          ' ｜ 往里拖 2ft：墙垛 ' +
          (sg13b.x1 - X).toFixed(3) +
          '→' +
          (sg13b.x2 - X).toFixed(3) +
          '（剩 ' +
          ((sg13b.x2 - sg13b.x1) * 30.48).toFixed(1) +
          'cm）'
      );

      /* 38.13b #89 门连窗：门旁边紧挨一扇平开窗（窗是门的联动墙垛之一）→ 拖门、半路 Esc → 窗回到原位、款式还是平开
         （回滚以前把整个视图写回去：窗视图的派生键 slider 把 style 改成 fixed——拖窗按 Esc 也是同一处） */
      {
        const Yb = Y + 10.5;
        pushUserWall(X + 1, Yb, X + 6, Yb, 'w', wd);
        pushUserWall(X + 6, Yb, X + 9, Yb, 'd', wd);
        const nwB = pushUserWindow(X + 9, Yb, X + 12, Yb, wd);
        nwB.style = 'casement';
        pushUserWall(X + 12, Yb, X + 15, Yb, 'w', wd);
        const drB = pushUserDoor(X + 6, Yb, X + 9, Yb);
        geoChanged();
        await tick();
        const [bx, by] = SPT(X + 7.5, Yb),
          ppfB = pxPerFtNow();
        fire('pointerdown', bx, by);
        await tick();
        fire('pointermove', bx - 0.5 * ppfB, by);
        await tick();
        fire('pointermove', bx - 1 * ppfB, by);
        await tick();
        const midB = [entById(drB.id).geom.x1 - X, nwB.geom.x1 - X];
        key('Escape');
        await tick();
        fire('pointerup', bx - 1 * ppfB, by, { buttons: 0 });
        await tick();
        T(
          'pb-s22-door-esc-keeps-window-style',
          near(midB[0], 5, 0.02) &&
            near(midB[1], 8, 0.02) &&
            near(nwB.geom.x1, X + 9, 1e-6) &&
            nwB.style === 'casement',
          '拖动中 门 x1=' +
            midB[0].toFixed(3) +
            ' · 窗跟着到 ' +
            midB[1].toFixed(3) +
            ' · Esc 后窗回到 ' +
            (nwB.geom.x1 - X).toFixed(3) +
            ' · 款式 ' +
            nwB.style
        );
      }

      /* 38.14 兜底：这一节做过的所有开窗 / 开门 / 滑动 / 改宽 / 改高之后，文档仍然过 validate
         （过不了 = 刷新后 loadDoc 不采用这份存档：内置户型的改动整份丢掉、自己画的户型「读不动」） */
      {
        const errs = SCHEMA.Project.validate(DOC);
        T(
          'pb-s22-doc-still-valid',
          errs.length === 0,
          errs.length
            ? errs
                .slice(0, 3)
                .map((e) => e.path + ' ' + e.message)
                .join(' ｜ ')
            : '0 条报错'
        );
      }

      /* 收尾：删掉这份户型 */
      await setTool('select');
      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      T(
        'pb-s22-clean-exit',
        PLAN_ID !== p38Plan && PLAN_REG.plans.length === p38Plans,
        'plans ' + p38Plans + '→' + PLAN_REG.plans.length
      );
    }

    /* ===== 39. S22a 内置墙上开窗：内置段隐藏、换成「墙｜窗｜墙」三段用户段（同厚、首尾接得上）；撤销一步回到原样 ===== */
    {
      await enterEdit();
      await pbReset();
      fit2DToContent();
      await tick();
      const near39 = (a, b, tol) => Math.abs(a - b) < (tol || 1e-3);
      let best = null;
      for (const sg of effWalls()) {
        if (sg.t !== 'w') continue;
        const e = entById(sg._id);
        if (!e || e.src === 'user' || !e.geom || e.geom.t !== 'seg') continue;
        const L = Math.hypot(sg.x2 - sg.x1, sg.y2 - sg.y1);
        if (L > 6 && (!best || L > best.L))
          best = { id: sg._id, L, g: Object.assign({}, e.geom), th: pbDrawnThick(sg) };
      }
      if (!best) {
        T('pb-s22-builtin-wall-window', false, '这份内置户型里找不到 6ft 以上的直线实墙');
      } else {
        const h0 = undoRing.length,
          nW0 = DOC.walls.length,
          nN0 = (DOC.windows || []).length,
          hid0 = DOC.hidden.walls.slice();
        await setTool('win');
        // 点在没有 T 口的最长那一截空当中间（内墙接过来的地方窗会自动让开——那是 40.6 的事）
        const jn = wallJunctions(
          entById(best.id),
          effWalls().find((q) => q._id === best.id)
        ).sort((p, q) => p[0] - q[0]);
        let gap = [0, 0],
          prev = 0;
        for (const iv of jn.concat([[best.L, best.L]])) {
          if (iv[0] - prev > gap[1] - gap[0]) gap = [prev, iv[0]];
          prev = Math.max(prev, iv[1]);
        }
        const tc = (gap[0] + gap[1]) / 2,
          ux39 = (best.g.x2 - best.g.x1) / best.L,
          uy39 = (best.g.y2 - best.g.y1) / best.L;
        const mx = best.g.x1 + ux39 * tc,
          my = best.g.y1 + uy39 * tc;
        await tap(mx, my);
        const win = entById(wallEdit.sel && wallEdit.sel.id);
        const uw = DOC.walls.filter((w) => w.src === 'user');
        const L1 = uw.find((w) => near39(w.geom.x1, best.g.x1) && near39(w.geom.y1, best.g.y1));
        const R1 = uw.find((w) => near39(w.geom.x2, best.g.x2) && near39(w.geom.y2, best.g.y2));
        const seg = (id) => effWalls().find((q) => q._id === id);
        const wg = win && win.geom;
        const chained =
          !!(L1 && R1 && wg) &&
          near39(L1.geom.x2, wg.x1, 1e-4) &&
          near39(L1.geom.y2, wg.y1, 1e-4) &&
          near39(R1.geom.x1, wg.x2, 1e-4) &&
          near39(R1.geom.y1, wg.y2, 1e-4);
        const thickOk =
          !!(L1 && R1 && win) &&
          near39(pbDrawnThick(seg(L1.id)), best.th, 1e-3) &&
          near39(pbDrawnThick(seg(R1.id)), best.th, 1e-3);
        const wLen = wg ? Math.hypot(wg.x2 - wg.x1, wg.y2 - wg.y1) : NaN;
        const centered = wg ? near39((wg.x1 + wg.x2) / 2, mx, 0.02) && near39((wg.y1 + wg.y2) / 2, my, 0.02) : false;
        const hiddenNow = DOC.hidden.walls.includes(best.id) && !effWalls().some((q) => q._id === best.id);
        const ok1 =
          !!win && isWinEnt(win) && hiddenNow && chained && thickOk && near39(wLen, 120 / 30.48, 2e-3) && centered;
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })
        );
        await tick();
        const back =
          DOC.walls.length === nW0 &&
          (DOC.windows || []).length === nN0 &&
          JSON.stringify(DOC.hidden.walls) === JSON.stringify(hid0) &&
          effWalls().some((q) => q._id === best.id) &&
          undoRing.length === h0;
        T(
          'pb-s22-builtin-wall-window',
          ok1 && back,
          '内置墙 ' +
            best.id +
            '（' +
            (best.L * 30.48).toFixed(0) +
            'cm）· 隐藏=' +
            hiddenNow +
            ' · 墙｜窗｜墙 接得上=' +
            chained +
            ' · 同厚=' +
            thickOk +
            ' · 窗 ' +
            (wLen * 30.48).toFixed(1) +
            'cm 居中=' +
            centered +
            ' · 撤销回原样=' +
            back
        );
        /* 39.2 W12 内置墙上开的窗删掉 = 墙封回去：同一处再开一扇 → Delete → 原内置墙那一整段由一段用户墙接上（首尾 = 原内置墙的两端）、
           内置墙仍然隐藏、窗不在了；Ctrl+Z 两次回到原样 */
        await setTool('win');
        await tap(mx, my);
        const h2 = undoRing.length;
        const selWin2 = !!wallEdit.sel && isWinEnt(entById(wallEdit.sel.id)); // 开完就选中它了
        key('Delete');
        await tick();
        const one = DOC.walls.filter(
          (w) =>
            w.src === 'user' &&
            ((near39(w.geom.x1, best.g.x1) &&
              near39(w.geom.y1, best.g.y1) &&
              near39(w.geom.x2, best.g.x2) &&
              near39(w.geom.y2, best.g.y2)) ||
              (near39(w.geom.x1, best.g.x2) &&
                near39(w.geom.y1, best.g.y2) &&
                near39(w.geom.x2, best.g.x1) &&
                near39(w.geom.y2, best.g.y1)))
        ).length;
        const closed2 =
          selWin2 &&
          one === 1 &&
          DOC.walls.filter((w) => w.src === 'user').length === 1 &&
          !(DOC.windows || []).some((w) => w.src === 'user') &&
          DOC.hidden.walls.includes(best.id) &&
          undoRing.length === h2 + 1;
        undoStep();
        await tick();
        undoStep();
        await tick();
        const back2 =
          DOC.walls.length === nW0 &&
          (DOC.windows || []).length === nN0 &&
          JSON.stringify(DOC.hidden.walls) === JSON.stringify(hid0) &&
          undoRing.length === h0;
        T(
          'pb-s22-builtin-wall-window-delete-closes',
          closed2 && back2,
          '选中窗=' +
            selWin2 +
            ' · 删后接上原内置墙两端的用户墙 ' +
            one +
            ' 段 · 内置墙仍隐藏=' +
            DOC.hidden.walls.includes(best.id) +
            ' · 撤两步回原样=' +
            back2
        );
        await setTool('select');
      }

      /* 39.3 W12 内置窗（两头接着共线的内置墙）删掉 = 墙封回去：窗那一截上每隔 5cm 取一点，删后都落在实墙里；窗被隐藏；Ctrl+Z 回去。
         以前 = 隐藏这扇窗、墙上留一个洞 */
      let bw = null;
      for (const sg of effWalls()) {
        if (sg.t !== 'g') continue;
        const e = entById(sg._id);
        if (!e || e.src === 'user') continue;
        const L = Math.hypot(sg.x2 - sg.x1, sg.y2 - sg.y1),
          u = [(sg.x2 - sg.x1) / L, (sg.y2 - sg.y1) / L];
        const touch = (P) =>
          effWalls().some(
            (q) =>
              (q.t === 'w' || q.t === 'i') &&
              [
                [q.x1, q.y1],
                [q.x2, q.y2],
              ].some((p) => Math.hypot(p[0] - P[0], p[1] - P[1]) < 2e-3) &&
              Math.abs(((q.x2 - q.x1) * u[1] - (q.y2 - q.y1) * u[0]) / (Math.hypot(q.x2 - q.x1, q.y2 - q.y1) || 1)) <
                1e-3
          );
        const n = (touch([sg.x1, sg.y1]) ? 1 : 0) + (touch([sg.x2, sg.y2]) ? 1 : 0);
        if (n && (!bw || n > bw.n)) bw = { id: sg._id, n, g: { x1: sg.x1, y1: sg.y1, x2: sg.x2, y2: sg.y2 }, L };
      }
      if (!bw) T('pb-s22-builtin-window-delete-closes', true, '这份内置户型没有接着共线墙的内置窗（不适用）');
      else {
        const h3 = undoRing.length,
          hidW0 = DOC.hidden.windows.slice();
        await setTool('select');
        await tap((bw.g.x1 + bw.g.x2) / 2, (bw.g.y1 + bw.g.y2) / 2);
        const selOk3 = !!wallEdit.sel && wallEdit.sel.id === bw.id;
        key('Delete');
        await tick();
        const solid = effWalls().filter((q) => q.t === 'w' || q.t === 'i');
        const onSolid = (p) =>
          solid.some((q) => {
            const dx = q.x2 - q.x1,
              dy = q.y2 - q.y1,
              L2 = dx * dx + dy * dy;
            if (L2 < 1e-9) return false;
            const t = Math.max(0, Math.min(1, ((p[0] - q.x1) * dx + (p[1] - q.y1) * dy) / L2));
            return Math.hypot(p[0] - (q.x1 + dx * t), p[1] - (q.y1 + dy * t)) < 1e-3;
          });
        let holes = 0;
        const nS = Math.max(2, Math.ceil((bw.L * 30.48) / 5));
        for (let i = 0; i <= nS; i++) {
          const t = i / nS;
          if (!onSolid([bw.g.x1 + (bw.g.x2 - bw.g.x1) * t, bw.g.y1 + (bw.g.y2 - bw.g.y1) * t])) holes++;
        }
        const closed3 =
          selOk3 &&
          holes === 0 &&
          DOC.hidden.windows.includes(bw.id) &&
          !effWalls().some((q) => q._id === bw.id) &&
          undoRing.length === h3 + 1;
        undoStep();
        await tick();
        const back3 =
          effWalls().some((q) => q._id === bw.id && q.t === 'g') &&
          JSON.stringify(DOC.hidden.windows) === JSON.stringify(hidW0);
        T(
          'pb-s22-builtin-window-delete-closes',
          closed3 && back3,
          '内置窗 ' +
            bw.id +
            '（' +
            (bw.L * 30.48).toFixed(0) +
            'cm，' +
            bw.n +
            ' 头接着共线墙）· 选中=' +
            selOk3 +
            ' · 删后窗那一截 ' +
            (nS + 1) +
            ' 个点里落空 ' +
            holes +
            ' 个 · Ctrl+Z 回来=' +
            back3
        );
      }
    }

    /* ===== 40. S22a 独立审查钓出的四件（先红后绿）：联动只认最近的端点、wallId 悬空、墙垛上的点位跟着窗漂、重置内置埋掉洞口 ===== */
    {
      await enterEdit();
      await pbReset();
      const p40Plans = PLAN_REG.plans.length;
      Q('#btnPlanNew').click();
      await tick();
      const p40Plan = PLAN_ID;
      const fp40 = floorPts();
      const X =
          Math.min.apply(
            null,
            fp40.map((p) => p[0])
          ) + 1,
        Y =
          Math.min.apply(
            null,
            fp40.map((p) => p[1])
          ) + 1;
      const wd = cmToWd(15);
      const near = (a, b, tol) => Math.abs(a - b) < (tol || 1e-3);
      const shiftKey = (k, n) => {
        for (let i = 0; i < n; i++) key(k, null, true);
      };
      await setTool('select');

      /* 40.1 审查：一面直墙是两段画的（A 0→8、C 8→16）；在 A 上靠右开窗 → 右边只剩 5.5cm 墙垛、C 的起点离窗端 5.5cm（< LINK_TOL）。
         窗往左挪 30cm：墙垛伸长、C 原地不动（以前 C 也被认成「跟着走」→ C 跟着窗左移、压进墙垛） */
      const A1 = pushUserWall(X, Y, X + 8, Y, 'w', wd);
      const C1 = pushUserWall(X + 8, Y, X + 16, Y, 'w', wd);
      geoChanged();
      await tick();
      const w1 = insertWindowAt([X + 7.5, Y]);
      await tick();
      const stub1 = () =>
        (DOC.walls || []).find(
          (w) =>
            w.src === 'user' && w.id !== A1.id && w.id !== C1.id && near(w.geom.y1, Y) && near(w.geom.x2, X + 8, 0.6)
        );
      const c0 = Object.assign({}, entById(C1.id).geom);
      shiftKey('ArrowLeft', 3);
      await tick();
      const g1 = entById(w1.id).geom,
        st1 = stub1(),
        cG = entById(C1.id).geom;
      T(
        'pb-s22r-link-nearest-end-only',
        !!st1 &&
          near(cG.x1, c0.x1, 1e-9) &&
          near(cG.x2, c0.x2, 1e-9) &&
          near(st1.geom.x1, g1.x2, 1e-4) &&
          near(st1.geom.x2, X + 8, 1e-4) &&
          near(c0.x1 - g1.x2 - (STUB_MIN + 30 / 30.48), 0, 0.01),
        '窗右端 ' +
          (g1.x2 - X).toFixed(3) +
          ' · 墙垛 ' +
          (st1 ? (st1.geom.x1 - X).toFixed(3) + '→' + (st1.geom.x2 - X).toFixed(3) : '没有') +
          ' · C 起点 ' +
          (cG.x1 - X).toFixed(3) +
          '（原 ' +
          (c0.x1 - X).toFixed(3) +
          '）'
      );

      /* 40.2 审查：同一个根因落在门上：门洞｜5.5cm 墙垛｜窗。门往远离窗的方向挪 → 墙垛伸长、窗不动
         （以前窗的端点离门端 5.5cm 也被认成跟着走 → 窗伸过来盖住墙垛） */
      const Y2 = Y + 6;
      pushUserWall(X + 1, Y2, X + 3, Y2, 'w', wd);
      pushUserWall(X + 3, Y2, X + 6, Y2, 'd', wd);
      const sb2 = pushUserWall(X + 6, Y2, X + 6 + STUB_MIN, Y2, 'w', wd);
      const wn2 = pushUserWindow(X + 6 + STUB_MIN, Y2, X + 9, Y2, wd);
      pushUserWall(X + 9, Y2, X + 14, Y2, 'w', wd);
      const dr2 = pushUserDoor(X + 3, Y2, X + 6, Y2);
      geoChanged();
      await tick();
      wallEdit.sel = { kind: 'door', id: dr2.id };
      updateWallBarFromSel();
      const dx0 = entById(dr2.id).geom.x2;
      shiftKey('ArrowLeft', 6);
      await tick();
      const dMoved = dx0 - entById(dr2.id).geom.x2,
        sg2 = entById(sb2.id).geom,
        wg2 = entById(wn2.id).geom;
      T(
        'pb-s22r-door-link-skips-window',
        dMoved > 0.1 &&
          near(sg2.x1, entById(dr2.id).geom.x2, 1e-4) &&
          near(sg2.x2, X + 6 + STUB_MIN, 1e-6) &&
          near(wg2.x1, X + 6 + STUB_MIN, 1e-6),
        '门左移 ' +
          (dMoved * 30.48).toFixed(1) +
          'cm · 墙垛 ' +
          (sg2.x1 - X).toFixed(3) +
          '→' +
          (sg2.x2 - X).toFixed(3) +
          ' · 窗起点 ' +
          (wg2.x1 - X).toFixed(3) +
          '（原 ' +
          (6 + STUB_MIN).toFixed(3) +
          '）'
      );

      /* 40.3 #90 墙垛上的点位不跟着窗漂：开窗时右段那个插座改挂到拆出来的右段（它的 x1 就是窗端）→ 窗挪了，at 从会动的那端量 →
         插座跟着窗平移。现在：窗挪 / 改宽，插座原地不动；窗也不能挪到压住插座（墙垛缩到插座那里就停） */
      const Y3 = Y + 10;
      const W3 = pushUserWall(X, Y3, X + 16, Y3, 'w', wd);
      geoChanged();
      await tick();
      const t3 = pbDrawnThick(effWalls().find((q) => q._id === W3.id));
      const ol3 = pushUserOutlet(pointSnap(X + 11.5, Y3 + t3 / 2 + 0.2, 'std', 'wall'), 'std', 1, null);
      syncOutlets();
      geoChanged();
      await tick();
      const pose3 = () => {
        const q = outletPose((DOC.outlets || []).find((o) => o.id === ol3.id));
        return q ? [q.x, q.y] : [NaN, NaN];
      };
      const w3 = insertWindowAt([X + 8, Y3]);
      await tick();
      const p30 = pose3();
      shiftKey('ArrowLeft', 5);
      await tick();
      const p31 = pose3();
      shiftKey('ArrowRight', 40);
      await tick();
      const p32 = pose3(),
        g3 = entById(w3.id).geom;
      const half3 = cmFt(ptDef('std').plate[0]) / 2;
      T(
        'pb-s22r-outlet-stays-when-window-moves',
        near(p31[0], p30[0], 2e-3) &&
          near(p31[1], p30[1], 2e-3) &&
          near(p32[0], p30[0], 2e-3) &&
          g3.x2 <= p30[0] - half3 + 1e-3,
        '插座 x ' +
          (p30[0] - X).toFixed(3) +
          ' → 窗左移 50cm 后 ' +
          (p31[0] - X).toFixed(3) +
          ' → 窗往右推到头 ' +
          (p32[0] - X).toFixed(3) +
          ' · 窗右端停在 ' +
          (g3.x2 - X).toFixed(3) +
          '（插座左沿 ' +
          (p30[0] - half3 - X).toFixed(3) +
          '）'
      );

      /* 40.4 #91 门 / 窗的 wallId 指着的墙被删掉 / 整段换成窗 → 文档仍过 validate（以前「引用不存在的墙」→ 刷新后整份存档不被采用。
         导入的户型里门窗都带 wallId） */
      const Y4 = Y + 3;
      const Wq = pushUserWall(X + 1, Y4, X + 4, Y4, 'w', wd);
      pushUserWall(X + 4, Y4, X + 7, Y4, 'd', wd);
      const Wr = pushUserWall(X + 7, Y4, X + 9, Y4, 'w', wd);
      const dq = pushUserDoor(X + 4, Y4, X + 7, Y4);
      dq.wallId = Wq.id;
      const nq = pushUserWindow(X + 9, Y4, X + 11, Y4, wd);
      nq.wallId = Wr.id;
      geoChanged();
      await tick();
      const e40a = SCHEMA.Project.validate(DOC).length;
      wallEdit.sel = { kind: 'w', id: Wq.id };
      updateWallBarFromSel();
      key('Delete');
      await tick();
      const e40b = SCHEMA.Project.validate(DOC);
      wallEdit.sel = { kind: 'w', id: Wr.id };
      updateWallBarFromSel();
      Q('#wType').value = 'g';
      Q('#wType').dispatchEvent(new Event('change'));
      await tick();
      const e40c = SCHEMA.Project.validate(DOC);
      T(
        'pb-s22r-dangling-wallid-cleared',
        e40a === 0 &&
          e40b.length === 0 &&
          e40c.length === 0 &&
          entById(dq.id).wallId == null &&
          entById(nq.id).wallId == null,
        '起始报错 ' +
          e40a +
          ' · 删掉门的宿主墙后 ' +
          (e40b.length ? e40b[0].path + ' ' + e40b[0].message : '0') +
          ' · 窗的宿主墙换成窗后 ' +
          (e40c.length ? e40c[0].path + ' ' + e40c[0].message : '0')
      );

      /* 40.6 审查 #9 T 口：一面墙中间接过来一道内墙（T 口在 8ft）→ 在 T 口上点「加窗」/「加门」：洞口让到 T 口一侧、不跨过它；
         预览跟开出来的一样（以前照开：内墙顶在玻璃上 / 门洞里） */
      const Y6 = Y + 1.5;
      const W6 = pushUserWall(X, Y6, X + 16, Y6, 'w', wd);
      pushUserWall(X + 8, Y6, X + 8, Y6 + 1.4, 'w', wd);
      geoChanged();
      await tick();
      const half6 = pbDrawnThick(effWalls().find((q) => q._id === W6.id)) / 2;
      const clearOfT = (g) =>
        Math.min(g.x1, g.x2) >= X + 8 + half6 - 1e-6 || Math.max(g.x1, g.x2) <= X + 8 - half6 + 1e-6;
      await setTool('win');
      const [hx6, hy6] = SPT(X + 8.05, Y6);
      fire('pointermove', hx6, hy6, { buttons: 0 });
      await tick();
      const pv6 = wallEdit.winPreview ? { a: wallEdit.winPreview.a, b: wallEdit.winPreview.b } : null;
      const w6 = insertWindowAt([X + 8.05, Y6]);
      await tick();
      const g6 = w6 && entById(w6.id).geom;
      const sameAsPreview =
        !!pv6 &&
        !!g6 &&
        near(Math.min(g6.x1, g6.x2) - X, pv6.a, 0.011) &&
        near(Math.max(g6.x1, g6.x2) - X, pv6.b, 0.011);
      await setTool('door');
      const d6 = insertDoorAt([X + 7.9, Y6]);
      await tick();
      const gd6 = d6 && d6 !== 'refused' ? entById(d6.id).geom : null;
      T(
        'pb-s22r-opening-avoids-t-junction',
        !!g6 && clearOfT(g6) && sameAsPreview && !!gd6 && clearOfT(gd6),
        '窗 ' +
          (g6 ? (Math.min(g6.x1, g6.x2) - X).toFixed(2) + '→' + (Math.max(g6.x1, g6.x2) - X).toFixed(2) : '没开') +
          '（预览 ' +
          (pv6 ? pv6.a.toFixed(2) + '→' + pv6.b.toFixed(2) : '无') +
          '）· 门 ' +
          (gd6
            ? (Math.min(gd6.x1, gd6.x2) - X).toFixed(2) + '→' + (Math.max(gd6.x1, gd6.x2) - X).toFixed(2)
            : String(d6)) +
          ' · T 口在 8.00 ± ' +
          half6.toFixed(2)
      );

      /* 40.7 审查 #5 两个拐角之间整段换成的窗（两头没有能跟着伸缩的墙）：「长」改窄 = 窗居中缩、两头补上墙（窗那一截没有洞）；
         改宽 = 拒、几何不变（以前照样对称伸缩：改窄两头留缝、加宽伸进拐角的墙） */
      const Y7 = Y + 8;
      pushUserWall(X + 2, Y7 - 1, X + 2, Y7, 'w', wd);
      const W7 = pushUserWall(X + 2, Y7, X + 12, Y7, 'w', wd);
      pushUserWall(X + 12, Y7, X + 12, Y7 - 1, 'w', wd);
      geoChanged();
      await tick();
      wallEdit.sel = { kind: 'w', id: W7.id };
      Q('#wType').value = 'g';
      Q('#wType').dispatchEvent(new Event('change'));
      await tick();
      wallEdit.sel = { kind: 'w', id: W7.id };
      updateWallBarFromSel();
      const g70 = Object.assign({}, entById(W7.id).geom);
      Q('#wLen').value = '400';
      Q('#wLenApply').click();
      await tick();
      const wider =
        JSON.stringify(entById(W7.id).geom) === JSON.stringify(g70) && /宽不了/.test(Q('#wMsg').textContent);
      Q('#wLen').value = '150';
      Q('#wLenApply').click();
      await tick();
      const g71 = entById(W7.id).geom;
      const solid7 = effWalls().filter((q) => q.t === 'w' || q.t === 'g');
      let holes7 = 0;
      for (let i = 0; i <= 40; i++) {
        const px = X + 2 + (10 * i) / 40;
        if (
          !solid7.some(
            (q) =>
              near(q.y1, Y7) && near(q.y2, Y7) && px >= Math.min(q.x1, q.x2) - 1e-4 && px <= Math.max(q.x1, q.x2) + 1e-4
          )
        )
          holes7++;
      }
      T(
        'pb-s22r-whole-window-narrow-fills-walls',
        wider &&
          near(Math.abs(g71.x2 - g71.x1), 150 / 30.48, 2e-3) &&
          near((g71.x1 + g71.x2) / 2, X + 7, 2e-3) &&
          holes7 === 0,
        '改宽被拒=' +
          wider +
          ' · 改窄后窗 ' +
          (Math.abs(g71.x2 - g71.x1) * 30.48).toFixed(1) +
          'cm 中心 ' +
          ((g71.x1 + g71.x2) / 2 - X).toFixed(3) +
          ' · 这面墙 41 个点里落空 ' +
          holes7 +
          ' 个'
      );

      /* 40.8 审查 #10 加窗工具条填 0：宽 0 / 窗高 0 都不开、说为什么（以前 0 被悄悄换成缺省 120 / 158） */
      await setTool('win');
      const nW8 = (DOC.windows || []).length;
      Q('#waW').value = '0';
      insertWindowAt([X + 13.5, Y6]); // W6 右边那截实墙
      const m8a = Q('#wMsg').textContent;
      Q('#waW').value = '120';
      Q('#waH').value = '0';
      insertWindowAt([X + 13.5, Y6]);
      const m8b = Q('#wMsg').textContent;
      Q('#waH').value = '158';
      T(
        'pb-s22r-zero-size-refused',
        (DOC.windows || []).length === nW8 && /20cm 宽/.test(m8a) && /窗高至少 20cm/.test(m8b),
        '开了 ' + ((DOC.windows || []).length - nW8) + ' 扇 · 「' + m8a.slice(0, 24) + '」「' + m8b.slice(0, 24) + '」'
      );

      /* 40.9 审查 #7 / #8 撤销之后工具条跟着回去（没选中就不该还亮着「在这段开窗」）；没选中时点它也要说一句；
         选中的窗按垂直于墙的方向键 = 提示「只能沿着墙挪」（以前什么都不发生） */
      await setTool('select');
      wallEdit.sel = { kind: 'w', id: W6.id };
      updateWallBarFromSel();
      const btnBefore = getComputedStyle(Q('#wOpenWin')).display !== 'none';
      undoStep();
      await tick();
      const btnAfter = getComputedStyle(Q('#wOpenWin')).display !== 'none';
      openWindowInSel();
      const m9a = Q('#wMsg').textContent;
      const w9 = (DOC.windows || []).find((w) => w.src === 'user' && near(w.geom.y1, Y6) && near(w.geom.y2, Y6));
      if (w9) {
        wallEdit.sel = { kind: 'w', id: w9.id };
        updateWallBarFromSel();
      }
      key('ArrowUp');
      await tick();
      const m9b = Q('#wMsg').textContent;
      T(
        'pb-s22r-undo-refreshes-bar-and-hints',
        btnBefore && !btnAfter && /先选中一段实墙/.test(m9a) && !!w9 && /只能沿着墙挪/.test(m9b),
        '撤销前按钮在=' +
          btnBefore +
          ' · 撤销后=' +
          btnAfter +
          ' · 没选中点它「' +
          m9a.slice(0, 16) +
          '」 · ↑「' +
          m9b.slice(0, 20) +
          '」'
      );

      /* 40.10 审查 #6「在这段开窗」碰上比窗还短的墙 = 整段换成窗：上面的点位一起去掉，提示里说个数（以前不说） */
      const W10 = pushUserWall(X + 13, Y + 4.5, X + 15, Y + 4.5, 'w', wd); // 空地方（别和 40.2 那道墙叠着）
      geoChanged();
      await tick();
      const t10 = pbDrawnThick(effWalls().find((q) => q._id === W10.id));
      pushUserOutlet(pointSnap(X + 14, Y + 4.5 + t10 / 2 + 0.2, 'std', 'wall'), 'std', 1, null);
      syncOutlets();
      geoChanged();
      wallEdit.sel = { kind: 'w', id: W10.id };
      updateWallBarFromSel();
      openWindowInSel();
      const m10 = Q('#wMsg').textContent;
      T(
        'pb-s22r-whole-convert-says-outlets',
        /整段换成了窗/.test(m10) && /1 个点位/.test(m10),
        '「' + m10.slice(0, 50) + '」'
      );

      /* 收尾：删掉这份户型 */
      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      T(
        'pb-s22r-clean-exit',
        PLAN_ID !== p40Plan && PLAN_REG.plans.length === p40Plans,
        'plans ' + p40Plans + '→' + PLAN_REG.plans.length
      );

      /* 40.5 审查：内置户型：在内置墙上开一扇窗 →「重置内置」→ 这面内置墙完整回来、拆出来的墙垛 / 窗不在了（以前它们是「用户新增」被留下：
         原墙穿过窗洞重新出现，3D 里窗被墙挡住、墙垛与原墙重叠） */
      await enterEdit();
      await pbReset();
      let bw5 = null;
      for (const sg of effWalls()) {
        if (sg.t !== 'w') continue;
        const e = entById(sg._id);
        if (!e || e.src === 'user' || !e.geom || e.geom.t !== 'seg') continue;
        const L = Math.hypot(sg.x2 - sg.x1, sg.y2 - sg.y1);
        if (L > 6 && (!bw5 || L > bw5.L)) bw5 = { id: sg._id, L, g: Object.assign({}, e.geom) };
      }
      const r5 = undoRing.length;
      const w5 = insertWindowAt([(bw5.g.x1 + bw5.g.x2) / 2, (bw5.g.y1 + bw5.g.y2) / 2]);
      await tick();
      const cf = window.confirm;
      window.confirm = () => true;
      Q('#wRestore').click();
      await tick();
      window.confirm = cf;
      const onLine = (q) => {
        const g = q.geom || q,
          dx = bw5.g.x2 - bw5.g.x1,
          dy = bw5.g.y2 - bw5.g.y1,
          L = Math.hypot(dx, dy);
        const off = (x, y) => Math.abs((x - bw5.g.x1) * dy - (y - bw5.g.y1) * dx) / L;
        return off(g.x1, g.y1) < 2e-3 && off(g.x2, g.y2) < 2e-3;
      };
      const leftovers =
        (DOC.walls || []).filter((w) => w.src === 'user' && onLine(w)).length +
        (DOC.windows || []).filter((w) => w.src === 'user' && onLine(w)).length;
      const whole = effWalls().some((q) => q._id === bw5.id && q.t === 'w');
      T(
        'pb-s22r-restore-builtins-drops-split-pieces',
        !!w5 && whole && leftovers === 0 && !(DOC.windows || []).some((w) => w.id === w5.id),
        '内置墙 ' + bw5.id + ' 回来=' + whole + ' · 这条墙线上剩下的用户墙 / 窗 ' + leftovers + ' 段'
      );
      while (undoRing.length > r5) {
        undoStep();
        await tick();
      }
      await setTool('select');
    }

    /* ===== 41. S22b 窗的款式与外观：提拉 / 内开内倒 / 平开左右开 / 推拉 3·4 扇、框色色板、磨砂玻璃；推拉 / 上悬 2D 符号画在窗边 ===== */
    {
      await enterEdit();
      await pbReset();
      const p41Plans = PLAN_REG.plans.length;
      Q('#btnPlanNew').click();
      await tick();
      const p41Plan = PLAN_ID;
      const fp41 = floorPts();
      const X =
          Math.min.apply(
            null,
            fp41.map((p) => p[0])
          ) + 1,
        Y =
          Math.min.apply(
            null,
            fp41.map((p) => p[1])
          ) + 1;
      const wd = cmToWd(15);
      const near = (a, b, tol) => Math.abs(a - b) < (tol || 1e-3);
      pushUserWall(X, Y, X + 6, Y, 'w', wd);
      const w41 = pushUserWindow(X + 6, Y, X + 10, Y, wd); // 北墙上一扇 4ft 的窗（x1 在西、室内在南）
      pushUserWall(X + 10, Y, X + 16, Y, 'w', wd);
      pushUserWall(X + 16, Y, X + 16, Y + 12, 'w', wd);
      pushUserWall(X + 16, Y + 12, X, Y + 12, 'w', wd);
      pushUserWall(X, Y + 12, X, Y, 'w', wd);
      geoChanged();
      fit2DToContent();
      await tick();
      await setTool('select');
      wallEdit.sel = { kind: 'w', id: w41.id };
      updateWallBarFromSel();
      const half41 = pbDrawnThick(effWalls().find((q) => q.t === 'w' && near(q.y1, Y) && near(q.y2, Y))) / 2; // 同一面墙的墙皮（窗段不进墙多边形）
      const setSel = async (sel, v) => {
        const e = Q(sel);
        e.value = v;
        e.dispatchEvent(new Event('change'));
        await tick();
      };
      // 这扇窗附近的蓝色符号（ft 坐标，相对窗）
      const symsNear = () => {
        const out = { lines: [], paths: [] };
        for (const l of pbSvg.querySelectorAll('line')) {
          if (l.getAttribute('stroke') !== '#5f9fd8') continue;
          const a = [+l.getAttribute('x1') / S - X, +l.getAttribute('y1') / S - Y],
            b = [+l.getAttribute('x2') / S - X, +l.getAttribute('y2') / S - Y];
          if (Math.max(a[0], b[0]) < 5 || Math.min(a[0], b[0]) > 11 || Math.min(Math.abs(a[1]), Math.abs(b[1])) > 6)
            continue;
          out.lines.push([a, b]);
        }
        for (const q of pbSvg.querySelectorAll('path'))
          if (q.getAttribute('stroke') === '#5f9fd8') out.paths.push(q.getAttribute('d'));
        return out;
      };

      /* 41.1 款式下拉的每一个值 → 文档字段；换一次 = 一步撤销，选回同一个值不占步；文档过 validate */
      const want = {
        fixed: ['fixed', undefined, undefined],
        slide: ['slide', undefined, undefined],
        'slide:3': ['slide', 3, undefined],
        'slide:4': ['slide', 4, undefined],
        casement: ['casement', undefined, undefined],
        'casement:l': ['casement', undefined, 'l'],
        'casement:r': ['casement', undefined, 'r'],
        tilt: ['tilt', undefined, undefined],
        'tilt:r': ['tilt', undefined, 'r'],
        hung: ['hung', undefined, undefined],
        awning: ['awning', undefined, undefined],
      };
      const opts = Array.from(Q('#wWinStyle').options).map((o) => o.value);
      let bad = [];
      for (const k of opts) {
        const h0 = undoRing.length;
        await setSel('#wWinStyle', k);
        const e = entById(w41.id),
          wv = want[k];
        if (!wv || e.style !== wv[0] || e.panes !== wv[1] || e.hand !== wv[2] || Q('#wWinStyle').value !== k)
          bad.push(k);
        const h1 = undoRing.length;
        await setSel('#wWinStyle', k);
        if (undoRing.length !== h1 || (k !== 'fixed' && h1 !== h0 + 1)) bad.push(k + '(撤销步)');
      }
      T(
        'pb-s22b-style-dropdown',
        opts.length === 11 && bad.length === 0 && SCHEMA.Project.validate(DOC).length === 0,
        opts.length + ' 个选项 · 不对的 ' + JSON.stringify(bad) + ' · validate ' + SCHEMA.Project.validate(DOC).length
      );

      /* 41.2 #92 推拉 / 上悬的 2D 符号画在窗边（以前偏移多乘了一个 S：推拉那道线画到窗外 9.6ft、上悬刻度横跨 11.5ft）；3 / 4 扇多出扇缝刻度 */
      await setSel('#wWinStyle', 'slide');
      const s2 = symsNear().lines;
      const off2 = s2.length ? Math.abs(s2[0][0][1]) : NaN;
      await setSel('#wWinStyle', 'slide:4');
      const s4 = symsNear().lines;
      await setSel('#wWinStyle', 'awning');
      const sa = symsNear().lines,
        tickLen = sa.length ? Math.max(...sa.map((l) => Math.hypot(l[1][0] - l[0][0], l[1][1] - l[0][1]))) : NaN;
      T(
        'pb-s22b-2d-slide-awning-near-window',
        s2.length === 1 && off2 > half41 && off2 < half41 + 0.5 && s4.length === 4 && sa.length === 2 && tickLen < 1,
        '推拉线离墙线 ' +
          off2.toFixed(2) +
          'ft（墙皮 ' +
          half41.toFixed(2) +
          'ft）· 4 扇 ' +
          s4.length +
          ' 道 · 上悬刻度 ' +
          sa.length +
          ' 道、最长 ' +
          tickLen.toFixed(2) +
          'ft'
      );

      /* 41.3 平开左 / 右开、内开内倒：铰链在「站在室内看」的左 / 右（窗在北墙、室内在南：左 = 西端），扇开向室内；内开内倒多一个往里的虚线三角；
         提拉 = 窗两侧各一道细线；磨砂 = 玻璃线上一道点虚线 */
      const leaf = () => {
        const L = symsNear().lines.filter((l) => Math.hypot(l[1][0] - l[0][0], l[1][1] - l[0][1]) > 3);
        return L.length ? L[0] : null;
      };
      await setSel('#wWinStyle', 'casement:l');
      const lL = leaf();
      await setSel('#wWinStyle', 'casement:r');
      const lR = leaf();
      await setSel('#wWinStyle', 'tilt');
      const pT = symsNear().paths.length,
        chev = Array.from(pbSvg.querySelectorAll('path[stroke-dasharray="2 1.5"]')).length;
      await setSel('#wWinStyle', 'hung');
      const hg = symsNear().lines;
      const okHand =
        !!lL &&
        near(lL[0][0], 6, 0.01) &&
        lL[1][1] > 0.5 &&
        !!lR &&
        near(lR[0][0], 10, 0.01) &&
        lR[1][1] > 0.5 &&
        pT >= 2 &&
        chev === 1;
      const okHung = hg.length === 2 && hg.every((l) => near(l[0][1], l[1][1], 1e-6)) && hg[0][0][1] * hg[1][0][1] < 0;
      Q('#wWinFrost').click();
      await tick();
      const frostLine = Array.from(pbSvg.querySelectorAll('line[stroke="#f4f7fa"]')).length;
      T(
        'pb-s22b-2d-hand-tilt-hung-frost',
        okHand && okHung && frostLine === 1 && entById(w41.id).frost === true,
        '左开铰链 x=' +
          (lL ? lL[0][0].toFixed(2) : '?') +
          '（西端 6）扇尖 y=' +
          (lL ? lL[1][1].toFixed(2) : '?') +
          ' · 右开铰链 x=' +
          (lR ? lR[0][0].toFixed(2) : '?') +
          '（东端 10）· 内倒三角 ' +
          chev +
          ' · 提拉两侧线 ' +
          hg.length +
          ' · 磨砂点虚线 ' +
          frostLine
      );

      /* 41.4 3D：磨砂玻璃不透明度 0.6（光追走「透明 + 粗糙」）；左开的把手在东端（铰链对面）；木框哑光；
         提拉 = 窗中间一道交接横档（窗正中、半高处一道水平射线打到框，不是玻璃）；推拉 3 扇 = 1/3、2/3 处有扇框竖梃挡着 */
      const ray41 = (t, yFt) => {
        three.staticGroup.updateMatrixWorld(true);
        const rc = new THREE.Raycaster();
        rc.set(new THREE.Vector3(X + 6 + 4 * t, curElev() + yFt, Y + 3), new THREE.Vector3(0, 0, -1));
        const h = rc.intersectObjects(three.staticGroup.children, true).filter((x) => x.object.visible)[0];
        return h ? (h.object.material.transparent && h.object.material.opacity < 0.75 ? 'glass' : 'solid') : 'none';
      };
      const midY41 = () => {
        const e = entById(w41.id);
        return (e.sill + e.head) / 2;
      };
      await setSel('#wWinStyle', 'casement:l');
      await setSel('#wWinFrame', '#b48a5a');
      setView('3d');
      await wait3D(80);
      three.staticGroup.updateMatrixWorld(true);
      let glass = null,
        handle = null;
      three.staticGroup.traverse((o) => {
        if (!o.isMesh || !o.visible) return;
        const p = new THREE.Vector3();
        o.getWorldPosition(p);
        if (!(p.x > X + 5.9 && p.x < X + 10.1 && Math.abs(p.z - Y) < 0.6)) return;
        if (o.material && o.material.transparent && !glass) glass = o;
        const g = o.geometry && o.geometry.parameters;
        if (g && near(g.width, 0.05, 1e-6) && near(g.height, 0.5, 1e-6)) handle = o;
      });
      const hx = handle ? (handle.getWorldPosition(new THREE.Vector3()).x - X - 6) / 4 : NaN;
      const fr = handle && handle.material;
      const fixedMid = await (async () => {
        setView('2d');
        await tick();
        await setSel('#wWinStyle', 'fixed');
        setView('3d');
        await wait3D(80);
        return ray41(0.5, midY41());
      })();
      setView('2d');
      await tick();
      await setSel('#wWinStyle', 'hung');
      setView('3d');
      await wait3D(80);
      const hungMid = ray41(0.5, midY41()),
        hungLow = ray41(0.5, midY41() - 0.8);
      setView('2d');
      await tick();
      await setSel('#wWinStyle', 'slide:3');
      setView('3d');
      await wait3D(80);
      const sl3 = [ray41(1 / 3, midY41()), ray41(2 / 3, midY41()), ray41(1 / 6, midY41())];
      setView('2d');
      await tick();
      T(
        'pb-s22b-3d-frost-hung-hand-panes-wood',
        !!glass &&
          near(glass.material.opacity, 0.6, 1e-6) &&
          !!handle &&
          hx > 0.85 &&
          !!fr &&
          near(fr.roughness, 0.62, 1e-6) &&
          fr.metalness === 0 &&
          fixedMid === 'glass' &&
          hungMid === 'solid' &&
          hungLow === 'glass' &&
          sl3.join(',') === 'solid,solid,glass',
        '磨砂不透明度 ' +
          (glass ? glass.material.opacity : '?') +
          ' · 左开把手在 t=' +
          hx.toFixed(2) +
          ' · 木框粗糙度 ' +
          (fr ? fr.roughness : '?') +
          ' / 金属感 ' +
          (fr ? fr.metalness : '?') +
          ' · 正中半高：固定 ' +
          fixedMid +
          ' / 提拉 ' +
          hungMid +
          '（下扇中间 ' +
          hungLow +
          '）· 推拉 3 扇 1/3、2/3、1/6：' +
          sl3.join(' / ')
      );

      /* 41.5 框色色板：5 色；黑框 = 钢框（与以前的「黑钢框」同一口径）；选回同色不占撤销步；磨砂开关一步撤销 */
      const fopts = Array.from(Q('#wWinFrame').options).map((o) => o.value);
      await setSel('#wWinFrame', '#17181b');
      const blk = entById(w41.id).frame === '#17181b' && entById(w41.id).steel === true;
      const h5 = undoRing.length;
      await setSel('#wWinFrame', '#17181b');
      const same = undoRing.length === h5;
      await setSel('#wWinFrame', '#5b3a24');
      const wal = entById(w41.id).frame === '#5b3a24' && entById(w41.id).steel === false;
      const h6 = undoRing.length;
      Q('#wWinFrost').click();
      await tick();
      const frostOff =
        !entById(w41.id).frost && undoRing.length === h6 + 1 && Q('#wWinFrost').textContent === '透明玻璃';
      T(
        'pb-s22b-frame-palette-frost',
        fopts.length === 5 && blk && same && wal && frostOff,
        fopts.join(' ') +
          ' · 黑框 = 钢框 ' +
          blk +
          ' · 同色不占步 ' +
          same +
          ' · 胡桃 ' +
          wal +
          ' · 磨砂关掉 ' +
          frostOff
      );

      /* 41.6 加窗工具条的款式带到新开的窗上（内开内倒右）；文档过 validate */
      await setTool('win');
      Q('#waStyle').value = 'tilt:r';
      const nw = insertWindowAt([X + 12.5, Y + 12]);
      await tick();
      const e6 = nw && entById(nw.id);
      Q('#waStyle').value = 'fixed';
      await setTool('select');
      T(
        'pb-s22b-tool-style-carried',
        !!e6 && e6.style === 'tilt' && e6.hand === 'r' && SCHEMA.Project.validate(DOC).length === 0,
        e6 ? e6.style + ' / ' + e6.hand + ' · validate ' + SCHEMA.Project.validate(DOC).length : '没开出来'
      );

      /* 收尾：删掉这份户型 */
      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      T(
        'pb-s22b-clean-exit',
        PLAN_ID !== p41Plan && PLAN_REG.plans.length === p41Plans,
        'plans ' + p41Plans + '→' + PLAN_REG.plans.length
      );
    }

    /* ===== 42. S23 键鼠统一：平面图里的每一条规则（research/12 §B.4），含「不该有效果」的反例 ===== */
    {
      await enterEdit();
      await pbReset();
      const p42Plans = PLAN_REG.plans.length;
      Q('#btnPlanNew').click();
      await tick();
      const p42Plan = PLAN_ID;
      const fp42 = floorPts();
      const X =
          Math.min.apply(
            null,
            fp42.map((p) => p[0])
          ) + 1,
        Y =
          Math.min.apply(
            null,
            fp42.map((p) => p[1])
          ) + 1;
      const wd = cmToWd(15);
      const near = (a, b, tol) => Math.abs(a - b) < (tol || 1e-6);
      const kd = (k, o) =>
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, o || {}))
        );
      const wN42 = pushUserWall(X, Y, X + 16, Y, 'w', wd);
      pushUserWall(X + 16, Y, X + 16, Y + 12, 'w', wd);
      pushUserWall(X + 16, Y + 12, X, Y + 12, 'w', wd);
      pushUserWall(X, Y + 12, X, Y, 'w', wd);
      geoChanged();
      fit2DToContent();
      await tick();
      const ctmA = () => pbSvg.getScreenCTM().a;

      /* 42.1 ? = 快捷键面板（从 INPUT_MAP 生成：一行一条、文字一致）；再按 ? / Esc 关；开着的时候键盘归它（按 D 不平移图纸） */
      kd('?');
      await tick();
      const open1 = getComputedStyle(Q('#keysModal')).display !== 'none';
      const rows = Array.from(Q('#keysBody').querySelectorAll('.kr'));
      const sameRows = rows.length === INPUT_MAP.length && rows.every((r, i) => r.textContent.includes(INPUT_MAP[i].a));
      const vx1 = vb.x;
      kd('d');
      await tick();
      const blocked = vb.x === vx1;
      kd('Escape');
      await tick();
      const closedEsc = getComputedStyle(Q('#keysModal')).display === 'none';
      kd('?');
      kd('?');
      await tick();
      const closedQ = getComputedStyle(Q('#keysModal')).display === 'none';
      // 底部提示行末尾的「? 全部快捷键」：#hint 整块 pointer-events:none，链接自己得接得住点击（光标下最上层就是它）
      if (wallEdit.on) Q('#btnWallEdit').click();
      await tick();
      const lk = Q('#hint .keysLink'),
        lr = lk ? lk.getBoundingClientRect() : null;
      const topEl = lr ? document.elementFromPoint(lr.x + lr.width / 2, lr.y + lr.height / 2) : null;
      if (topEl) topEl.click();
      await tick();
      const linkOpens = !!lk && topEl === lk && getComputedStyle(Q('#keysModal')).display !== 'none';
      kd('Escape');
      await tick();
      Q('#btnWallEdit').click();
      await tick();
      T(
        'pb-s23-keys-panel',
        open1 && sameRows && blocked && closedEsc && closedQ && linkOpens,
        '开=' +
          open1 +
          ' · ' +
          rows.length +
          ' 行 = INPUT_MAP ' +
          INPUT_MAP.length +
          ' 条、文字一致=' +
          sameRows +
          ' · 开着按 D 不平移=' +
          blocked +
          ' · Esc 关=' +
          closedEsc +
          ' · 再按 ? 关=' +
          closedQ +
          ' · 提示行的链接点得开=' +
          linkOpens
      );

      /* 42.2 WASD = 平移图纸（60 屏幕像素一下，Shift ×3）；摆家具 / 编辑墙体两个模式一样；F = 回到全貌 */
      const pan = async (k, sh) => {
        const x0 = vb.x,
          y0 = vb.y;
        kd(k, { shiftKey: !!sh });
        await tick();
        return [(vb.x - x0) * ctmA(), (vb.y - y0) * ctmA()];
      };
      const pd = await pan('d'),
        pw = await pan('w'),
        pa = await pan('a', true),
        ps = await pan('s');
      if (wallEdit.on) Q('#btnWallEdit').click();
      await tick();
      const pdF = await pan('d');
      Q('#btnWallEdit').click();
      await tick();
      const okWasd =
        near(pd[0], 60, 0.5) &&
        near(pd[1], 0) &&
        near(pw[1], -60, 0.5) &&
        near(pa[0], -180, 0.5) &&
        near(ps[1], 60, 0.5) &&
        near(pdF[0], 60, 0.5);
      fit2DToContent();
      const fitVb = [vb.x, vb.y, vb.w, vb.h];
      await pan('d', true);
      kd('f');
      await tick();
      const okF = near(vb.x, fitVb[0], 1e-6) && near(vb.y, fitVb[1], 1e-6) && near(vb.w, fitVb[2], 1e-6);
      T(
        'pb-s23-wasd-pan-f-frame',
        okWasd && okF,
        'D ' +
          pd.map((v) => v.toFixed(0)) +
          ' · W ' +
          pw.map((v) => v.toFixed(0)) +
          ' · Shift+A ' +
          pa.map((v) => v.toFixed(0)) +
          ' · S ' +
          ps.map((v) => v.toFixed(0)) +
          ' · 摆家具模式 D ' +
          pdF[0].toFixed(0) +
          'px · F 回到全貌=' +
          okF
      );

      /* 42.3 方向键挪家具 1cm / Shift 10cm（以前 7.6cm / Shift 2.5cm）；[ ] = 1°、Shift = 15°（Shift+[ 打出来是「{」）、Alt = 0.1°（按 code 认）；
         Ctrl+R 不转（那是浏览器刷新）；R 照旧 15° */
      if (wallEdit.on) Q('#btnWallEdit').click();
      await tick();
      const spec42 = CATALOG.find((c) => c.kind === 'sofa' && c.w >= 150);
      addItem(spec42.id);
      await tick();
      const it42 = state.items[state.items.length - 1];
      Object.assign(it42, { x: X + 8, y: Y + 6, rot: 0 });
      selOnly(it42.uid);
      drawFurniture();
      await tick();
      const x42 = it42.x;
      kd('ArrowRight');
      await tick();
      const s1 = it42.x - x42;
      kd('ArrowRight', { shiftKey: true });
      await tick();
      const s10 = it42.x - x42 - s1;
      kd(']');
      await tick();
      const r1 = it42.rot;
      kd('}', { shiftKey: true, code: 'BracketRight' });
      await tick();
      const r15 = it42.rot - r1;
      kd('“', { altKey: true, code: 'BracketLeft' });
      await tick();
      const r01 = it42.rot - r1 - r15;
      const rotB = it42.rot;
      kd('r', { ctrlKey: true });
      await tick();
      const ctrlR = it42.rot === rotB;
      kd('r');
      await tick();
      const rR = it42.rot - rotB;
      T(
        'pb-s23-furniture-arrows-brackets',
        near(s1, 1 / 30.48, 1e-9) &&
          near(s10, 10 / 30.48, 1e-9) &&
          near(r1, 1, 1e-9) &&
          near(r15, 15, 1e-9) &&
          near(r01, -0.1, 1e-6) &&
          ctrlR &&
          near(rR, 15, 1e-9),
        '→ ' +
          (s1 * 30.48).toFixed(2) +
          'cm · Shift+→ ' +
          (s10 * 30.48).toFixed(2) +
          'cm · ] ' +
          r1 +
          '° · Shift+] ' +
          r15 +
          '° · Alt+[ ' +
          r01.toFixed(2) +
          '° · Ctrl+R 不转=' +
          ctrlR +
          ' · R ' +
          rR +
          '°'
      );

      /* 42.4 右键 / 中键拖 = 平移（摆家具时以前右键弹浏览器菜单）；右键拖在家具上也只是平移、家具不动；平面图上的右键菜单被拦下 */
      const [fx, fy] = SPT(it42.x, it42.y);
      const ix0 = it42.x,
        iy0 = it42.y,
        vx0 = vb.x;
      fire('pointerdown', fx, fy, { button: 2, buttons: 2 });
      await tick();
      fire('pointermove', fx + 60, fy, { button: 2, buttons: 2 });
      await tick();
      fire('pointerup', fx + 60, fy, { button: 2, buttons: 0 });
      await tick();
      const panPx = (vx0 - vb.x) * ctmA(),
        panned = near(panPx, 60, 0.5) && it42.x === ix0 && it42.y === iy0;
      const cm = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: fx, clientY: fy });
      pbSvg.dispatchEvent(cm);
      const vx1b = vb.x;
      fire('pointerdown', fx, fy, { button: 1, buttons: 4 });
      await tick();
      fire('pointermove', fx - 30, fy, { button: 1, buttons: 4 });
      await tick();
      fire('pointerup', fx - 30, fy, { button: 1, buttons: 0 });
      await tick();
      const midPan = near((vb.x - vx1b) * ctmA(), 30, 0.5);
      T(
        'pb-s23-right-middle-drag-pans',
        panned && cm.defaultPrevented && midPan,
        '右键拖在家具上：图纸平移 ' +
          panPx.toFixed(0) +
          'px、家具不动=' +
          (it42.x === ix0) +
          ' · 右键菜单被拦=' +
          cm.defaultPrevented +
          ' · 中键拖平移=' +
          midPan
      );

      /* 42.5 拖家具 Shift = 锁横 / 竖（斜着拖，只走大的那一维）；旋转手柄 Shift = 15° 一格、Alt = 自由角度（以前 Shift = 自由） */
      fit2DToContent();
      await tick();
      const ppf42 = pxPerFtNow();
      const [gx, gy] = SPT(it42.x, it42.y);
      const sx0 = it42.x,
        sy0 = it42.y;
      fire('pointerdown', gx, gy);
      await tick();
      fire('pointermove', gx + ppf42 * 1, gy + ppf42 * 0.3, { shiftKey: true });
      await tick();
      fire('pointermove', gx + ppf42 * 2, gy + ppf42 * 0.6, { shiftKey: true });
      await tick();
      fire('pointerup', gx + ppf42 * 2, gy + ppf42 * 0.6, { shiftKey: true, buttons: 0 });
      await tick();
      const axisOk = near(it42.y, sy0, 1e-9) && it42.x - sx0 > 1.5;
      Object.assign(it42, { rot: 0 });
      selOnly(it42.uid);
      drawFurniture();
      await tick();
      const rotTo = async (deg, o) => {
        const h = pbSvg.querySelector('.rotHandle[data-uid="' + it42.uid + '"]');
        const b = h.getBoundingClientRect(),
          [cx, cy] = SPT(it42.x, it42.y),
          R = Math.hypot(b.x + b.width / 2 - cx, b.y + b.height / 2 - cy);
        const a = (deg * Math.PI) / 180,
          tx = cx + R * Math.sin(a),
          ty = cy - R * Math.cos(a);
        fire('pointerdown', b.x + b.width / 2, b.y + b.height / 2);
        await tick();
        fire('pointermove', tx, ty, o);
        await tick();
        fire('pointerup', tx, ty, Object.assign({ buttons: 0 }, o || {}));
        await tick();
        return it42.rot;
      };
      const rShift = await rotTo(37.3, { shiftKey: true });
      Object.assign(it42, { rot: 0 });
      drawFurniture();
      await tick();
      const rAlt = await rotTo(37.3, { altKey: true });
      Object.assign(it42, { rot: 0 });
      drawFurniture();
      await tick();
      const rDef = await rotTo(37.3);
      T(
        'pb-s23-shift-axis-lock-rot-handle',
        axisOk &&
          near(rShift, 30, 1e-9) &&
          Math.abs(rAlt - 37.3) < 0.15 &&
          !near(rAlt, Math.round(rAlt), 1e-6) &&
          near(rDef, 37, 1e-9),
        '斜着拖：Δx ' +
          (it42.x - sx0).toFixed(2) +
          'ft、Δy ' +
          (it42.y - sy0).toFixed(4) +
          ' · 手柄到 37.3°：Shift ' +
          rShift +
          '° / Alt ' +
          rAlt +
          '° / 缺省 ' +
          rDef +
          '°'
      );

      /* 42.6 编辑墙体：墙方向键 1cm / Shift 10cm（以前 5cm）；洁具也吃 R / [ ]（R 15°、Shift+R −15°、] 1°，一下一步撤销）——
         这时候选中的家具不跟着转（编辑模式屏蔽家具快捷键） */
      Q('#btnWallEdit').click();
      await tick();
      await setTool('select');
      wallEdit.sel = { kind: 'w', id: wN42.id };
      updateWallBarFromSel();
      const wy0 = entById(wN42.id).geom.y1;
      kd('ArrowDown');
      await tick();
      const w1 = entById(wN42.id).geom.y1 - wy0;
      kd('ArrowDown', { shiftKey: true });
      await tick();
      const w10 = entById(wN42.id).geom.y1 - wy0 - w1;
      await setTool('fx');
      Q('#fxType').value = 'toilet';
      await tap(X + 8, Y + 9);
      const fx42 = DOC.fixtures[DOC.fixtures.length - 1];
      await setTool('select');
      wallEdit.sel = { kind: 'fx', id: fx42.id };
      updateWallBarFromSel();
      const itRot = it42.rot,
        h6 = undoRing.length;
      kd('r');
      await tick();
      const f15 = (fx42.rot || 0) === 15;
      kd('R', { shiftKey: true });
      await tick();
      const f0 = (fx42.rot || 0) === 0;
      kd(']');
      await tick();
      const f1 = (fx42.rot || 0) === 1;
      T(
        'pb-s23-walledit-steps-fixture-rot',
        near(w1, 1 / 30.48, 1e-9) &&
          near(w10, 10 / 30.48, 1e-9) &&
          f15 &&
          f0 &&
          f1 &&
          undoRing.length === h6 + 3 &&
          it42.rot === itRot,
        '墙 ↓ ' +
          (w1 * 30.48).toFixed(2) +
          'cm · Shift+↓ ' +
          (w10 * 30.48).toFixed(2) +
          'cm · 洁具 R → 15=' +
          f15 +
          ' · Shift+R → 0=' +
          f0 +
          ' · ] → 1=' +
          f1 +
          ' · 撤销 +' +
          (undoRing.length - h6) +
          ' · 家具没跟着转=' +
          (it42.rot === itRot)
      );

      /* 42.7 画墙：Alt = 不吸附（点在已有墙的端点旁边也不吸过去）；Shift = 相对上一点锁 0° / 45° / 90°（以前 Shift = 不吸附） */
      await setTool('wall');
      // 起一笔：从 (4, 3) 出发（悬停预览只在起了第一个点之后才有）
      await tap(X + 4, Y + 3);
      const [ax, ay] = SPT(X + 16.05, Y + 12.05); // 东南角旁边 5cm：不按 Alt 会吸到角上
      fire('pointermove', ax, ay, { altKey: true, buttons: 0 });
      await tick();
      const hovAlt = wallEdit.hover ? [wallEdit.hover[0] - X, wallEdit.hover[1] - Y] : null;
      fire('pointermove', ax, ay, { buttons: 0 });
      await tick();
      const hovSnap = wallEdit.hover ? [wallEdit.hover[0] - X, wallEdit.hover[1] - Y] : null;
      // 光标在约 40° 方向 → Shift 锁到 45°
      const [bx2, by2] = SPT(X + 4 + 3, Y + 3 + 2.5);
      fire('pointermove', bx2, by2, { shiftKey: true, buttons: 0 });
      await tick();
      const hs = wallEdit.hover ? [wallEdit.hover[0] - X - 4, wallEdit.hover[1] - Y - 3] : [NaN, NaN];
      kd('Escape');
      await tick();
      await setTool('select');
      T(
        'pb-s23-draw-alt-free-shift-45',
        !!hovAlt &&
          near(hovAlt[0], 16.05, 0.011) &&
          !!hovSnap &&
          near(hovSnap[0], 16, 1e-6) &&
          near(hovSnap[1], 12, 1e-6) &&
          near(hs[0], hs[1], 0.011) &&
          hs[0] > 2,
        'Alt 悬停 ' +
          (hovAlt ? hovAlt.map((v) => v.toFixed(2)) : '无') +
          '（不吸）· 不按 ' +
          (hovSnap ? hovSnap.map((v) => v.toFixed(2)) : '无') +
          '（吸到角）· Shift 从起点 (' +
          hs.map((v) => v.toFixed(2)) +
          ')（45°）'
      );

      /* 42.8 PageUp / PageDown = 上一层 / 下一层；只有一层时说一声、什么都不变 */
      const lv0 = DOC.level || null;
      kd('PageUp');
      await tick();
      const single = (DOC.level || null) === lv0;
      Q('#lvAddUp').click();
      await tick();
      const upper = DOC.level;
      kd('PageDown');
      await tick();
      const lower = DOC.level;
      kd('PageUp');
      await tick();
      T(
        'pb-s23-pageupdown-levels',
        single && !!upper && lower !== upper && DOC.level === upper,
        '一层时 PageUp 不变=' +
          single +
          ' · 加一层后在 ' +
          upper +
          ' · PageDown → ' +
          lower +
          ' · PageUp → ' +
          DOC.level
      );

      /* 收尾：删掉这份户型 */
      await setTool('select');
      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      T(
        'pb-s23-clean-exit',
        PLAN_ID !== p42Plan && PLAN_REG.plans.length === p42Plans,
        'plans ' + p42Plans + '→' + PLAN_REG.plans.length
      );
    }

    /* ===== 43. S23 独立审查钓出的（先红后绿） ===== */
    {
      await enterEdit();
      await pbReset();
      const p43Plans = PLAN_REG.plans.length;
      Q('#btnPlanNew').click();
      await tick();
      const p43Plan = PLAN_ID;
      const fp43 = floorPts();
      const X =
          Math.min.apply(
            null,
            fp43.map((p) => p[0])
          ) + 1,
        Y =
          Math.min.apply(
            null,
            fp43.map((p) => p[1])
          ) + 1;
      const wd = cmToWd(15);
      const near = (a, b, tol) => Math.abs(a - b) < (tol || 1e-6);
      const kd = (k, o) => {
        const e = new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, o || {}));
        document.body.dispatchEvent(e);
        return e;
      };
      pushUserWall(X, Y, X + 16, Y, 'w', wd);
      pushUserWall(X + 16, Y, X + 16, Y + 12, 'w', wd);
      pushUserWall(X + 16, Y + 12, X, Y + 12, 'w', wd);
      pushUserWall(X, Y + 12, X, Y, 'w', wd);
      geoChanged();
      fit2DToContent();
      await tick();
      if (wallEdit.on) Q('#btnWallEdit').click();
      await tick();
      const spec43 = CATALOG.find((c) => c.kind === 'sofa' && c.w >= 150);
      addItem(spec43.id);
      addItem(spec43.id);
      await tick();
      const A = state.items[state.items.length - 2],
        B = state.items[state.items.length - 1];
      Object.assign(A, { x: X + 4, y: Y + 4, rot: 0 });
      Object.assign(B, { x: X + 11, y: Y + 8, rot: 0 });
      selOnly(A.uid);
      drawFurniture();
      await tick();
      const ppf = pxPerFtNow();

      /* 43.1 Shift+按下家具再拖 = 锁横竖挪（以前 Shift+按下就是加减选、直接 return：照提示先按 Shift 再拖，什么都不动还把它从选择里减掉）；
         Shift+点（没拖）照旧 = 加减选 */
      const [bx, by] = SPT(B.x, B.y),
        b0 = [B.x, B.y];
      fire('pointerdown', bx, by, { shiftKey: true });
      await tick();
      fire('pointermove', bx + ppf * 1, by + ppf * 0.3, { shiftKey: true });
      await tick();
      fire('pointermove', bx + ppf * 2, by + ppf * 0.6, { shiftKey: true });
      await tick();
      fire('pointerup', bx + ppf * 2, by + ppf * 0.6, { shiftKey: true, buttons: 0 });
      await tick();
      const moved1 = B.x - b0[0] > 1.5 && near(B.y, b0[1], 1e-9);
      selOnly(A.uid);
      drawFurniture();
      await tick();
      const [bx2, by2] = SPT(B.x, B.y);
      fire('pointerdown', bx2, by2, { shiftKey: true });
      await tick();
      fire('pointerup', bx2, by2, { shiftKey: true, buttons: 0 });
      await tick();
      const toggled = selUids().includes(A.uid) && selUids().includes(B.uid);
      T(
        'pb-s23r-shift-press-then-drag',
        moved1 && toggled,
        'Shift+按下再斜着拖：Δx ' +
          (B.x - b0[0]).toFixed(2) +
          ' Δy ' +
          (B.y - b0[1]).toFixed(4) +
          ' · Shift+点（没拖）加选=' +
          toggled
      );

      /* 43.2 拖家具途中按 Esc = 回到起点、拖动结束（以前只是全不选，拖动继续、松手照样落盘）；撤销环不留死步 */
      selOnly(A.uid);
      drawFurniture();
      await tick();
      const [ax, ay] = SPT(A.x, A.y);
      const a0 = [A.x, A.y],
        r0 = undoRing.length;
      fire('pointerdown', ax, ay);
      await tick();
      fire('pointermove', ax + ppf * 1, ay);
      await tick();
      fire('pointermove', ax + ppf * 2, ay);
      await tick();
      const midX = A.x;
      kd('Escape');
      await tick();
      fire('pointermove', ax + ppf * 3, ay);
      await tick();
      fire('pointerup', ax + ppf * 3, ay, { buttons: 0 });
      await tick();
      T(
        'pb-s23r-esc-cancels-furniture-drag',
        midX > a0[0] + 1 && near(A.x, a0[0], 1e-9) && near(A.y, a0[1], 1e-9) && undoRing.length === r0,
        '拖动中 x +' +
          (midX - a0[0]).toFixed(2) +
          'ft → Esc 后 ' +
          (A.x - a0[0]).toFixed(3) +
          ' · 撤销环 ' +
          r0 +
          '→' +
          undoRing.length
      );

      /* 43.3 柱子顶点：Alt+拖 = 不吸附地挪（以前 Alt+按下 = 删掉这个顶点）；Alt+点（没拖）照旧删 */
      Q('#btnWallEdit').click();
      await tick();
      await setTool('select');
      const sol = {
        id: SCHEMA.Project.nextId(DOC, 'solid'),
        geom: {
          t: 'poly',
          pts: [
            [X + 6, Y + 2],
            [X + 8, Y + 2],
            [X + 8, Y + 3],
            [X + 6, Y + 3],
          ],
        },
        src: 'user',
        userIndex: nextUserIndex('solids'),
      };
      DOC.solids.push(sol);
      geoChanged();
      wallEdit.sel = { kind: 'p', id: sol.id };
      drawWallEdit();
      updateWallBarFromSel();
      await tick();
      const vEl = () => pbSvg.querySelector('.pVert[data-vi="1"]');
      let vr = vEl() && vEl().getBoundingClientRect();
      const vx = vr ? vr.x + vr.width / 2 : 0,
        vy = vr ? vr.y + vr.height / 2 : 0;
      fire('pointerdown', vx, vy, { altKey: true });
      await tick();
      fire('pointermove', vx + ppf * 0.5, vy + ppf * 0.4, { altKey: true });
      await tick();
      fire('pointermove', vx + ppf * 1, vy + ppf * 0.8, { altKey: true });
      await tick();
      fire('pointerup', vx + ppf * 1, vy + ppf * 0.8, { altKey: true, buttons: 0 });
      await tick();
      const sp = entById(sol.id).geom.pts.map((q) => [q[0], q[1]]);
      const altDrag = sp.length === 4 && sp[1][0] - (X + 8) > 0.8 && sp[1][1] - (Y + 2) > 0.6;
      drawWallEdit();
      vr = vEl() && vEl().getBoundingClientRect();
      if (vr) {
        fire('pointerdown', vr.x + vr.width / 2, vr.y + vr.height / 2, { altKey: true });
        await tick();
        fire('pointerup', vr.x + vr.width / 2, vr.y + vr.height / 2, { altKey: true, buttons: 0 });
        await tick();
      }
      const altClickDeletes = entById(sol.id).geom.pts.length === 3;
      T(
        'pb-s23r-alt-drag-vertex-moves',
        altDrag && altClickDeletes,
        'Alt+拖顶点：' +
          sp.length +
          ' 个顶点、第 2 个挪到 (' +
          (sp[1] ? (sp[1][0] - X).toFixed(2) + ', ' + (sp[1][1] - Y).toFixed(2) : '?') +
          ') · Alt+点删掉=' +
          altClickDeletes
      );

      /* 43.4 面板里的组合键画成「Ctrl/⌘ + D」（以前和「W A S D 任选其一」一个样子，像是在说单按 D 也复制）；
         工具行展开着按 Esc = 先关面板（以前 Esc 先被工具行吃掉：面板还开着、工具行收起了） */
      buildKeysPanel();
      const dupRow = Array.from(Q('#keysBody').querySelectorAll('.kr')).find((r) => r.textContent.includes('复制'));
      const chord = !!dupRow && /Ctrl\/⌘\+D/.test(dupRow.querySelector('.kk').textContent);
      setProTools(true);
      await tick();
      kd('?');
      await tick();
      kd('Escape');
      await tick();
      const escPanelFirst = !keysPanelOpen() && proToolsOpen === true;
      toggleKeysPanel(false);
      setProTools(false);
      T(
        'pb-s23r-panel-chords-esc-order',
        chord && escPanelFirst,
        '「复制」那行的键：' +
          (dupRow ? dupRow.querySelector('.kk').textContent : '无') +
          ' · 工具行开着按 Esc：面板关=' +
          !keysPanelOpen() +
          '、工具行还开着=' +
          escPanelFirst
      );

      /* 43.5 Ctrl+D 没有可复制的（编辑墙体里 / 没选中）→ 拦下浏览器「加书签」（以前没 preventDefault，Chrome 弹加书签） */
      await setTool('select');
      wallEdit.sel = null;
      const e5a = kd('d', { ctrlKey: true });
      Q('#btnWallEdit').click();
      await tick();
      selOnly(null);
      drawFurniture();
      const e5b = kd('d', { ctrlKey: true });
      T(
        'pb-s23r-ctrl-d-never-bookmarks',
        e5a.defaultPrevented && e5b.defaultPrevented,
        '编辑墙体里拦下=' + e5a.defaultPrevented + ' · 没选中拦下=' + e5b.defaultPrevented
      );

      /* 43.6 右键拖 = 平移在「移动这一层」里也成立；松手后图纸不再跟着鼠标漂、模式还在（以前 pointermove 先 return、pointerup 不清 drag） */
      Q('#btnWallEdit').click();
      await tick();
      Q('#lvAddUp').click();
      await tick();
      Q('#btnWallEdit').click();
      await tick();
      setLvMove(true);
      await tick();
      const [px6, py6] = SPT(X + 8, Y + 6),
        vx6 = vb.x;
      fire('pointerdown', px6, py6, { button: 2, buttons: 2 });
      await tick();
      fire('pointermove', px6 + 50, py6, { button: 2, buttons: 2 });
      await tick();
      fire('pointerup', px6 + 50, py6, { button: 2, buttons: 0 });
      await tick();
      const panned6 = near((vx6 - vb.x) * pbSvg.getScreenCTM().a, 50, 0.5);
      const vxAfter = vb.x;
      fire('pointermove', px6 + 120, py6 + 30, { buttons: 0 });
      await tick();
      const noDrift = vb.x === vxAfter && !!lvMove;
      setLvMove(false);
      T(
        'pb-s23r-right-pan-in-level-move',
        panned6 && noDrift,
        '移动这一层时右键拖：图纸平移=' + panned6 + ' · 松手后悬停不漂、模式还在=' + noDrift
      );

      /* 43.7 台面工具 Enter = 结束（以前 Enter 只管墙 / 柱 / 楼梯）*/
      if (!wallEdit.on) Q('#btnWallEdit').click();
      await tick();
      await setTool('run');
      const nRun = (DOC.runs || []).length;
      await tap(X + 1, Y + 11.2);
      await tap(X + 6, Y + 11.2);
      kd('Enter');
      await tick();
      T(
        'pb-s23r-enter-finishes-run',
        (DOC.runs || []).length === nRun + 1 && wallEdit.drawPts.length === 0,
        '台面 ' + nRun + '→' + (DOC.runs || []).length
      );
      await setTool('select');

      /* 收尾 */
      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      T(
        'pb-s23r-clean-exit',
        PLAN_ID !== p43Plan && PLAN_REG.plans.length === p43Plans,
        'plans ' + p43Plans + '→' + PLAN_REG.plans.length
      );
    }

    /* ===== 44. S24a（research/13 U1–U4）：压在固定构件上要红、新加的落在空位、检视面板不溢出、提示行能收起 ===== */
    {
      await enterEdit();
      await pbReset();
      const p44Plans = PLAN_REG.plans.length;
      Q('#btnPlanNew').click();
      await tick();
      const p44Plan = PLAN_ID;
      const fp44 = floorPts();
      const X =
          Math.min.apply(
            null,
            fp44.map((p) => p[0])
          ) + 1,
        Y =
          Math.min.apply(
            null,
            fp44.map((p) => p[1])
          ) + 1;
      const wd = cmToWd(15);
      const near = (a, b, tol) => Math.abs(a - b) < (tol || 1e-6);
      pushUserWall(X, Y, X + 16, Y, 'w', wd);
      pushUserWall(X + 16, Y, X + 16, Y + 12, 'w', wd);
      pushUserWall(X + 16, Y + 12, X, Y + 12, 'w', wd);
      pushUserWall(X, Y + 12, X, Y, 'w', wd);
      geoChanged();
      fit2DToContent();
      await tick();
      // 一个马桶（洁具工具真放，离墙远 = 不吸附）、一段台面（沿北墙）
      await setTool('fx');
      Q('#fxType').value = 'toilet';
      await tap(X + 4, Y + 6);
      const toilet = DOC.fixtures[DOC.fixtures.length - 1];
      // 北墙边一条 11ft 台面（Y+0.25 起、深 2ft）
      pushUserRun(
        [
          [X + 3, Y + 0.25],
          [X + 14, Y + 0.25],
        ],
        2.0,
        2.95
      );
      geoChanged();
      Q('#btnWallEdit').click();
      await tick();
      const tc = [(toilet.x1 + toilet.x2) / 2, (toilet.y1 + toilet.y2) / 2];
      const sofaSpec = CATALOG.find((c) => c.kind === 'sofa' && c.w >= 150 && c.w <= 220);
      const stoolSpec = CATALOG.find((c) => c.kind === 'stool');
      const tvSpec = CATALOG.find((c) => c.kind === 'tv');
      const put = (spec, x, y, z) => {
        addItem(spec.id);
        const it = state.items[state.items.length - 1];
        Object.assign(it, { x, y, rot: 0 });
        if (z != null) it.z = z;
        return it;
      };
      const sA = put(sofaSpec, tc[0], tc[1]);
      const st = put(stoolSpec, X + 4.2, Y + 1.4); // 台面下面（吧凳塞进去）
      const sC = put(sofaSpec, X + 11, Y + 0.6 + cm2ft(sofaSpec.d) / 2 + 0.3); // 后半截压在台面上、不碰墙
      const tv = tvSpec ? put(tvSpec, X + 7, Y + 0.6, 4.5) : null; // 挂在 4.5ft：台面顶 2.95ft 之上
      drawFurniture();
      await tick();
      const why = (it) => furnWhy.get(it.uid) || [];

      /* 44.1 U1 压在洁具 / 台面上 = 红「压在固定构件上」；吧凳塞进台面下面不算；挂在台面上方的电视不算（高度不重叠） */
      const okFx =
        why(sA).includes('onFixture') &&
        !why(st).includes('onFixture') &&
        why(sC).includes('onFixture') &&
        (!tv || !why(tv).includes('onFixture'));
      T(
        'pb-s24-furniture-on-fixture-flagged',
        okFx,
        '沙发压马桶 ' +
          JSON.stringify(why(sA)) +
          ' · 吧凳塞台面下 ' +
          JSON.stringify(why(st)) +
          ' · 沙发压台面 ' +
          JSON.stringify(why(sC)) +
          ' · 台面上方的电视 ' +
          (tv ? JSON.stringify(why(tv)) : '（目录里没有）')
      );

      /* 44.2 U2 新加一件：视图正中正好是马桶 → 不落在马桶上，落在最近的空位（在地板里、不插墙、不压任何东西） */
      for (const it of [sA, st, sC, tv].filter(Boolean)) state.items.splice(state.items.indexOf(it), 1);
      drawFurniture();
      vb.x = tc[0] * S - vb.w / 2;
      vb.y = tc[1] * S - vb.h / 2;
      pbSvg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
      addItem(sofaSpec.id);
      await tick();
      const nw = state.items[state.items.length - 1];
      const dC = Math.hypot(nw.x - tc[0], nw.y - tc[1]);
      T(
        'pb-s24-new-item-lands-free',
        why(nw).length === 0 && insideFloorPt(nw.x, nw.y) && dC < 8,
        '落在 (' +
          (nw.x - X).toFixed(2) +
          ', ' +
          (nw.y - Y).toFixed(2) +
          ')，离视图中心 ' +
          dC.toFixed(2) +
          'ft · 冲突 ' +
          JSON.stringify(why(nw))
      );

      /* 44.3 U3 检视面板「旋转」那一行不溢出：「+90°」整个在面板里、面板没有横向滚动 */
      selOnly(nw.uid);
      drawFurniture();
      updateProps();
      await tick();
      const pr = Q('#props').getBoundingClientRect(),
        b90 = Q('#pRot90').getBoundingClientRect();
      const noOverflow = b90.right <= pr.right - 4 && Q('#props').scrollWidth <= Q('#props').clientWidth + 1;
      T(
        'pb-s24-props-rotation-row-fits',
        noOverflow,
        '「+90°」右沿 ' +
          b90.right.toFixed(0) +
          ' / 面板右沿 ' +
          pr.right.toFixed(0) +
          ' · scrollWidth ' +
          Q('#props').scrollWidth +
          ' / clientWidth ' +
          Q('#props').clientWidth
      );

      /* 44.4 U4 提示行能一键收起（只留「? 快捷键」）、再点展开；记住；1700 宽下两侧面板的缺省宽度与以前一样（400 / 300） */
      const hx = Q('#hint .hintX');
      if (hx) hx.click();
      await tick();
      const minOn = Q('#hint').classList.contains('hintMin') && !!panelState().hintMin;
      const lk = Q('#hint .keysLink'),
        lkVis = !!lk && lk.getBoundingClientRect().width > 0;
      const txt = Q('#hint .h1'),
        txtHidden = !!txt && txt.getBoundingClientRect().width === 0;
      const hx2 = Q('#hint .hintX');
      if (hx2) hx2.click();
      await tick();
      const minOff = !Q('#hint').classList.contains('hintMin') && !panelState().hintMin;
      const cw = Q('#catalog').getBoundingClientRect().width,
        pw = Q('#props').getBoundingClientRect().width;
      const pst = panelState();
      const defaults = pst.catW || pst.prW ? true : near(cw, 400, 1.5) && near(pw, 300, 1.5);
      T(
        'pb-s24-hint-collapse-panel-widths',
        !!hx && minOn && lkVis && txtHidden && minOff && defaults,
        '收起=' +
          minOn +
          '（链接还在=' +
          lkVis +
          '、正文藏起=' +
          txtHidden +
          '）· 再点展开=' +
          minOff +
          ' · 面板 ' +
          cw.toFixed(0) +
          ' / ' +
          pw.toFixed(0) +
          'px'
      );

      /* 收尾 */
      Q('#btnWallEdit').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      T(
        'pb-s24-clean-exit',
        PLAN_ID !== p44Plan && PLAN_REG.plans.length === p44Plans,
        'plans ' + p44Plans + '→' + PLAN_REG.plans.length
      );

      /* 44.5 U1 内置户型的中岛（只有带中岛的户型）：沙发放在中岛上 = 红；户型一打开就点卡片，不落在中岛上（U2） */
      await enterEdit();
      Q('#btnWallEdit').click();
      await tick();
      const isl = ISL();
      if (!isl) T('pb-s24-island-flagged', true, '这份内置户型没有中岛（不适用）');
      else {
        const ic = [(isl.a[0] + isl.b[0] + isl.e[0] + isl.d[0]) / 4, (isl.a[1] + isl.b[1] + isl.e[1] + isl.d[1]) / 4];
        addItem(sofaSpec.id);
        const si = state.items[state.items.length - 1];
        Object.assign(si, { x: ic[0], y: ic[1], rot: 0 });
        drawFurniture();
        await tick();
        const onIsl = why(si).includes('onFixture');
        state.items.splice(state.items.indexOf(si), 1);
        fit2DToContent();
        vb.x = ic[0] * S - vb.w / 2;
        vb.y = ic[1] * S - vb.h / 2;
        pbSvg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
        addItem(sofaSpec.id);
        await tick();
        const ni = state.items[state.items.length - 1];
        const freeNi = why(ni).length === 0;
        state.items.splice(state.items.indexOf(ni), 1);
        selOnly(null);
        drawFurniture();
        fit2DToContent();
        T(
          'pb-s24-island-flagged',
          onIsl && freeNi,
          '沙发放中岛上 ' + JSON.stringify(onIsl) + ' · 视图中心在中岛上时新加的落在空位=' + freeNi
        );
      }
      Q('#btnWallEdit').click();
      await tick();
    }

    /* ===== 45. S24b（research/13 U5–U7）：目录卡片拖进平面图、拖动时标到旁边家具的距离 + 对齐线、斜墙自动转平行 ===== */
    {
      await enterEdit();
      await pbReset();
      const p45Plans = PLAN_REG.plans.length;
      Q('#btnPlanNew').click();
      await tick();
      const p45Plan = PLAN_ID;
      const fp45 = floorPts();
      const X =
          Math.min.apply(
            null,
            fp45.map((p) => p[0])
          ) + 1,
        Y =
          Math.min.apply(
            null,
            fp45.map((p) => p[1])
          ) + 1;
      const wd = cmToWd(15);
      const near = (a, b, tol) => Math.abs(a - b) < (tol || 1e-6);
      // 北墙、东墙、南墙一截 + 西南一道 30° 的斜墙（(0, 12−6·tan30°) → (6, 12)）+ 西墙
      const yS = Y + 12 - 6 * Math.tan(Math.PI / 6);
      pushUserWall(X, Y, X + 16, Y, 'w', wd);
      pushUserWall(X + 16, Y, X + 16, Y + 12, 'w', wd);
      pushUserWall(X + 16, Y + 12, X + 6, Y + 12, 'w', wd);
      pushUserWall(X + 6, Y + 12, X, yS, 'w', wd);
      pushUserWall(X, yS, X, Y, 'w', wd);
      geoChanged();
      fit2DToContent();
      await tick();
      if (wallEdit.on) Q('#btnWallEdit').click();
      await tick();
      const ppf = pxPerFtNow();

      /* 45.1 U5 目录卡片拖进平面图：拖动中画出占地虚框；松手 = 放在松手处（贴墙照旧）、选中、一步撤销；拖完虚框没了 */
      const nsSpec =
        CATALOG.find((c) => c.kind === 'nightstand') || CATALOG.find((c) => c.w <= 60 && c.d <= 50 && !isLight(c));
      const card = Array.from(Q('#catalog').querySelectorAll('.catCard')).find((c) =>
        c.querySelector('[data-thumb="' + nsSpec.id + '"]')
      );
      let ghost = false,
        dropped = null;
      const n0 = state.items.length,
        r0 = undoRing.length;
      if (card) {
        const dt = new DataTransfer();
        card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
        const [dx, dy] = SPT(X + 8, Y + 6);
        pbSvg.dispatchEvent(
          new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: dx, clientY: dy })
        );
        await tick();
        ghost = !!pbSvg.querySelector('.dndGhost');
        pbSvg.dispatchEvent(
          new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: dx, clientY: dy })
        );
        card.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
        await tick();
        dropped = state.items.length === n0 + 1 ? state.items[state.items.length - 1] : null;
      }
      T(
        'pb-s24b-drag-card-onto-plan',
        !!card &&
          ghost &&
          !!dropped &&
          near(dropped.x, X + 8, 0.06) &&
          near(dropped.y, Y + 6, 0.06) &&
          selected === dropped.uid &&
          undoRing.length === r0 + 1 &&
          !pbSvg.querySelector('.dndGhost'),
        '卡片=' +
          !!card +
          ' · 拖动中虚框=' +
          ghost +
          ' · 落在 ' +
          (dropped ? '(' + (dropped.x - X).toFixed(2) + ', ' + (dropped.y - Y).toFixed(2) + ')' : '没放上') +
          ' · 选中=' +
          (dropped && selected === dropped.uid) +
          ' · 撤销 +' +
          (undoRing.length - r0)
      );

      /* 45.2 U6 拖动中标到旁边家具的距离（以前只标到墙皮）；上沿和旁边那件差 < 6 屏幕像素 = 对齐（画一条对齐线），Alt 不对齐 */
      const bedSpec = CATALOG.find((c) => c.kind === 'bed' && c.w >= 140);
      addItem(bedSpec.id);
      const bed = state.items[state.items.length - 1];
      const BW = cm2ft(bedSpec.w),
        BD = cm2ft(bedSpec.d);
      Object.assign(bed, { x: X + 7, y: Y + 0.25 + BD / 2 + 0.6, rot: 0 });
      const ns = dropped || (addItem(nsSpec.id), state.items[state.items.length - 1]);
      const NW = cm2ft(nsSpec.w),
        ND = cm2ft(nsSpec.d);
      const gap = 1.0; // 床右沿 → 床头柜左沿 1ft
      Object.assign(ns, { x: bed.x + BW / 2 + gap + NW / 2, y: bed.y - BD / 2 + ND / 2 + 0.4, rot: 0 });
      selOnly(ns.uid);
      drawFurniture();
      await tick();
      const [sx, sy] = SPT(ns.x, ns.y);
      fire('pointerdown', sx, sy);
      await tick();
      fire('pointermove', sx, sy - 6, {});
      await tick();
      const lbl = Array.from(pbSvg.querySelectorAll('.distLbl')).map((t) => t.textContent);
      const want = fmtLen(gap);
      // 量到床的那条（琥珀色）：读数与 1ft 间距差不到 2cm（拖动时位置取 0.05ft 网格）
      const furnLbl = Array.from(pbSvg.querySelectorAll('.distLbl.toFurn')).map((t) => t.textContent);
      const sawFurnDist = furnLbl.some((t) => Math.abs(parseFloat(t) - gap * 30.48) < 2);
      // 往上挪：床头柜上沿离床上沿只差 0.4ft − 拖上去的量；拖到差 3 屏幕像素以内
      const target = bed.y - BD / 2 + ND / 2 + 3 / ppf;
      const [, ty] = SPT(ns.x, target);
      fire('pointermove', sx, ty, {});
      await tick();
      const aligned = near(ns.y - ND / 2, bed.y - BD / 2, 1e-6) && !!pbSvg.querySelector('.alignGuide');
      fire('pointermove', sx, ty, { altKey: true });
      await tick();
      const altFree = !near(ns.y - ND / 2, bed.y - BD / 2, 1e-4);
      fire('pointerup', sx, ty, { altKey: true, buttons: 0 });
      await tick();
      T(
        'pb-s24b-furniture-distance-and-align',
        sawFurnDist && aligned && altFree,
        '拖动中的距离标注 ' +
          JSON.stringify(lbl) +
          '（要有到床的 ' +
          want +
          '）· 差 3px 对齐上沿=' +
          aligned +
          ' · Alt 不对齐=' +
          altFree
      );

      /* 45.3 U7 斜墙：朝向与墙差 ≤ 12° 拖到墙边 = 自动转到与墙平行并贴上；拖离开 = 转回原来的角度；Alt = 不转 */
      Object.assign(ns, { x: X + 4, y: Y + 7, rot: 25 });
      selOnly(ns.uid);
      drawFurniture();
      await tick();
      // 斜墙方向 +30°（平面坐标 y 朝下）；室内在它的东北侧：内法线 (sin30, −cos30)。离墙皮 ~2 屏幕像素的地方
      const wallDir = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)],
        inN = [Math.sin(Math.PI / 6), -Math.cos(Math.PI / 6)];
      const onWall = [X + wallDir[0] * 3.46, yS + wallDir[1] * 3.46];
      const half = wd / S / 2;
      const dropAt = [onWall[0] + inN[0] * (half + ND / 2 + 2 / ppf), onWall[1] + inN[1] * (half + ND / 2 + 2 / ppf)];
      const [nx, ny] = SPT(ns.x, ns.y),
        [wx, wy] = SPT(dropAt[0], dropAt[1]);
      fire('pointerdown', nx, ny);
      await tick();
      fire('pointermove', (nx + wx) / 2, (ny + wy) / 2, {});
      await tick();
      fire('pointermove', wx, wy, {});
      await tick();
      const rotNear = ns.rot;
      fire('pointermove', nx, ny, {});
      await tick();
      const rotAway = ns.rot;
      fire('pointermove', wx, wy, { altKey: true });
      await tick();
      const rotAlt = ns.rot;
      fire('pointerup', wx, wy, { altKey: true, buttons: 0 });
      await tick();
      const dRot = (a, b) => ((((a - b) % 90) + 135) % 90) - 45;
      T(
        'pb-s24b-slanted-wall-auto-align',
        Math.abs(dRot(rotNear, 30)) < 0.01 && near(rotAway, 25, 1e-9) && near(rotAlt, 25, 1e-9),
        '25° 拖到 30° 斜墙边 → ' + rotNear + '° · 拖离开 → ' + rotAway + '° · Alt → ' + rotAlt + '°'
      );

      /* 收尾 */
      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      T(
        'pb-s24b-clean-exit',
        PLAN_ID !== p45Plan && PLAN_REG.plans.length === p45Plans,
        'plans ' + p45Plans + '→' + PLAN_REG.plans.length
      );
    }

    /* ===== 46. S24c（research/13 U8）：方案 —— 同一份户型摆几套家具；几何共用，家具 / 采购清单 / 撤销各是各的 ===== */
    {
      await pbReset();
      if (wallEdit.on) Q('#btnWallEdit').click();
      await tick();
      const p46Plans = PLAN_REG.plans.length;
      const near = (a, b, tol) => Math.abs(a - b) < (tol || 1e-6);
      const toastTxt = () => (Q('#toast') || {}).textContent || '';
      const archive = () => {
        try {
          return JSON.parse(STORE.get(ITEMS_KEY));
        } catch (e) {
          return null;
        }
      };

      /* 46.1 bug 猎 #93：切到一份还没存过家具的户型（新浏览器里先导入自己的图纸、在那儿摆了家具，再切回内置户型），
         上一份户型的家具原样带过去，还被写进那份户型的存档 */
      {
        const B = BUILTIN_PLAN_ID;
        if (PLAN_ID !== B) switchPlan(B, true);
        await tick();
        state.items = [];
        save();
        STORE.remove(PLANS.itemsKeyFor(B));
        Q('#btnPlanNew').click();
        await tick();
        const q = PLAN_ID;
        addItem(CATALOG.find((c) => c.kind === 'bed').id);
        await tick();
        const nQ = state.items.length;
        switchPlan(B, true);
        await tick();
        const nB = state.items.length,
          stB = STORE.get(PLANS.itemsKeyFor(B));
        let storedB = 0;
        try {
          storedB = stB ? JSON.parse(stB).items.length : 0;
        } catch (e) {}
        T(
          'pb-s24c-hunt93-switch-to-plan-without-archive',
          nQ === 1 && nB === 0 && storedB === 0,
          '新户型摆了 ' + nQ + ' 件 · 切回内置后画着 ' + nB + ' 件（要 0）· 内置的存档里 ' + storedB + ' 件（要 0）'
        );
        switchPlan(q, true);
        await tick();
        Q('#btnPlanDel').click();
        await tick();
        Q('#btnPlanDel').click();
        await tick();
      }

      /* 测试户型：一间 16×12ft 的空房（自包含户型，删掉就干净） */
      Q('#btnPlanNew').click();
      await tick();
      const p46Plan = PLAN_ID;
      const fp46 = floorPts();
      const X =
          Math.min.apply(
            null,
            fp46.map((p) => p[0])
          ) + 1,
        Y =
          Math.min.apply(
            null,
            fp46.map((p) => p[1])
          ) + 1;
      const wd = cmToWd(15);
      pushUserWall(X, Y, X + 16, Y, 'w', wd);
      pushUserWall(X + 16, Y, X + 16, Y + 12, 'w', wd);
      pushUserWall(X + 16, Y + 12, X, Y + 12, 'w', wd);
      pushUserWall(X, Y + 12, X, Y, 'w', wd);
      geoChanged();
      fit2DToContent();
      await tick();
      resetUndoRings();
      const sofaSpec = CATALOG.find((c) => c.kind === 'sofa' && c.price > 0 && c.w <= 230);
      const bedSpec = CATALOG.find((c) => c.kind === 'bed' && c.price > 0);
      addItem(sofaSpec.id, { x: X + 5, y: Y + 4 });
      addItem(bedSpec.id, { x: X + 11, y: Y + 7 });
      await tick();
      const sofaUid = state.items[0].uid;
      resetUndoRings();

      /* 46.2 缺省只有「方案 1」：存档格式与 S24c 之前逐字节相同（没有 lay），右上角显示「方案 1」 */
      const a0 = STORE.get(ITEMS_KEY) || '';
      T(
        'pb-s24c-default-archive-unchanged',
        LAY.list.length === 1 &&
          (Q('#layCur') || {}).textContent === '方案 1' &&
          getComputedStyle(Q('#layBar')).display !== 'none' &&
          a0.indexOf('"lay"') < 0 &&
          /^\{"geo":\d+,"items":\[.*\],"customCat":\[.*\],"unit":"(cm|ft)"\}$/.test(a0),
        '方案 ' +
          LAY.list.length +
          ' 套 · 按钮「' +
          (Q('#layCur') || {}).textContent +
          '」· 存档 ' +
          a0.slice(0, 60) +
          '…'
      );

      /* 46.3 复制当前方案 → 切到「方案 2」，家具是深拷贝；在方案 2 里挪沙发，方案 1 不受影响；面板里两行各自的件数 / 合计 */
      Q('#layBtn').click();
      await tick();
      const rows0 = Q('#layList').querySelectorAll('.layRow').length;
      Q('#layDup').click();
      await tick();
      const dupOk = LAY.list.length === 2 && LAY.cur !== 'L1' && (Q('#layCur') || {}).textContent === '方案 2';
      const it2 = state.items.find((i) => i.uid === sofaUid);
      const shared = it2 && LAY.other.L1 && LAY.other.L1.some((i) => i === it2);
      selOnly(sofaUid);
      drawFurniture();
      key('ArrowRight', document.body, true); // Shift+→ = 10cm
      await tick();
      const x2 = state.items.find((i) => i.uid === sofaUid).x;
      const x1 = LAY.other.L1.find((i) => i.uid === sofaUid).x;
      const rowTxt = Array.from(Q('#layList').querySelectorAll('.layRow')).map((r) => r.textContent);
      T(
        'pb-s24c-duplicate-then-edit-independent',
        rows0 === 1 &&
          dupOk &&
          !shared &&
          near(x2 - x1, 10 / 30.48, 1e-3) &&
          near(x1, X + 5, 1e-6) &&
          rowTxt.length === 2 &&
          /方案 1.*2 件/.test(rowTxt[0]) &&
          /方案 2.*2 件/.test(rowTxt[1]) &&
          /复制成「方案 2」/.test(toastTxt()),
        '面板行 ' +
          rows0 +
          '→' +
          JSON.stringify(rowTxt) +
          ' · 复制后当前=' +
          LAY.cur +
          ' · 同一个对象=' +
          shared +
          ' · 方案 2 的沙发 x−X=' +
          (x2 - X).toFixed(3) +
          ' · 方案 1 的 ' +
          (x1 - X).toFixed(3)
      );

      /* 46.4 切回方案 1（点面板里那一行）：画的是方案 1 的家具、采购清单跟着换；存档里两套都在 */
      addItem(CATALOG.find((c) => c.kind === 'chair' && c.price > 0).id, { x: X + 3, y: Y + 9 }); // 方案 2 多一把椅子
      await tick();
      const plCount2 = +Q('#plCount').textContent;
      const row1 = Q('#layList').querySelector('.layRow[data-id="L1"]');
      row1.click();
      await tick();
      const sofaNow = state.items.find((i) => i.uid === sofaUid);
      const g1 = pbSvg.querySelectorAll('g.furn').length;
      const plCount1 = +Q('#plCount').textContent;
      const ar = archive();
      T(
        'pb-s24c-switch-shows-that-layout',
        LAY.cur === 'L1' &&
          near(sofaNow.x, X + 5, 1e-6) &&
          state.items.length === 2 &&
          g1 === 2 &&
          plCount2 === 3 &&
          plCount1 === 2 &&
          !!ar &&
          !!ar.lay &&
          ar.lay.cur === 'L1' &&
          ar.items.length === 2 &&
          ar.lay.other.L2.length === 3,
        '当前 ' +
          LAY.cur +
          ' · 沙发 x−X=' +
          (sofaNow.x - X).toFixed(3) +
          ' · 平面图上 ' +
          g1 +
          ' 件 · 采购清单 方案 2=' +
          plCount2 +
          ' / 方案 1=' +
          plCount1 +
          ' · 存档 cur=' +
          (ar && ar.lay && ar.lay.cur) +
          ' items=' +
          (ar && ar.items.length) +
          ' other.L2=' +
          (ar && ar.lay && ar.lay.other.L2 && ar.lay.other.L2.length)
      );

      /* 46.5 每套方案各自撤销：方案 1 挪一下 → 切到方案 2 撤销 = 撤的是方案 2 自己的（椅子没了），方案 1 的那一下不动；
         切回方案 1 撤销 = 撤它自己那一下 */
      selOnly(sofaUid);
      drawFurniture();
      key('ArrowDown', document.body, true);
      await tick();
      const y1moved = state.items.find((i) => i.uid === sofaUid).y;
      const u1 = undoRing.length;
      Q('#layList').querySelector('.layRow[data-id="L2"]').click();
      await tick();
      const u2 = undoRing.length;
      undoStep();
      await tick();
      const chairGone = state.items.length === 2;
      const l1y = LAY.other.L1.find((i) => i.uid === sofaUid).y;
      Q('#layList').querySelector('.layRow[data-id="L1"]').click();
      await tick();
      const u1back = undoRing.length;
      undoStep();
      await tick();
      const y1undone = state.items.find((i) => i.uid === sofaUid).y;
      T(
        'pb-s24c-undo-per-layout',
        u1 === 1 && u2 === 2 && chairGone && near(l1y, y1moved, 1e-9) && u1back === 1 && near(y1undone, Y + 4, 1e-6),
        '方案 1 环 ' +
          u1 +
          ' 步 · 方案 2 环 ' +
          u2 +
          ' 步 · 方案 2 撤销后椅子没了=' +
          chairGone +
          '、方案 1 的沙发没被撤=' +
          near(l1y, y1moved, 1e-9) +
          ' · 回到方案 1 环 ' +
          u1back +
          ' 步、撤销后沙发 y−Y=' +
          (y1undone - Y).toFixed(3)
      );

      /* 46.5b 只是「看的角度」的变化不算共用内容：在方案 2 里切夜晚、量一下尺寸 → 回到方案 1，它的撤销记录还在 */
      redoStep(); // 方案 1：沙发再挪下去（环里留一步）
      await tick();
      Q('#layList').querySelector('.layRow[data-id="L2"]').click();
      await tick();
      const env0 = JSON.stringify(DOC.env),
        meas0 = JSON.stringify(meas.list);
      DOC.env.mode = DOC.env.mode === 'night' ? 'day' : 'night';
      saveGeo();
      meas.list = meas.list.concat([
        [
          [X + 1, Y + 1],
          [X + 4, Y + 1],
        ],
      ]);
      Q('#layList').querySelector('.layRow[data-id="L1"]').click();
      await tick();
      const keptRing = undoRing.length === 1 && !/撤销记录作废/.test(toastTxt());
      DOC.env = JSON.parse(env0);
      saveGeo();
      meas.list = JSON.parse(meas0);
      T(
        'pb-s24c-view-changes-keep-undo',
        keptRing,
        '方案 2 里切了白天 / 夜晚、量了尺寸 → 回到方案 1 环 ' +
          undoRing.length +
          ' 步（要 1）· 提示「' +
          toastTxt() +
          '」'
      );

      /* 46.6 几何是共用的：在方案 2 里加一段墙 → 方案 1 也有；方案 1 的旧撤销记录作废（恢复它会把那段墙一起退掉），并说出来 */
      Q('#layList').querySelector('.layRow[data-id="L2"]').click();
      await tick();
      const w0 = effWalls().length;
      pushUndo('t46wall', true);
      pushUserWall(X + 8, Y, X + 8, Y + 5, 'w', wd);
      geoChanged();
      await tick();
      Q('#layList').querySelector('.layRow[data-id="L1"]').click();
      await tick();
      const t46 = toastTxt();
      T(
        'pb-s24c-shared-geometry-drops-stale-undo',
        effWalls().length === w0 + 1 && undoRing.length === 0 && redoRing.length === 0 && /撤销记录作废/.test(t46),
        '方案 1 看到的墙 ' +
          w0 +
          '→' +
          effWalls().length +
          ' · 方案 1 的环 ' +
          undoRing.length +
          '/' +
          redoRing.length +
          ' · 提示「' +
          t46 +
          '」'
      );

      /* 46.8 动到所有方案的几何操作：移动这一层 / 删楼层 —— 别的方案摆在那一层的家具一起走 / 一起删；撤销、重做把它们一起带回去 */
      {
        const up = addLevelUI('above');
        await tick();
        const chair = CATALOG.find((c) => c.kind === 'chair' && c.price > 0);
        addItem(chair.id, { x: X + 4, y: Y + 4 }); // 方案 1 在二层
        await tick();
        const c1 = state.items[state.items.length - 1].uid;
        Q('#layList').querySelector('.layRow[data-id="L2"]').click();
        await tick();
        addItem(chair.id, { x: X + 6, y: Y + 6 }); // 方案 2 在二层
        await tick();
        const c2 = state.items[state.items.length - 1].uid;
        const o1 = () => LAY.other.L1.find((i) => i.uid === c1);
        const m2 = () => state.items.find((i) => i.uid === c2);
        const sofa1 = () => LAY.other.L1.find((i) => i.uid === sofaUid); // 一层的，不该动
        const s1x = sofa1().x;
        setLvMove(true);
        key('ArrowRight', document.body, true); // Shift+→ = 10cm，整层
        await tick();
        setLvMove(false);
        const d = 10 / 30.48;
        const movedBoth = near(o1().x, X + 4 + d, 1e-3) && near(m2().x, X + 6 + d, 1e-3) && near(sofa1().x, s1x, 1e-9);
        undoStep();
        await tick();
        const undoneBoth = near(o1().x, X + 4, 1e-6) && near(m2().x, X + 6, 1e-6);
        deleteLevelUI(up.id);
        await tick();
        const askTxt = toastTxt();
        deleteLevelUI(up.id);
        await tick();
        const goneBoth = !o1() && !m2() && !!sofa1() && /其中 1 件在别的方案里/.test(toastTxt());
        undoStep();
        await tick();
        const backBoth = !!o1() && !!m2() && DOC.levels.length === 2;
        redoStep();
        await tick();
        const redoBoth = !o1() && !m2() && DOC.levels.length === 1;
        undoStep();
        await tick();
        T(
          'pb-s24c-level-ops-reach-all-layouts',
          movedBoth &&
            undoneBoth &&
            /别的方案在这一层还有 1 件/.test(askTxt) &&
            goneBoth &&
            backBoth &&
            redoBoth &&
            !!o1() &&
            !!m2(),
          '移动这一层：两套方案的椅子都挪了=' +
            movedBoth +
            ' · 撤销都回来=' +
            undoneBoth +
            ' · 删层确认「' +
            askTxt +
            '」· 两套都删了=' +
            goneBoth +
            ' · 撤销都回来=' +
            backBoth +
            ' · 重做又都删了=' +
            redoBoth
        );
        switchLevel('lv1', true);
        await tick();
      }

      /* 46.9 整图缩放：别的方案的家具也按同一个比例搬（不然切过去全在墙外）；撤销一起回去 */
      {
        await enterEdit();
        await setTool('select');
        await tap(X + 12, Y);
        const sw = selWallSeg();
        const L0 = sw ? Math.hypot(sw.x2 - sw.x1, sw.y2 - sw.y1) : 0;
        const bed1 = () => LAY.other.L1.find((i) => i.ref === bedSpec.id);
        const bed2 = () => state.items.find((i) => i.ref === bedSpec.id);
        const sofa1 = () => LAY.other.L1.find((i) => i.uid === sofaUid);
        const sofa2 = () => state.items.find((i) => i.uid === sofaUid);
        const gap0 = [bed1().x - sofa1().x, bed2().x - sofa2().x];
        const p0 = JSON.stringify([LAY.other.L1, state.items].map((a) => a.map((i) => [i.x, i.y])));
        Q('#wLen').value = String(Math.round(L0 * 1.25 * 30.48));
        Q('#calBtn').click();
        await tick();
        Q('#calBtn').click();
        await tick();
        const sw1 = selWallSeg();
        const k = sw1 ? Math.hypot(sw1.x2 - sw1.x1, sw1.y2 - sw1.y1) / L0 : 0;
        const gap1 = [bed1().x - sofa1().x, bed2().x - sofa2().x];
        const scaledBoth = k > 1.2 && near(gap1[0], gap0[0] * k, 0.02) && near(gap1[1], gap0[1] * k, 0.02);
        undoStep();
        await tick();
        const p1 = JSON.stringify([LAY.other.L1, state.items].map((a) => a.map((i) => [i.x, i.y])));
        T(
          'pb-s24c-rescale-reaches-all-layouts',
          L0 > 10 && scaledBoth && p1 === p0,
          '选中墙 ' +
            L0.toFixed(2) +
            'ft · ×' +
            k.toFixed(4) +
            ' · 床到沙发的距离 方案 1 ' +
            gap0[0].toFixed(2) +
            '→' +
            gap1[0].toFixed(2) +
            ' / 方案 2 ' +
            gap0[1].toFixed(2) +
            '→' +
            gap1[1].toFixed(2) +
            ' · 撤销后两套都回原位=' +
            (p1 === p0)
        );
        Q('#btnWallEdit').click();
        await tick();
      }

      /* 46.10 导入方案（F3 起：当前这套摆了东西 = 新建一套，不覆盖）：别的方案还在用的自定义件留在目录里，导进来的条目合并进来 */
      {
        Q('#layList').querySelector('.layRow[data-id="L1"]').click();
        await tick();
        Q('#cfName').value = '测试自制书架';
        Q('#cfW').value = '80';
        Q('#cfD').value = '30';
        Q('#cfH').value = '180';
        Q('#cfAdd').click();
        await tick();
        const cc = state.customCat[state.customCat.length - 1];
        const usedIn1 = !!cc && state.items.some((i) => i.ref === cc.id);
        Q('#layList').querySelector('.layRow[data-id="L2"]').click();
        await tick();
        // 文件读取是真 I/O（虚拟时间里慢）：同 pb-z-undo-and-import 的等法 —— 等「已导入布局」提示，最多重试 3 次
        for (let tryN = 0; tryN < 3; tryN++) {
          const before = toastTxt();
          const dt = new DataTransfer();
          dt.items.add(
            new File([JSON.stringify({ name: '导进来的', items: [], customCat: [] })], '方案-导进来的.json', {
              type: 'application/json',
            })
          );
          Q('#fileJson').files = dt.files;
          Q('#fileJson').dispatchEvent(new Event('change', { bubbles: true }));
          let got = false;
          for (let i2 = 0; i2 < 40 && !got; i2++) {
            await tick();
            got = toastTxt() !== before && /已导入/.test(toastTxt());
          }
          if (got) break;
        }
        const newOne =
          LAY.list.length === 3 && LAYOUTS.layoutById(LAY, LAY.cur).name === '导进来的' && LAY.other.L2.length === 3;
        const kept = !!cc && state.customCat.some((c) => c.id === cc.id);
        const resolves = !!cc && LAY.other.L1.filter((i) => i.ref === cc.id).every((i) => !!itemSpec(i));
        T(
          'pb-s24c-layout-import-keeps-others-custom',
          usedIn1 && newOne && state.items.length === 0 && kept && resolves,
          '方案 1 用着自制件=' +
            usedIn1 +
            ' · 新建了「导进来的」、方案 2 的 3 件不动=' +
            newOne +
            ' · 新方案 ' +
            state.items.length +
            ' 件 · 自制件还在目录里=' +
            kept +
            ' · 方案 1 那件认得出=' +
            resolves
        );
        // 收掉导进来的那套（两步删除），回到方案 2
        Q('#layDel').click();
        await tick();
        Q('#layDel').click();
        await tick();
        if (LAY.cur !== 'L2') Q('#layList').querySelector('.layRow[data-id="L2"]').click();
        await tick();
      }

      /* 46.10b（F3 起方案面板是下拉菜单）：在画布上按下 = 先关掉菜单；拖动中 Esc 让家具回原处；菜单开着时 Esc 关菜单 */
      {
        const it = state.items[0];
        selOnly(it.uid);
        drawFurniture();
        await tick();
        const x0 = it.x;
        const [sx, sy] = SPT(it.x, it.y);
        fire('pointerdown', sx, sy);
        await tick();
        fire('pointermove', sx + 40, sy, {});
        await tick();
        const moved = Math.abs(it.x - x0) > 0.5;
        key('Escape');
        await tick();
        const back = Math.abs(it.x - x0) < 1e-9 && Q('#layPanel').style.display === 'none';
        fire('pointerup', sx + 40, sy, { buttons: 0 });
        await tick();
        Q('#layBtn').click();
        await tick();
        const reopened = Q('#layPanel').style.display !== 'none';
        key('Escape');
        await tick();
        const closed = reopened && Q('#layPanel').style.display === 'none';
        Q('#layBtn').click(); // 后面的断言要面板开着
        await tick();
        T(
          'pb-s24c-esc-drag-first-then-panel',
          moved && back && closed,
          '拖开了=' + moved + ' · 按下就关了菜单、Esc 让家具回原处=' + back + ' · 菜单开着时 Esc 关菜单=' + closed
        );
      }

      /* 46.11 不止一套方案时，导出的采购清单 / 布局文件名说清是哪一套 */
      {
        const t2 = shoppingTitle();
        T(
          'pb-s24c-shopping-title-names-layout',
          /· 方案 2 · 采购清单/.test(t2) && layoutTag('-') === '-方案 2',
          '标题「' + t2 + '」· 文件名后缀「' + layoutTag('-') + '」'
        );
      }

      /* 46.7 改名 / 重名拒收 / 删除（两步）/ 只剩一套时不能删；刷新（重新读存档）后名字和当前方案都在 */
      Q('#layList').querySelector('.layRow[data-id="L1"]').click();
      await tick();
      Q('#layName').value = '沙发靠窗';
      Q('#layName').dispatchEvent(new Event('change'));
      await tick();
      const renamed = LAYOUTS.layoutById(LAY, 'L1').name === '沙发靠窗' && Q('#layCur').textContent === '沙发靠窗';
      Q('#layList').querySelector('.layRow[data-id="L2"]').click();
      await tick();
      Q('#layName').value = '沙发靠窗';
      Q('#layName').dispatchEvent(new Event('change'));
      await tick();
      const dupRejected = LAYOUTS.layoutById(LAY, 'L2').name === '方案 2' && /已经有一套叫/.test(toastTxt());
      Q('#layDup').click(); // 方案 3（复制方案 2）
      await tick();
      const n3 = LAY.list.length,
        cur3 = LAY.cur;
      Q('#layDel').click();
      await tick();
      const armed = LAY.list.length === 3 && Q('#layDel').classList.contains('arm');
      Q('#layDel').click();
      await tick();
      const delOk = LAY.list.length === 2 && !LAYOUTS.layoutById(LAY, cur3) && LAY.cur === 'L2';
      // 刷新：从存档重新读
      const before = JSON.stringify([LAY.cur, LAY.list]);
      load();
      const after = JSON.stringify([LAY.cur, LAY.list]);
      Q('#layList').querySelector('.layRow[data-id="L1"]') &&
        Q('#layList').querySelector('.layRow[data-id="L1"]').click();
      await tick();
      Q('#layDel').click();
      await tick();
      Q('#layDel').click();
      await tick();
      const lastOne = LAY.list.length === 1 && Q('#layDel').disabled;
      T(
        'pb-s24c-rename-delete-persist',
        renamed && dupRejected && n3 === 3 && armed && delOk && before === after && lastOne,
        '改名=' +
          renamed +
          ' · 重名拒收=' +
          dupRejected +
          ' · 复制后 ' +
          n3 +
          ' 套 · 第一下只是确认=' +
          armed +
          ' · 删掉=' +
          delOk +
          ' · 重新读存档 ' +
          before +
          ' → ' +
          after +
          ' · 只剩一套删除按钮灰=' +
          lastOne
      );

      /* 收尾 */
      Q('#layBtn').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      T(
        'pb-s24c-clean-exit',
        PLAN_ID !== p46Plan && PLAN_REG.plans.length === p46Plans && Q('#layPanel').style.display === 'none',
        'plans ' + p46Plans + '→' + PLAN_REG.plans.length
      );
    }

    /* ===== 47. S24d（research/13 U9）：目录按尺寸筛 ——「这面墙 2m，哪些沙发放得下」 ===== */
    {
      await pbReset();
      if (wallEdit.on) Q('#btnWallEdit').click();
      await tick();
      const p47Plans = PLAN_REG.plans.length;
      const toastTxt = () => (Q('#toast') || {}).textContent || '';
      const cards = () =>
        Array.from(Q('#catList').querySelectorAll('.catCard')).map(
          (c) => c.querySelector('[data-thumb]').dataset.thumb
        );
      const specOf = (id) => catalogAll().find((c) => c.id === id);
      const setIn = async (sel, v) => {
        Q(sel).value = String(v);
        Q(sel).dispatchEvent(new Event('input', { bubbles: true }));
        await tick();
      };
      const unitBtn = (u) => Q('#unitSeg button[data-u="' + u + '"]');
      const nAll = catalogAll().length;

      /* 47.1 bug 猎 #94：目录重建时不能丢掉搜索词（以前换单位 / 撤销 / 切户型 / 导入布局之后：框里写着「沙发」，目录显示全部） */
      await setIn('#catSearch', '沙发');
      const nSofa = cards().length;
      unitBtn('ft').click();
      await tick();
      const nAfterUnit = cards().length;
      unitBtn('cm').click();
      await tick();
      Q('#btnPlanNew').click();
      await tick();
      const p47Plan = PLAN_ID;
      const nAfterPlan = cards().length;
      T(
        'pb-s24d-hunt94-search-kept-on-rebuild',
        nSofa > 0 && nSofa < nAll && nAfterUnit === nSofa && nAfterPlan === nSofa,
        '搜「沙发」' + nSofa + ' 件（全部 ' + nAll + '）· 换单位后 ' + nAfterUnit + ' · 新建户型后 ' + nAfterPlan
      );
      await setIn('#catSearch', '');

      /* 47.2 宽 ≤ 100cm：只剩宽不超过 100 的；件数写在那一行末尾；框高亮 */
      await setIn('#catW', 100);
      const w100 = cards();
      const wantW = catalogAll().filter((c) => +c.w <= 100).length;
      T(
        'pb-s24d-width-filter',
        w100.length === wantW &&
          w100.every((id) => +specOf(id).w <= 100) &&
          Q('#catSizeN').textContent === wantW + ' 件' &&
          Q('#catSize').classList.contains('on') &&
          !Q('#catSizeClr').disabled,
        '宽 ≤ 100：显示 ' + w100.length + ' 件（应 ' + wantW + '）· 末尾「' + Q('#catSizeN').textContent + '」'
      );

      /* 47.3 再加深 ≤ 50 + 搜索词：三个条件一起 */
      await setIn('#catD', 50);
      await setIn('#catSearch', '柜');
      const both = cards();
      const wantB = catalogAll().filter(
        (c) =>
          +c.w <= 100 &&
          +c.d <= 50 &&
          (foldText(c.name).includes(foldText('柜')) || foldText(c.cat).includes(foldText('柜')))
      ).length;
      T(
        'pb-s24d-depth-and-text',
        both.length === wantB && both.every((id) => +specOf(id).w <= 100 && +specOf(id).d <= 50),
        '宽 ≤ 100 · 深 ≤ 50 · 「柜」：' + both.length + ' 件（应 ' + wantB + '）'
      );
      await setIn('#catSearch', '');

      /* 47.4「＝选中」：选中一张沙发 → 只看不比它大的（宽、深都不超过它） */
      const selBtn0 = Q('#catSizeSel').disabled;
      const sofaSpec = CATALOG.find((c) => c.kind === 'sofa' && c.w >= 200);
      addItem(sofaSpec.id);
      await tick();
      const selBtn1 = Q('#catSizeSel').disabled;
      Q('#catSizeSel').click();
      await tick();
      const fromSel = cards();
      T(
        'pb-s24d-no-bigger-than-selected',
        selBtn0 === true &&
          selBtn1 === false &&
          catSize.w === sofaSpec.w &&
          catSize.d === sofaSpec.d &&
          fromSel.includes(sofaSpec.id) &&
          fromSel.every((id) => +specOf(id).w <= sofaSpec.w && +specOf(id).d <= sofaSpec.d) &&
          Math.abs(+Q('#catW').value - sofaSpec.w) <= 0.5 &&
          toastTxt().indexOf(sofaSpec.name) >= 0,
        '没选中时按钮灰=' +
          selBtn0 +
          ' · 选中后可点=' +
          !selBtn1 +
          ' · 筛成 宽 ≤ ' +
          catSize.w +
          ' 深 ≤ ' +
          catSize.d +
          '（' +
          sofaSpec.name +
          ' ' +
          sofaSpec.w +
          '×' +
          sofaSpec.d +
          '）· ' +
          fromSel.length +
          ' 件'
      );

      /* 47.5 单位：英尺下框里是英寸（内部按 cm 存，不变）；在英尺下输入 36″ = 91.4cm */
      unitBtn('ft').click();
      await tick();
      const inchShown = +Q('#catW').value;
      await setIn('#catW', 36);
      const w36 = catSize.w;
      unitBtn('cm').click();
      await tick();
      T(
        'pb-s24d-follows-unit',
        Math.abs(inchShown - sofaSpec.w / 2.54) < 0.06 &&
          Math.abs(w36 - 91.4) < 0.06 &&
          +Q('#catW').value === 91 &&
          Q('#catSizeU').textContent === 'cm',
        '英尺下宽框 ' +
          inchShown +
          '（' +
          sofaSpec.w +
          'cm）· 输入 36 → ' +
          w36 +
          'cm · 回到 cm 显示 ' +
          Q('#catW').value
      );

      /* 47.6 一件都没有：说清是哪几个条件挡住的 */
      await setIn('#catW', 1);
      const em = Q('#catList .catEmpty');
      T(
        'pb-s24d-empty-state',
        cards().length === 0 && !!em && /宽 ≤ 1 cm/.test(em.textContent) && /「清除」/.test(em.textContent),
        em ? '「' + em.textContent + '」' : '没有空结果说明'
      );

      /* 47.7 自己造一件被尺寸筛挡住的：尺寸筛清掉、刚造的那件看得见（轮㉑：刚造的必须看得见） */
      Q('#cfName').value = '测试大书架';
      Q('#cfW').value = '120';
      Q('#cfD').value = '35';
      Q('#cfH').value = '200';
      Q('#cfAdd').click();
      await tick();
      const cc = state.customCat[state.customCat.length - 1];
      T(
        'pb-s24d-custom-add-not-hidden',
        !!cc && catSize.w == null && catSize.d == null && cards().includes(cc.id) && Q('#catW').value === '',
        '尺寸筛 ' + JSON.stringify(catSize) + ' · 新件在目录里=' + (!!cc && cards().includes(cc.id))
      );

      /* 47.8「×」清掉 = 全部回来 */
      await setIn('#catW', 80);
      Q('#catSizeClr').click();
      await tick();
      T(
        'pb-s24d-clear',
        cards().length === catalogAll().length &&
          catSize.w == null &&
          !Q('#catSize').classList.contains('on') &&
          Q('#catSizeN').textContent === '',
        '清掉后 ' + cards().length + ' / ' + catalogAll().length
      );

      /* 收尾 */
      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      T(
        'pb-s24d-clean-exit',
        PLAN_ID !== p47Plan && PLAN_REG.plans.length === p47Plans,
        'plans ' + p47Plans + '→' + PLAN_REG.plans.length
      );
    }

    /* ===== 48. S24e（research/13 U10）：家具剪贴板 Ctrl/⌘+C / X / V —— 粘到视图中心附近的空位，能跨方案 / 楼层 / 户型 ===== */
    {
      await pbReset();
      if (wallEdit.on) Q('#btnWallEdit').click();
      await tick();
      const p48Plans = PLAN_REG.plans.length;
      const near = (a, b, tol) => Math.abs(a - b) < (tol || 1e-6);
      const toastTxt = () => (Q('#toast') || {}).textContent || '';
      const ck = (k, code) => {
        const e = new KeyboardEvent('keydown', { key: k, code, ctrlKey: true, bubbles: true, cancelable: true });
        document.body.dispatchEvent(e);
        return e;
      };
      Q('#btnPlanNew').click();
      await tick();
      const p48Plan = PLAN_ID;
      const fp48 = floorPts();
      const X =
          Math.min.apply(
            null,
            fp48.map((p) => p[0])
          ) + 1,
        Y =
          Math.min.apply(
            null,
            fp48.map((p) => p[1])
          ) + 1;
      const wd = cmToWd(15);
      pushUserWall(X, Y, X + 26, Y, 'w', wd);
      pushUserWall(X + 26, Y, X + 26, Y + 18, 'w', wd);
      pushUserWall(X + 26, Y + 18, X, Y + 18, 'w', wd);
      pushUserWall(X, Y + 18, X, Y, 'w', wd);
      geoChanged();
      fit2DToContent();
      await tick();
      const sofa = CATALOG.find((c) => c.kind === 'sofa' && c.w <= 230 && c.d <= 100);
      const table =
        CATALOG.find((c) => c.kind === 'coffee' || /茶几/.test(c.name)) || CATALOG.find((c) => c.kind === 'table');
      addItem(sofa.id, { x: X + 5, y: Y + 3 });
      addItem(table.id, { x: X + 5, y: Y + 6.5, rot: 0 });
      await tick();
      const [a0, b0] = state.items.slice(-2);
      const rel0 = [b0.x - a0.x, b0.y - a0.y];

      /* 48.1 复制一组 → 新建一套空白方案 → 粘贴：两件都来了、相对位置不变、选中这两件、一步撤销、都不红 */
      selSetMany([a0.uid, b0.uid], a0.uid);
      drawFurniture();
      const eC = ck('c', 'KeyC');
      await tick();
      const copied = /已复制 2 件/.test(toastTxt()) && !eC.defaultPrevented;
      Q('#layBtn').click();
      await tick();
      Q('#layNew').click();
      await tick();
      const r0 = undoRing.length;
      ck('v', 'KeyV');
      await tick();
      const [a1, b1] = state.items;
      const pasted =
        state.items.length === 2 &&
        !!a1 &&
        !!b1 &&
        a1.ref === sofa.id &&
        b1.ref === table.id &&
        near(b1.x - a1.x, rel0[0], 1e-3) &&
        near(b1.y - a1.y, rel0[1], 1e-3) &&
        selUids().length === 2 &&
        undoRing.length === r0 + 1 &&
        state.items.every((i) => !(furnWhy.get(i.uid) || []).length);
      T(
        'pb-s24e-copy-paste-into-other-layout',
        copied && pasted,
        '复制提示=' +
          copied +
          ' · 空白方案里粘了 ' +
          state.items.length +
          ' 件 · 相对位置 ' +
          (a1 && b1 ? (b1.x - a1.x).toFixed(2) + ',' + (b1.y - a1.y).toFixed(2) : '?') +
          '（原 ' +
          rel0.map((v) => v.toFixed(2)).join(',') +
          '）· 选中 ' +
          selUids().length +
          ' · 撤销 +' +
          (undoRing.length - r0) +
          ' · 冲突 ' +
          JSON.stringify(state.items.map((i) => furnWhy.get(i.uid) || []))
      );

      /* 48.2 再粘一次：落在旁边放得下的地方（不与刚才那组叠在一起） */
      ck('v', 'KeyV');
      await tick();
      const noOverlap = state.items.length === 4 && state.items.every((i) => !(furnWhy.get(i.uid) || []).length);
      T(
        'pb-s24e-paste-again-finds-free-spot',
        noOverlap,
        '粘第二次后 ' +
          state.items.length +
          ' 件 · 冲突 ' +
          JSON.stringify(state.items.map((i) => furnWhy.get(i.uid) || []))
      );

      /* 48.3 剪切 = 复制 + 删（一步撤销）；剪完粘回来 */
      const keep = state.items.slice(0, 2).map((i) => i.uid);
      selSetMany(state.items.slice(2).map((i) => i.uid));
      const rX = undoRing.length;
      ck('x', 'KeyX');
      await tick();
      const cutOk = state.items.length === 2 && undoRing.length === rX + 1 && /已剪切 2 件/.test(toastTxt());
      ck('v', 'KeyV');
      await tick();
      const backOk = state.items.length === 4 && keep.every((u) => state.items.some((i) => i.uid === u));
      T('pb-s24e-cut-then-paste', cutOk && backOk, '剪切后 2 件、撤销 +1=' + cutOk + ' · 粘回来 4 件=' + backOk);

      /* 48.4 自定义件跨户型：在这份户型复制一件自制家具 → 切到另一份（有存档、但没有这个条目的）户型粘贴 → 它的目录条目一起带过去（不是「目录里没有」） */
      Q('#btnPlanNew').click(); // B 先建好：它的存档里没有等下才造的那件
      await tick();
      const p48b = PLAN_ID;
      switchPlan(p48Plan, true);
      await tick();
      Q('#cfName').value = '测试自制矮柜';
      Q('#cfW').value = '60';
      Q('#cfD').value = '40';
      Q('#cfH').value = '50';
      Q('#cfAdd').click();
      await tick();
      const cc = state.customCat[state.customCat.length - 1];
      const ci = state.items[state.items.length - 1];
      selOnly(ci.uid);
      ck('c', 'KeyC');
      await tick();
      switchPlan(p48b, true);
      await tick();
      const hadCat = state.customCat.some((c) => c.id === cc.id);
      ck('v', 'KeyV');
      await tick();
      const pc = state.items[state.items.length - 1];
      T(
        'pb-s24e-paste-custom-into-other-plan',
        !hadCat &&
          !!pc &&
          pc.ref === cc.id &&
          !!itemSpec(pc) &&
          state.customCat.some((c) => c.id === cc.id) &&
          /自定义目录条目/.test(toastTxt()),
        '另一份户型原来没有这个条目=' +
          !hadCat +
          ' · 粘过来认得出=' +
          !!(pc && itemSpec(pc)) +
          ' · 提示「' +
          toastTxt() +
          '」'
      );
      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      if (PLAN_ID !== p48Plan) switchPlan(p48Plan, true);
      await tick();

      /* 48.5 粘到另一层：复制一层的件 → 切到二层粘 → 落在二层 */
      const up = addLevelUI('above');
      await tick();
      switchLevel('lv1', true);
      await tick();
      const one = state.items.find((i) => itemLevel(i) === 'lv1');
      selOnly(one.uid);
      ck('c', 'KeyC');
      switchLevel(up.id, true);
      await tick();
      ck('v', 'KeyV');
      await tick();
      const pl = state.items[state.items.length - 1];
      T(
        'pb-s24e-paste-onto-other-level',
        !!pl && pl.ref === one.ref && itemLevel(pl) === up.id && selected === pl.uid,
        '粘在 ' + (pl ? levelName(itemLevel(pl)) : '?') + '（要「' + levelName(up.id) + '」）'
      );
      switchLevel('lv1', true);
      await tick();

      /* 48.6 拦在该拦的地方：剪贴板空 → 说一句；编辑墙体 / 室内视角 → 不动家具；输入框里 Ctrl+V 是粘文字（不碰家具） */
      const clip0 = furnClip;
      furnClip = null;
      ck('v', 'KeyV');
      await tick();
      const emptyMsg = /剪贴板是空的/.test(toastTxt());
      furnClip = clip0;
      const n0 = state.items.length;
      const inp = Q('#catSearch');
      inp.focus();
      inp.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', ctrlKey: true, bubbles: true, cancelable: true })
      );
      await tick();
      inp.blur();
      const inField = state.items.length === n0;
      Q('#btnWallEdit').click();
      await tick();
      ck('v', 'KeyV');
      await tick();
      const inEdit = state.items.length === n0 && /改户型时不能复制家具/.test((Q('#wMsg') || {}).textContent || '');
      Q('#btnWallEdit').click();
      await tick();
      T(
        'pb-s24e-keys-gated',
        emptyMsg && inField && inEdit,
        '空剪贴板有提示=' + emptyMsg + ' · 输入框里不粘家具=' + inField + ' · 编辑墙体里不粘=' + inEdit
      );

      /* 48.7 快捷键表里有这一行 */
      T(
        'pb-s24e-in-keys-table',
        INPUT_MAP.some((r) => r.k.includes('Ctrl/⌘+C') && r.k.includes('Ctrl/⌘+V') && /另一套方案/.test(r.a)),
        JSON.stringify(INPUT_MAP.filter((r) => r.k.some((k) => /Ctrl\/⌘\+[CVD]/.test(k))).map((r) => r.k))
      );

      /* 收尾 */
      Q('#layBtn').click();
      await tick();
      if (PLAN_ID !== p48Plan) switchPlan(p48Plan, true);
      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      T(
        'pb-s24e-clean-exit',
        PLAN_ID !== p48Plan && PLAN_REG.plans.length === p48Plans,
        'plans ' + p48Plans + '→' + PLAN_REG.plans.length
      );
    }

    /* ===== 49. S24f（research/13 U12）：高家具挡窗 = 黄框提示（不是红：挡窗不是「放不下」） ===== */
    {
      await pbReset();
      if (wallEdit.on) Q('#btnWallEdit').click();
      await tick();
      const p49Plans = PLAN_REG.plans.length;
      Q('#btnPlanNew').click();
      await tick();
      const p49Plan = PLAN_ID;
      const fp49 = floorPts();
      const X =
          Math.min.apply(
            null,
            fp49.map((p) => p[0])
          ) + 1,
        Y =
          Math.min.apply(
            null,
            fp49.map((p) => p[1])
          ) + 1;
      const wd = cmToWd(15);
      // 北墙中间一扇 6ft 的窗（窗台 90cm、窗头 210cm）
      pushUserWall(X, Y, X + 5, Y, 'w', wd);
      const win = pushUserWindow(X + 5, Y, X + 11, Y, wd);
      win.sill = 90 / 30.48;
      win.head = 210 / 30.48;
      pushUserWall(X + 11, Y, X + 16, Y, 'w', wd);
      pushUserWall(X + 16, Y, X + 16, Y + 12, 'w', wd);
      pushUserWall(X + 16, Y + 12, X, Y + 12, 'w', wd);
      pushUserWall(X, Y + 12, X, Y, 'w', wd);
      geoChanged();
      fit2DToContent();
      await tick();
      const face = Y + wd / S / 2; // 窗的室内墙皮
      const mk = (name, w, d, h, x, y, extra) => {
        const it = Object.assign(
          { uid: uidSeq++, custom: { name, w, d, h, color: '#7d6e5c' }, x, y, rot: 0 },
          extra || {}
        );
        state.items.push(it);
        return it;
      };
      const wk = (it) => furnWarn.get(it.uid) || [];
      const rk = (it) => furnWhy.get(it.uid) || [];
      const gOf = (it) => pbSvg.querySelector('g.furn[data-uid="' + it.uid + '"]');
      const strokeOf = (it) => {
        const g = gOf(it),
          sh = g && g.querySelector('rect,circle');
        return sh ? sh.getAttribute('stroke') : '';
      };

      /* 49.1 书柜（高 200）贴着窗放 = 黄；窗下的矮柜（高 75）不算；书柜挪开 2ft 不算 */
      const book = mk('测试书柜', 80, 30, 200, X + 7, face + 15 / 30.48 + 0.05);
      const low = mk('测试矮柜', 80, 45, 75, X + 9.8, face + 22.5 / 30.48 + 0.05); // 与书柜不重叠，沿窗挡住 2.5ft，但比窗台还矮
      selOnly(book.uid);
      drawFurniture();
      await tick();
      const line = gDoorBlk ? gDoorBlk.querySelector('.winBlk[data-win="' + win.id + '"]') : null;
      const t1 =
        (gOf(book) && gOf(book).querySelector('title') ? gOf(book).querySelector('title').textContent : '') || '';
      const panel1 = Q('#pClear').textContent,
        col1 = Q('#pClear').style.color;
      const blocked =
        wk(book).includes('blocksWin') &&
        !rk(book).length &&
        strokeOf(book) === '#e8b93c' &&
        gOf(book).classList.contains('blocksWin') &&
        /挡在窗前/.test(t1) &&
        !!line &&
        /挡在窗前/.test(panel1) &&
        !!col1;
      const lowOk = !wk(low).length && !rk(low).length;
      const wk1 = JSON.stringify(wk(book)),
        st1 = strokeOf(book);
      book.y = face + 15 / 30.48 + 2;
      drawFurniture();
      await tick();
      const awayOk = !wk(book).length && !(gDoorBlk && gDoorBlk.querySelector('.winBlk'));
      T(
        'pb-s24f-tall-in-front-of-window-is-yellow',
        blocked && lowOk && awayOk,
        '书柜贴窗：黄=' +
          blocked +
          '（' +
          wk1 +
          ' · 描边 ' +
          st1 +
          ' · 窗上黄线=' +
          !!line +
          ' · 面板「' +
          panel1 +
          '」）· 窗下矮柜不算=' +
          lowOk +
          ' · 书柜挪开 2ft 不算=' +
          awayOk
      );

      /* 49.2 挂在窗头以上的搁板不算；大绿植不算（摆在窗边是故意的） */
      book.y = face + 15 / 30.48 + 0.05;
      const shelf = mk('测试搁板', 120, 25, 20, X + 8, face + 12.5 / 30.48 + 0.05, { z: 215 / 30.48 });
      const plant = mk('测试大绿植', 60, 60, 200, X + 10, face + 30 / 30.48 + 0.05);
      plant.custom.kind = 'plant';
      book.x = X + 6.4; // 让开搁板（高度不重叠本来也不算撞，挪开只是让断言读得清）
      drawFurniture();
      await tick();
      T(
        'pb-s24f-shelf-above-and-plant-not-flagged',
        !wk(shelf).length && !wk(plant).length && wk(book).includes('blocksWin'),
        '窗头以上的搁板 ' +
          JSON.stringify(wk(shelf)) +
          ' · 绿植 ' +
          JSON.stringify(wk(plant)) +
          ' · 书柜照旧 ' +
          JSON.stringify(wk(book))
      );
      state.items = state.items.filter((i) => i !== shelf && i !== plant && i !== low);

      /* 49.3 落地窗：沙发（高 85）挡不到一半 = 不算；衣柜（高 200）= 黄 */
      win.fullHeight = true;
      geoChanged();
      book.x = X + 15; // 挪到窗外那段墙前（不挡窗）
      book.y = Y + 6;
      const sofa = mk('测试沙发', 220, 90, 85, X + 8, face + 45 / 30.48 + 0.05);
      drawFurniture();
      await tick();
      const sofaOk = !wk(sofa).length;
      sofa.y = Y + 8;
      const ward = mk('测试衣柜', 150, 60, 200, X + 8, face + 30 / 30.48 + 0.05);
      drawFurniture();
      await tick();
      T(
        'pb-s24f-full-height-window',
        sofaOk && wk(ward).includes('blocksWin'),
        '落地窗前的沙发不算=' + sofaOk + ' · 衣柜 ' + JSON.stringify(wk(ward))
      );

      /* 49.4 红优先：既挡窗又和别的件重叠 = 红框，悬停两条原因都写 */
      const box = mk('测试箱子', 60, 40, 60, ward.x + 0.6, ward.y);
      drawFurniture();
      await tick();
      const tt =
        (gOf(ward) && gOf(ward).querySelector('title') ? gOf(ward).querySelector('title').textContent : '') || '';
      T(
        'pb-s24f-red-wins-both-listed',
        rk(ward).includes('overlap') &&
          wk(ward).includes('blocksWin') &&
          strokeOf(ward) === '#e05656' &&
          /重叠/.test(tt) &&
          /挡在窗前/.test(tt),
        '描边 ' + strokeOf(ward) + ' · 悬停「' + tt + '」'
      );
      state.items = state.items.filter((i) => i !== box);
      drawFurniture();

      /* 49.5（顺手）选中框下的尺寸字：件转过半圈时翻正（以前跟着件一起倒过来） */
      ward.rot = 180;
      selOnly(ward.uid);
      drawFurniture();
      await tick();
      const dl = pbSvg.querySelector('.selBox .selDims');
      const tr = dl ? dl.getAttribute('transform') || '' : '';
      ward.rot = 0;
      drawFurniture();
      await tick();
      const dl0 = pbSvg.querySelector('.selBox .selDims');
      T(
        'pb-s24f-selection-dims-upright',
        /^rotate\(180 /.test(tr) && !!dl0 && !dl0.getAttribute('transform'),
        '转 180° 时尺寸字 transform=「' + tr + '」· 0° 时=「' + (dl0 ? dl0.getAttribute('transform') : '?') + '」'
      );

      /* 收尾 */
      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      T(
        'pb-s24f-clean-exit',
        PLAN_ID !== p49Plan && PLAN_REG.plans.length === p49Plans,
        'plans ' + p49Plans + '→' + PLAN_REG.plans.length
      );
    }

    /* ===== 50. facelift F5（research/14 X12 X26 X34 X41 · facelift §2.9 §4）：空状态卡、色温只标选中那盏、检视面板不报坐标、提示两段 ===== */
    {
      await pbReset();
      if (wallEdit.on) setWallEdit(false);
      await tick();
      const p50Plans = PLAN_REG.plans.length;
      Q('#btnPlanNew').click();
      await tick();
      const p50Plan = PLAN_ID;
      const ecShown = () => getComputedStyle(Q('#emptyCard')).display !== 'none';
      /* 50.1 空白户型 = 画布中间「这份户型还没有墙」；「画外墙」= 改户型 + 画墙工具，卡片让位；画了墙再出来也不回来 */
      const shown0 = ecShown() && !wallEdit.on;
      Q('#ecDraw').click();
      await tick();
      const drawOn = wallEdit.on && wallEdit.area === 'build' && wallEdit.tool === 'wall' && !ecShown();
      setWallEdit(false);
      await tick();
      const backAgain = ecShown(); // 还没墙：出来卡片照样在
      const fp50 = floorPts();
      const X =
          Math.min.apply(
            null,
            fp50.map((p) => p[0])
          ) + 1,
        Y =
          Math.min.apply(
            null,
            fp50.map((p) => p[1])
          ) + 1;
      const wd = cmToWd(15);
      pushUserWall(X, Y, X + 14, Y, 'w', wd);
      pushUserWall(X + 14, Y, X + 14, Y + 10, 'w', wd);
      pushUserWall(X + 14, Y + 10, X, Y + 10, 'w', wd);
      pushUserWall(X, Y + 10, X, Y, 'w', wd);
      geoChanged();
      fit2DToContent();
      await tick();
      T(
        'pb-f5-empty-card',
        shown0 && drawOn && backAgain && !ecShown(),
        '新建时显示=' +
          shown0 +
          ' · 画外墙进了画墙工具且卡片让位=' +
          drawOn +
          ' · 没墙出来仍在=' +
          backAgain +
          ' · 有墙后=' +
          ecShown()
      );

      /* 50.2 吸顶 / 筒灯的「3000K」只在选中那盏时标（以前每盏都标：满图色温噪声） */
      const lamp = { uid: uidSeq++, ref: 'dl-4', x: X + 7, y: Y + 5, rot: 0 };
      state.items.push(lamp);
      selOnly(null);
      drawFurniture();
      await tick();
      const kOf = () => {
        const g = pbSvg.querySelector('g.furn[data-uid="' + lamp.uid + '"]');
        return g ? [...g.querySelectorAll('text')].filter((t) => /\d+K$/.test(t.textContent)).length : -1;
      };
      const k0 = kOf();
      selOnly(lamp.uid);
      drawFurniture();
      await tick();
      const k1 = kOf();
      T('pb-f5-cct-only-selected', k0 === 0 && k1 === 1, '没选中时色温字 ' + k0 + ' 个 · 选中后 ' + k1 + ' 个');
      state.items = state.items.filter((i) => i !== lamp);

      /* 50.3 检视面板：尺寸一种写法「宽 × 深 × 高 cm」；不报坐标，改报离最近的墙多远（独立量：沙发上沿到墙皮 = 15cm） */
      const face = Y + wd / S / 2;
      const sofa = {
        uid: uidSeq++,
        custom: { name: '测试沙发', w: 200, d: 90, h: 80, color: '#7d6e5c' },
        x: X + 7,
        y: face + 15 / 30.48 + 45 / 30.48,
        rot: 0,
      };
      state.items.push(sofa);
      selOnly(sofa.uid);
      drawFurniture();
      updateProps();
      await tick();
      const clr = Q('#pClear').textContent,
        dims = Q('#pDims').textContent;
      T(
        'pb-f5-props-dims-and-clearance',
        dims === '200 × 90 × 80 cm' && /^离最近的墙 15 cm$/.test(clr) && !/位置|\(/.test(clr),
        '尺寸「' + dims + '」· 面板「' + clr + '」'
      );
      state.items = state.items.filter((i) => i !== sofa);
      selOnly(null);
      drawFurniture();

      /* 50.4 改户型提示行「状态 ｜ 操作」：两段分开着色，文字本身不变 */
      wMsg('原有的墙 · 长 3 m ｜ 拖圆点=改端点');
      const wm = Q('#wMsg'),
        wa = wm.querySelector('.wa');
      T(
        'pb-f5-wmsg-two-tone',
        wm.textContent === '原有的墙 · 长 3 m ｜ 拖圆点=改端点' && !!wa && wa.textContent.indexOf('｜') === 0,
        'textContent「' + wm.textContent + '」· 操作段「' + (wa ? wa.textContent : '无') + '」'
      );
      wMsg('');

      /* 50.6 QA Q01：画墙点回起点 = 收口并结束（4 段）；手上还在画的一条链点「完成」= 先提交（以前整条静默丢掉、撤销找不回） */
      {
        enterArea('build');
        await tick();
        Q('#wtoolSeg button[data-t="wall"]').click();
        await tick();
        const w0 = effWalls().length;
        const clk = async (x, y) => {
          const [a, b] = SPT(x, y);
          fire('pointerdown', a, b);
          await tick();
          fire('pointerup', a, b);
          await tick();
        };
        for (const [x, y] of [
          [X + 2, Y + 2],
          [X + 6, Y + 2],
          [X + 6, Y + 5],
          [X + 2, Y + 5],
          [X + 2, Y + 2],
        ])
          await clk(x, y);
        const loopN = effWalls().length - w0,
          loopPts = wallEdit.drawPts.length;
        await clk(X + 8, Y + 2);
        await clk(X + 11, Y + 2);
        const w1 = effWalls().length;
        Q('#wDone').click();
        await tick();
        const doneN = effWalls().length - w1;
        T(
          'pb-f5-qa-wall-loop-and-done-commit',
          loopN === 4 && loopPts === 0 && doneN === 1 && !wallEdit.on,
          '点回起点 = ' + loopN + ' 段、链上剩 ' + loopPts + ' 点 · 画了一半点「完成」= +' + doneN + ' 段'
        );
      }

      /* 50.7 QA Q02：窗 → 洁具换着选，窗的那组控件不许留在检视面板里（死控件） */
      {
        enterArea('build');
        await tick();
        const wn = pushUserWindow(X + 3, Y + 10, X + 7, Y + 10, cmToWd(15));
        const fx = pushUserFixture('toilet', X + 12, Y + 8, 0);
        geoChanged();
        await tick();
        wallEdit.sel = { kind: 'w', id: wn.id };
        updateWallBarFromSel();
        const winOn = Q('#winCtl').classList.contains('on');
        wallEdit.sel = { kind: 'fx', id: fx.id };
        updateWallBarFromSel();
        const left = ['#winCtl', '#doorCtl'].filter((id) => Q(id).classList.contains('on'));
        T(
          'pb-f5-qa-no-stale-ctl',
          winOn && left.length === 0 && Q('#fxCtl').classList.contains('on'),
          '选窗时窗控件亮=' + winOn + ' · 换成洁具后还亮着的：' + (left.join(' ') || '无')
        );
        wallEdit.sel = null;
        setWallEdit(false);
        await tick();
      }

      /* 50.8 QA N1：右栏停在「清单」时进装修 = 切到检视，全屋地板色块网格是满的（色块只在看得见时才建） */
      {
        showPropsTab('list');
        enterArea('deco');
        await tick();
        const nSw = Q('#lvFloorL').querySelectorAll('button').length;
        T(
          'pb-f5-qa-deco-from-list-swatches',
          _propsTab === 'insp' && nSw > 5,
          '进装修后右栏=' + _propsTab + ' · 全屋地板色块 ' + nSw + ' 个'
        );
        setWallEdit(false);
        showPropsTab('insp');
        await tick();
      }

      /* 50.9 UX r2：X26 缺省全屋地板 2D 也画；X47 选中房间时全屋卡收成一行、房间地板紧接标题；X48 选中只描边不铺色；X21 摆家具里点空地板 = 房间摘要 */
      {
        const lvF = pbSvg.querySelector('.levelFloor');
        const r50 = pickRoomAt(X + 7, Y + 5);
        enterArea('deco');
        wallEdit.sel = { kind: 'room', id: r50.id };
        drawWallEdit();
        updateWallBarFromSel();
        await tick();
        const L = Q('#lvFloorL');
        const roomRowTop = Q('#rmFloor').closest('.irow').getBoundingClientRect().top;
        const lvTop = L.getBoundingClientRect().top;
        const sel = pbSvg.querySelector('.rmSel');
        T(
          'pb-f5-ux-room-first-default-floor',
          !!lvF && L.classList.contains('mini') && roomRowTop < lvTop && !!sel && sel.getAttribute('fill') === 'none',
          '缺省全屋地板画了=' +
            !!lvF +
            ' · 全屋卡收起=' +
            L.classList.contains('mini') +
            ' · 房间地板在上=' +
            (roomRowTop < lvTop) +
            ' · 选中填充=' +
            (sel ? sel.getAttribute('fill') : '无')
        );
        setWallEdit(false);
        await tick();
        roomSummaryAt(X + 7, Y + 5);
        T(
          'pb-f5-ux-room-summary',
          /^房间 · /.test(Q('#pTitle').textContent) && !!Q('#pInfo').querySelector('button.decoLink'),
          '「' + Q('#pTitle').textContent + '」' + Q('#pInfo').textContent.slice(0, 40)
        );
        _roomSummary = null;
        updateProps();
      }

      /* 50.5 引导卡：「? 帮助 → 快速上手」重开后按钮也是活的（以前只在首次出现时才绑） */
      T(
        'pb-f5-firstrun-buttons-bound',
        typeof Q('#frStart').onclick === 'function' &&
          typeof Q('#frBlank').onclick === 'function' &&
          typeof Q('#frImport').onclick === 'function' &&
          Q('#firstRun h3').textContent === '欢迎来到 MiniDen',
        '三个按钮都绑上了'
      );

      Q('#btnPlanDel').click();
      await tick();
      Q('#btnPlanDel').click();
      await tick();
      T(
        'pb-f5-clean-exit',
        PLAN_ID !== p50Plan && PLAN_REG.plans.length === p50Plans,
        'plans ' + p50Plans + '→' + PLAN_REG.plans.length
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
