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
           缩放中心从 floorPts() 包络独立算，不照抄实现。 */
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
      T('pb-zero-totals-counted', /采购\s*3\s*件/.test(zTot), '#totals = ' + JSON.stringify(zTot.slice(0, 40)));

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
      T('pb-edit-toolbar-hidden-in-3d', bar25() === 'none', '3D 俯瞰里 #wallbar display=' + bar25());

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
