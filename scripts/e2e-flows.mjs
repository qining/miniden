/* E21 E2E 流程定义（配合 scripts/e2e.mjs）
 *
 * 口径：
 *  - 一律 plan-independent：坐标从运行时派生（FLOORPTS / LABELS / 元素 rect），不写死某个户型
 *  - 走真实输入：CDP Input.dispatchMouseEvent / dispatchKeyEvent → isTrusted=true，
 *    经过浏览器输入管线（pointer capture、hover、focus、dblclick、真实 confirm()、真实文件选择）
 *  - 每条流程自己收尾（删掉加的东西）；驱动层结束后还会真实刷新一次
 */

async function planCenter(t) {
  const p = await t.eval(
    `(()=>{const P=FLOORPTS;let x1=1e9,y1=1e9,x2=-1e9,y2=-1e9;
      for(const q of P){x1=Math.min(x1,q[0]);y1=Math.min(y1,q[1]);x2=Math.max(x2,q[0]);y2=Math.max(y2,q[1]);}
      return [(x1+x2)/2,(y1+y2)/2];})()`
  );
  return { x: p[0], y: p[1] };
}

/* 两个流程都要用的第二层工具条 / 户型切换（#btnMore 是开关：只在关着的时候点） */
async function ensureProTools(t) {
  // 判展开必须读真正被 display:none 的那个容器：子元素的计算 display 不继承父级的 none
  const open = await t.eval(`getComputedStyle(document.querySelector('#proTools')).display!=='none'`);
  if (open) return;
  await t.click('#btnMore');
  await t.waitFor(`getComputedStyle(document.querySelector('#proTools')).display!=='none'`, 5000, '「工具」第二层展开');
}
async function pickPlan(t, id) {
  // BUILTIN_PLAN_ID / 生成的 id 都是页面里的名字，Node 侧要先取回来再传进去
  return t.eval(
    `(()=>{const s=document.querySelector('#planSel'); s.value=${JSON.stringify(id)};` +
      `s.dispatchEvent(new Event('change',{bubbles:true}));})()`
  );
}

const stateOf = (t) =>
  t.eval(
    `({items: state.items.length, view: state.view, unit: state.unit, cur: curNow(),
       walls: DOC.walls.length, fixtures: DOC.fixtures.length, doors: DOC.doors.length,
       imported: docImported(), selected: selected})`
  );

export const FLOWS = [
  {
    name: 'startup',
    title: '打开即是可用状态（目录全、缩略图已渲、无预置冲突）',
    run: async (t) => {
      await t.step('读取初始状态');
      const s = await stateOf(t);
      // 缩略图是 IO + 每帧分批渲的（真实时间下需要等它跑完）；等「可见卡片全部渲完」
      await t
        .waitFor(
          `(()=>{const v=[...document.querySelectorAll('.catCard')].filter(k=>{const b=k.getBoundingClientRect();return b.height>20&&b.top<innerHeight&&b.bottom>0;});
            return v.length>0 && v.every(k=>k.querySelector('.ph.has'));})()`,
          15000,
          '可见卡片缩略图渲完'
        )
        .catch(() => {});
      const c = await t.eval(
        `(()=>{const cards=[...document.querySelectorAll('.catCard')];
          const vis=cards.filter(k=>{const b=k.getBoundingClientRect();return b.height>20&&b.top<innerHeight&&b.bottom>0;});
          const done=vis.filter(k=>k.querySelector('.ph.has')).length;
          return {cards:cards.length, catalog:CATALOG.length, vis:vis.length, thumbs:done,
           seeded:((JSON.parse(document.querySelector('#miniden-plan').textContent).layout||{}).items||[]).length,
           red:document.querySelectorAll('#furn [stroke="#e05656"]').length,
           title:document.title, sub:document.querySelector('#titleSub').textContent};})()`
      );
      t.assert('startup-catalog-cards', c.cards === c.catalog, `卡片 ${c.cards} = 目录 ${c.catalog}`);
      t.assert(
        'startup-thumbs-visible-rendered',
        c.vis >= 4 && c.thumbs === c.vis,
        `可见卡片 ${c.vis} 张，缩略图已渲 ${c.thumbs} 张`
      );
      t.assert('startup-layout-seeded', s.items === c.seeded, `家具 ${s.items} = 户型内置布局 ${c.seeded}`);
      t.assert('startup-view-2d', s.view === '2d', 'view=' + s.view);
      t.assert('startup-no-overlap', c.red === 0, `初始红描边 ${c.red} 个`);
      t.info('startup-title', c.title + ' · ' + c.sub);
      await t.shot('startup');
    },
  },

  {
    name: 'first-run',
    title: '首次打开的引导卡：出现 → 三条路 → 关一次就不再出现',
    run: async (t) => {
      // 这张卡只在「什么都没存过 + 干净 profile」时出现；驱动层默认会替流程把它关掉，
      // 本流程自己接手。
      t.keepFirstRun = true;
      await t.freshState();
      const vis = await t.firstRunVisible();
      t.assert('firstrun-visible', vis, '清掉存档 + 刷新后引导卡出现');
      const r = await t.rectOf('#firstRun').catch(() => null);
      t.assert(
        'firstrun-size',
        !!r && r.w >= 240 && r.h >= 140,
        r ? Math.round(r.w) + '×' + Math.round(r.h) + 'px' : '不在视口'
      );
      const top = await t.eval(
        `(()=>{const e=document.querySelector('#firstRun');const r=e.getBoundingClientRect();
          const hit=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
          return hit ? (hit.id||hit.className||hit.tagName)+'|inside='+(e.contains(hit)||hit===e) : 'null';})()`
      );
      t.assert('firstrun-topmost', /inside=true$/.test(String(top)), '画布中心最上层元素=' + top);
      const paths = await t.eval(
        `(()=>[...document.querySelectorAll('#firstRun .frRow')].map(p=>p.querySelector('b').textContent.trim()))()`
      );
      t.assert('firstrun-three-paths', Array.isArray(paths) && paths.length === 3, paths.join(' / '));
      await t.shot('firstrun');

      await t.step('走「从空白开始画」');
      await t.click('#frBlank');
      await t.waitFor(
        `!document.querySelector('#firstRun') || getComputedStyle(document.querySelector('#firstRun')).display==='none'`,
        6000,
        '引导卡关闭'
      );
      t.assert(
        'firstrun-blank-plan',
        await t.eval(`PLAN_ID!==BUILTIN_PLAN_ID && effWalls().length===0`),
        '切到一份空白户型'
      );
      t.assert('firstrun-edit-on', await t.eval(`wallEdit.on===true`), '直接进了「编辑墙体」');
      const hint = await t.eval(
        `(()=>{const h=document.querySelector('#wMsg'); if(!h) return '';
          const cs=getComputedStyle(h); const r=h.getBoundingClientRect();
          return (cs.display==='none'||r.width<8)?'':h.textContent.trim();})()`
      );
      t.assert('firstrun-edit-hint-visible', String(hint).length > 8, String(hint).slice(0, 70));
      await t.shot('firstrun-blank');

      await t.step('刷新后不再出现（一次性）');
      await t.reload();
      t.assert('firstrun-once', (await t.firstRunVisible()) === false, '已关过的引导卡不会反复弹');
      // 复位：引导卡写下的 md_firstRun 与刚建的空白户型一起清掉，不影响后面的流程
      await t.freshState();
    },
    // 本流程自己已经 freshState() 复位过了，驱动层不用再刷新一次（一次真实刷新 ≈ 十几秒）
    noReload: true,
  },

  {
    name: 'from-scratch',
    title: '彻底的从零开始：空白户型 → 画一圈墙（含窗与门洞）→ 放门 → 放洁具 → 放家具 → 3D → 真实刷新后还在',
    run: async (t) => {
      /* 这条流程断的是产品承诺本身：一个没有图纸、也没有内置户型的人，从一张空白画布开始，
         在界面里把房子画出来、装上门 / 窗 / 洁具 / 家具，在 3D 里看见它，刷新后它还在。
         以前每条流程都跑在内置户型上（打开就有一整套房 + 门 + 洁具），所以这条路径
         从来没有被真实输入测过。坐标全部从空白画布派生 ⇒ plan-independent。 */
      await t.step('新建空白户型（工具 ⌄ → 新建空白户型）');
      await ensureProTools(t);
      await t.click('#btnPlanNew');
      await t.waitFor(`PLAN_ID!==BUILTIN_PLAN_ID`, 8000, '切到空白户型');
      const z0 = await t.eval(
        `({id:PLAN_ID, walls:DOC.walls.length, win:DOC.windows.length, doors:DOC.doors.length,` +
          `fx:DOC.fixtures.length, items:state.items.length})`
      );
      t.assert(
        'zero-blank-start',
        z0.walls === 0 && z0.win === 0 && z0.doors === 0 && z0.fx === 0 && z0.items === 0,
        `墙${z0.walls} 窗${z0.win} 门${z0.doors} 洁具${z0.fx} 家具${z0.items}（真空起点）`
      );
      const cv = await t.eval(
        `(()=>{const P=floorPts();let x1=1e9,y1=1e9,x2=-1e9,y2=-1e9;` +
          `for(const q of P){x1=Math.min(x1,q[0]);y1=Math.min(y1,q[1]);x2=Math.max(x2,q[0]);y2=Math.max(y2,q[1]);}` +
          `return {x1,y1,x2,y2};})()`
      );
      const W = cv.x2 - cv.x1,
        H = cv.y2 - cv.y1;
      const A = [cv.x1 + W * 0.2, cv.y1 + H * 0.2],
        B = [cv.x2 - W * 0.2, cv.y1 + H * 0.2],
        C = [cv.x2 - W * 0.2, cv.y2 - H * 0.2],
        D = [cv.x1 + W * 0.2, cv.y2 - H * 0.2];
      const RW = B[0] - A[0],
        RH = C[1] - A[1];

      await t.step('画一圈外墙：底边中间一段是窗，顶边中间一段是门洞');
      await t.click('#btnWallEdit');
      await t.waitFor(`wallEdit.on`, 5000, '进入编辑');
      await t.click('#wtoolSeg button[data-t="wall"]');
      await t.waitFor(`wallEdit.tool==='wall'`, 5000, 'tool=wall');
      const piece = async (type, p, q) => {
        await t.eval(`document.querySelector('#wType').value=${JSON.stringify(type)}`);
        await t.click(await t.planPoint(p[0], p[1]));
        await t.click(await t.planPoint(q[0], q[1]));
        await t.key('Enter', 'Enter', 13);
        await t.waitFor(`wallEdit.drawPts.length===0`, 6000, '这段墙提交');
      };
      await piece('w', A, [A[0] + RW * 0.25, A[1]]);
      await piece('g', [A[0] + RW * 0.25, A[1]], [B[0] - RW * 0.25, A[1]]);
      await piece('w', [B[0] - RW * 0.25, A[1]], B);
      await piece('w', B, C);
      const O1 = [A[0] + RW * 0.625, C[1]],
        O2 = [A[0] + RW * 0.375, D[1]]; // 门洞占顶边 25% ⇒ 约 90cm 开口
      await piece('w', C, O1);
      await piece('d', O1, O2);
      await piece('w', O2, D);
      await piece('w', D, A);
      const room = await t.eval(
        `(()=>{const w=DOC.walls.filter(e=>e.src==='user');` +
          `return {n:w.length, opening:w.filter(e=>e.kind==='opening').length,` +
          `win:DOC.windows.filter(e=>e.src==='user').length, fp:floorPts().length};})()`
      );
      t.assert(
        'zero-room-drawn',
        room.n === 7 && room.opening === 1 && room.win === 1,
        `墙 ${room.n} 段（含 ${room.opening} 段门洞）· 窗 ${room.win} 段`
      );
      t.assert('zero-floor-follows-drawing', room.fp >= 4, `地板轮廓 ${room.fp} 个点（跟着画的墙走）`);
      await t.shot('zero-room');

      await t.step('放门：门工具点门洞');
      await t.click('#wtoolSeg button[data-t="door"]');
      await t.waitFor(`wallEdit.tool==='door'`, 5000, 'tool=door');
      const mid = await t.eval(
        `(()=>{const o=DOC.walls.filter(e=>e.src==='user'&&e.kind==='opening')[0];` +
          `return o?[(o.geom.x1+o.geom.x2)/2,(o.geom.y1+o.geom.y2)/2]:null;})()`
      );
      if (mid) await t.click(await t.planPoint(mid[0], mid[1]));
      await t.waitFor(`DOC.doors.length===1`, 8000, '门放上');
      const door = await t.eval(`(()=>{const d=DOC.doors[0];return d?{w:d.width,kind:d.kind}:null;})()`);
      t.assert(
        'zero-door-on-opening',
        !!door && door.kind === 'swing' && door.w > 1,
        door ? `门宽 ${door.w.toFixed(2)}ft · kind=${door.kind}` : '门没放上'
      );
      await t.shot('zero-door');

      await t.step('放洁具：马桶 + 洗手盆 + 镜子（镜子自动贴墙）');
      await t.click('#wtoolSeg button[data-t="fx"]');
      await t.waitFor(`wallEdit.tool==='fx'`, 5000, 'tool=fx');
      const fxAt = async (type, fx, fy) => {
        await t.eval(`document.querySelector('#fxType').value=${JSON.stringify(type)}`);
        await t.click(await t.planPoint(fx, fy));
        await t.waitFor(`DOC.fixtures.length>=${fxAt.n}`, 6000, '洁具放上');
      };
      fxAt.n = 1;
      await fxAt('toilet', A[0] + RW * 0.12, A[1] + RH * 0.18);
      fxAt.n = 2;
      await fxAt('basin', A[0] + RW * 0.4, A[1] + RH * 0.1);
      fxAt.n = 3;
      // 贴墙吸附半径 = min(1.0, 20/屏幕每英尺像素)：视野大 → 半径小，点击必须落在半径内
      const snapIn = await t.eval(`Math.min(0.35, 10/(document.querySelector('#svg2d').getScreenCTM().a*S))`);
      await fxAt('mirror', A[0] + snapIn, (A[1] + D[1]) / 2);
      const fx = await t.eval(
        `(()=>{const u=DOC.fixtures.filter(f=>f.src==='user');` +
          `return {n:u.length, types:u.map(f=>f.t).join(','), mirRot:(u.find(f=>f.t==='mirror')||{}).rot};})()`
      );
      t.assert('zero-fixtures-placed', fx.n === 3 && fx.types === 'toilet,basin,mirror', fx.types);
      t.assert('zero-mirror-snapped', fx.mirRot != null, '镜子 rot=' + fx.mirRot + '（贴到画的墙上）');
      await t.shot('zero-fixtures');

      await t.step('放家具：真实点目录卡片，再拖进房间');
      await t.click('#wDone');
      await t.waitFor(`!wallEdit.on`, 5000, '退出编辑');
      const n0 = await t.eval(`state.items.length`);
      await t.click('.catCard');
      await t.waitFor(`state.items.length===${n0 + 1}`, 6000, '家具数 +1');
      const it = await t.eval(
        `(()=>{const i=state.items[state.items.length-1];return {uid:i.uid,ref:i.ref,x:i.x,y:i.y};})()`
      );
      await t.drag(await t.planPoint(it.x, it.y), await t.planPoint(A[0] + RW * 0.45, A[1] + RH * 0.55), { steps: 14 });
      const at = await t.eval(`(()=>{const i=state.items.find(x=>x.uid===${it.uid});return [i.x,i.y];})()`);
      t.assert(
        'zero-furniture-inside-room',
        at[0] > A[0] && at[0] < B[0] && at[1] > A[1] && at[1] < D[1],
        `${it.ref} 落在 (${at[0].toFixed(1)}, ${at[1].toFixed(1)})，房间 x[${A[0].toFixed(1)}…${B[0].toFixed(1)}] y[${A[1].toFixed(1)}…${D[1].toFixed(1)}]`
      );
      await t.shot('zero-furniture');

      await t.step('进 3D：画的墙立到顶，家具在场景里');
      await t.click('#btnDoll');
      await t.waitFor(`three && three.staticGroup && !geoDirty3D`, 25000, '3D 场景就绪');
      const stand = await t.eval(
        `(()=>{const x=${A[0]},y=${(A[1] + D[1]) / 2};` +
          `three.staticGroup.updateMatrixWorld(true);` +
          `const rc=new THREE.Raycaster();rc.set(new THREE.Vector3(x,CEIL_H+1.5,y),new THREE.Vector3(0,-1,0));` +
          `const h=rc.intersectObjects(three.staticGroup.children,true);` +
          `return h.length?{y:h[0].point.y,dx:Math.abs(h[0].point.x-x),dz:Math.abs(h[0].point.z-y)}:null;})()`
      );
      t.assert(
        'zero-3d-wall-stands',
        !!stand && stand.y > 1.0 && stand.dx < 1.2 && stand.dz < 1.2,
        stand ? `左墙命中于 y=${stand.y.toFixed(2)}ft` : '3D 里没有这段墙'
      );
      const fmap = await t.eval(`three.furnMap ? three.furnMap.size : -1`);
      t.assert('zero-3d-furniture', fmap === 1, 'furnMap=' + fmap);
      await t.shot('zero-3d');
      await t.click('#btn2d');
      await t.waitFor(`state.view==='2d'`, 8000, '回到 2D');

      await t.step('真实刷新：从零建的那份还在，而且仍是当前户型');
      await t.reload();
      await t.waitForReady();
      const after = await t.eval(
        `({id:PLAN_ID, walls:DOC.walls.filter(e=>e.src==='user').length, doors:DOC.doors.length,` +
          `fx:DOC.fixtures.filter(f=>f.src==='user').length, items:state.items.length,` +
          `plans:PLAN_REG.plans.length, active:PLAN_REG.active})`
      );
      t.assert(
        'zero-survives-real-reload',
        after.walls === 7 && after.doors === 1 && after.fx === 3 && after.items === 1 && after.id === z0.id,
        `刷新后 墙${after.walls} 门${after.doors} 洁具${after.fx} 家具${after.items} · 当前户型=${after.id === z0.id ? '还是这份' : '被换了'}`
      );
      t.assert(
        'zero-registry-remembers',
        after.plans >= 2 && after.active === z0.id,
        '注册表 ' + after.plans + ' 份 · active 正确'
      );
      await t.shot('zero-after-reload');

      await t.step('切回内置户型：它没被这份房子碰到');
      const builtinId = await t.eval(`BUILTIN_PLAN_ID`);
      await pickPlan(t, builtinId);
      await t.waitFor(`PLAN_ID===BUILTIN_PLAN_ID`, 8000, '切回内置');
      const bi = await t.eval(
        `({walls:effWalls().length, doors:effDoors().length, user:DOC.walls.filter(e=>e.src==='user').length, items:state.items.length})`
      );
      t.assert(
        'zero-builtin-untouched',
        bi.walls > 10 && bi.doors > 0 && bi.user === 0 && bi.items > 0,
        `内置 墙${bi.walls} 门${bi.doors} 家具${bi.items} · 用户改动 ${bi.user} 处`
      );

      await t.step('清场：删掉这份从零建的户型（两步确认）');
      await ensureProTools(t);
      await pickPlan(t, z0.id);
      await t.waitFor(`PLAN_ID===${JSON.stringify(z0.id)}`, 8000, '切回那份房子');
      await t.click('#btnPlanDel');
      await t.click('#btnPlanDel');
      await t.waitFor(`!PLANS.hasPlan(PLAN_REG, ${JSON.stringify(z0.id)})`, 8000, '那份房子被删掉');
      t.assert(
        'zero-cleanup',
        (await t.eval(`PLAN_ID`)) === builtinId && (await t.eval(`PLAN_REG.plans.length`)) === after.plans - 1,
        '删完回到内置 · 注册表 ' + ((await t.eval(`PLAN_REG.plans.length`)) || '?') + ' 份'
      );
    },
  },

  {
    name: 'wall-edit',
    title: '编辑墙体：画一段墙 → 拖端点 → 删除',
    run: async (t) => {
      const before = await stateOf(t);
      const c = await planCenter(t);
      await t.step('进入「编辑墙体」');
      await t.click('#btnWallEdit');
      await t.waitFor(`wallEdit.on`, 5000, 'wallEdit.on');
      t.assert(
        'walledit-bar',
        await t.eval(`getComputedStyle(document.querySelector('#wallbar')).display!=='none'`),
        '工具条可见'
      );
      await t.click('#wtoolSeg button[data-t="wall"]');
      await t.waitFor(`wallEdit.tool==='wall'`, 5000, 'tool=wall');

      await t.step('连续两点画一段墙');
      await t.click(await t.planPoint(c.x - 3, c.y + 4));
      await t.click(await t.planPoint(c.x + 1, c.y + 4));
      await t.key('Enter', 'Enter', 13); // 双击/回车结束
      await t.waitFor(`DOC.walls.length>${before.walls}`, 8000, '墙数 +1');
      const after = await stateOf(t);
      t.assert('wall-added', after.walls === before.walls + 1, `墙段 ${before.walls} → ${after.walls}`);
      await t.shot('wall-added');

      await t.step('切回「选择/调整」再选中它');
      // 画墙工具还开着时，点画布 = 继续画下一段，不是选中
      await t.click('#wtoolSeg button[data-t="select"]');
      await t.waitFor(`wallEdit.tool==='select'`, 5000, 'tool=select');
      // 画墙带磁吸（端点/墙线吸附），落点可能不是我给的那个坐标 → 一律回读真实几何再点中点
      const nw = await t.eval(
        `(()=>{const a=DOC.walls;const s=a[a.length-1];return {id:s.id,x1:s.geom.x1,y1:s.geom.y1,x2:s.geom.x2,y2:s.geom.y2};})()`
      );
      t.info(
        'wall-snapped',
        `实际落点 (${nw.x1.toFixed(2)},${nw.y1.toFixed(2)}) → (${nw.x2.toFixed(2)},${nw.y2.toFixed(2)})`
      );
      const mid = await t.planPoint((nw.x1 + nw.x2) / 2, (nw.y1 + nw.y2) / 2);
      await t.click({ x: mid.x, y: mid.y });
      await t.waitFor(`wallEdit.sel && wallEdit.sel.kind==='w'`, 6000, '选中墙段');
      const ends = await t.eval(
        `(()=>{const s=effWalls().find(w=>w._id===wallEdit.sel.id);return {x1:s.x1,y1:s.y1,x2:s.x2,y2:s.y2};})()`
      );
      const h = await t.rectOf('.wEnd[data-end="1"]');
      await t.drag({ x: h.x, y: h.y }, await t.planPoint(ends.x2, ends.y2 + 2), { steps: 14 });
      const ends2 = await t.eval(
        `(()=>{const s=effWalls().find(w=>w._id===wallEdit.sel.id);return {x1:s.x1,y1:s.y1,x2:s.x2,y2:s.y2};})()`
      );
      const dd = Math.hypot(ends2.x2 - ends.x2, ends2.y2 - ends.y2);
      t.assert('wall-endpoint-drag', dd > 0.5, `端点移动 ${dd.toFixed(2)}ft`);

      await t.step('删除这段墙');
      await t.click('#wDelete');
      await t.waitFor(`DOC.walls.length===${before.walls}`, 8000, '墙数复位');
      t.assert('wall-deleted', (await stateOf(t)).walls === before.walls, `回到 ${before.walls} 段`);
      await t.click('#wDone');
      await t.waitFor(`!wallEdit.on`, 5000, '退出编辑');
    },
  },

  {
    name: 'fixture-tool',
    title: '洁具工具：放置 → 选中 → 方向键 1cm → 删除',
    run: async (t) => {
      const before = await stateOf(t);
      const c = await planCenter(t);
      await t.step('进入编辑墙体 → 洁具');
      await t.click('#btnWallEdit');
      await t.waitFor(`wallEdit.on`, 5000, 'wallEdit.on');
      await t.click('#wtoolSeg button[data-t="fx"]');
      await t.waitFor(`wallEdit.tool==='fx'`, 5000, 'tool=fx');
      await t.eval(`document.querySelector('#fxType').value='toilet'`);
      await t.step('点击空地放一个马桶');
      await t.click(await t.planPoint(c.x, c.y - 3));
      await t.waitFor(`DOC.fixtures.length>${before.fixtures}`, 8000, '洁具数 +1');
      const fx = await t.eval(
        `(()=>{const f=DOC.fixtures[DOC.fixtures.length-1];return {id:f.id,t:f.t,x1:f.x1,y1:f.y1};})()`
      );
      t.assert('fixture-placed', fx.t === 'toilet', `放了 ${fx.t}（id=${fx.id}）`);
      await t.shot('fixture');

      await t.step('方向键微调 1cm');
      const hit = await t.rectOf(`.fxHit[data-fx="${fx.id}"]`);
      await t.click({ x: hit.x, y: hit.y });
      await t.waitFor(`wallEdit.sel && wallEdit.sel.kind==='fx'`, 6000, '选中洁具');
      await t.key('ArrowLeft', 'ArrowLeft', 37);
      const fx2 = await t.eval(`(()=>{const f=DOC.fixtures.find(x=>x.id===${JSON.stringify(fx.id)});return f.x1;})()`);
      const delta = Math.abs(fx2 - fx.x1);
      t.assert('fixture-nudge', delta > 0.02 && delta < 0.06, `左移 ${(delta * 30.48).toFixed(2)}cm`);

      await t.step('删除');
      await t.key('Delete', 'Delete', 46);
      await t.waitFor(`DOC.fixtures.length===${before.fixtures}`, 8000, '洁具数复位');
      t.assert('fixture-deleted', (await stateOf(t)).fixtures === before.fixtures, `回到 ${before.fixtures} 件`);
      await t.click('#wDone');
    },
  },

  {
    name: 'place-drag-rotate-delete',
    title: '点卡片放家具 → 拖动 → 旋转 → 删除（真实鼠标）',
    run: async (t) => {
      const before = await stateOf(t);
      await t.step('点目录第一张卡片', '放一件家具');
      await t.click('.catCard');
      await t.waitFor('state.items.length>' + before.items, 6000, '家具数 +1');
      const it = await t.eval(`(()=>{const i=state.items[state.items.length-1];
        const s=itemSpec(i);return {uid:i.uid,ref:i.ref,x:i.x,y:i.y,rot:i.rot,name:s?s.name:'?'};})()`);
      t.assert('place-added', (await t.eval('state.items.length')) === before.items + 1, `新增 ${it.ref} ${it.name}`);
      const title = await t.eval(`document.querySelector('#pTitle').textContent`);
      t.assert('place-props-title', title.includes(it.name.slice(0, 8)), `检视面板：${title}`);
      await t.shot('placed');

      await t.step('拖动它', '按住家具拖到别处');
      const from = await t.planPoint(it.x, it.y);
      const to = await t.planPoint(it.x + 3, it.y + 2);
      await t.drag(from, to, { steps: 16 });
      const moved = await t.eval(`(()=>{const i=state.items.find(x=>x.uid===${it.uid});return [i.x,i.y];})()`);
      const d = Math.hypot(moved[0] - it.x, moved[1] - it.y);
      t.assert('drag-moved', d > 1.5, `位移 ${d.toFixed(2)}ft（目标 ≈3.6ft）`);

      await t.step('旋转 90°', '点「旋转 90°」按钮');
      await t.click('#pRot90');
      const rot = await t.eval(`state.items.find(x=>x.uid===${it.uid}).rot`);
      t.assert('rotate-90', Math.abs(rot - 90) < 0.2, `rot=${rot}`);

      await t.step('删除', '按 Delete 键');
      await t.key('Delete', 'Delete', 46);
      await t.waitFor(`state.items.length===${before.items}`, 6000, '家具数复位');
      t.assert('delete-works', (await stateOf(t)).items === before.items, `回到 ${before.items} 件`);
    },
  },

  {
    name: 'overlap-feedback',
    title: '两件重叠 → 红描边；移开 → 消失',
    run: async (t) => {
      const before = await stateOf(t);
      await t.step('放两件在同一处', '连点同一张卡片两次');
      await t.click('.catCard');
      const p1 = await t.eval(`(()=>{const i=state.items[state.items.length-1];return [i.x,i.y];})()`);
      await t.click('.catCard');
      await t.eval(`(()=>{const i=state.items[state.items.length-1];i.x=${p1[0]};i.y=${p1[1]};drawFurniture();})()`);
      await t.waitFor(`document.querySelectorAll('#furn [stroke="#e05656"]').length>=2`, 6000, '红描边出现');
      const red = await t.eval(`document.querySelectorAll('#furn [stroke="#e05656"]').length`);
      t.assert('overlap-red-shown', red >= 2, `红描边 ${red} 个`);
      await t.shot('overlap');

      await t.step('把上面那件移开', '拖 8ft');
      const uid = await t.eval(`state.items[state.items.length-1].uid`);
      await t.drag(await t.planPoint(p1[0], p1[1]), await t.planPoint(p1[0] + 8, p1[1] + 6), { steps: 18 });
      const red2 = await t.eval(`document.querySelectorAll('#furn [stroke="#e05656"]').length`);
      t.assert('overlap-red-cleared', red2 === 0, `移开后红描边 ${red2} 个`);

      await t.eval(`state.items=state.items.filter(i=>i.uid!==${uid}&&i.uid!==${uid - 1});drawFurniture();save();`);
      await t.waitFor(`state.items.length===${before.items}`, 6000, '复位');
      t.assert('overlap-cleanup', (await stateOf(t)).items === before.items, `复位到 ${before.items} 件`);
    },
  },

  {
    name: 'units',
    title: 'cm ↔ 英尺：房间标注与家具尺寸文字跟着变',
    run: async (t) => {
      await t.step('切到英尺');
      const cmText = await t.eval(
        `(()=>{const l=[...document.querySelectorAll('.roomlabel')].map(x=>x.textContent).join(' | ');
          const c=[...document.querySelectorAll('.catCard .sub')].slice(0,3).map(x=>x.textContent).join(' | ');
          return {labels:l.slice(0,120), cards:c};})()`
      );
      t.assert('units-cm-mentions-cm', /cm/.test(cmText.cards), `cm 态卡片文字：${cmText.cards}`);
      await t.click('#unitSeg button[data-u="ft"]');
      await t.waitFor(`state.unit==='ft'`, 5000, 'state.unit=ft');
      const ftText = await t.eval(
        `(()=>{const l=[...document.querySelectorAll('.roomlabel')].map(x=>x.textContent).join(' | ');
          const c=[...document.querySelectorAll('.catCard .sub')].slice(0,3).map(x=>x.textContent).join(' | ');
          return {labels:l.slice(0,120), cards:c};})()`
      );
      t.assert('units-ft-notation', /'/.test(ftText.cards) && !/cm/.test(ftText.cards), `英尺态卡片：${ftText.cards}`);
      t.assert('units-labels-change', ftText.labels !== cmText.labels, `标注变了：${ftText.labels}`);
      await t.shot('units-ft');
      await t.step('切回 cm');
      await t.click('#unitSeg button[data-u="cm"]');
      await t.waitFor(`state.unit==='cm'`, 5000, 'state.unit=cm');
      const back = await t.eval(
        `[...document.querySelectorAll('.catCard .sub')].slice(0,3).map(x=>x.textContent).join(' | ')`
      );
      t.assert('units-back', /cm/.test(back), `回到 cm：${back}`);
    },
  },

  {
    name: 'currency',
    title: 'US$ ↔ CA$：价格、无售、另一配置标记、合计',
    run: async (t) => {
      await t.step('切到加元');
      await t.click('#curCAD');
      await t.waitFor(`curNow()==='cad'`, 5000, 'curNow=cad');
      const tot = await t.eval(`document.querySelector('#totals').textContent`);
      t.assert('currency-totals-cad', /CA\$/.test(tot), `合计：${tot.slice(0, 90)}`);
      const na = await t.eval(`CATALOG.filter(c=>c.caNA).map(c=>c.name.split(' · ')[0])[0] || ''`);
      if (na) {
        await t.step('搜一个「加拿大不售」的条目', na);
        await t.type('#catSearch', na);
        await t.waitFor(`document.querySelectorAll('.catCard').length>0`, 5000, '搜到卡片');
        const txt = await t.eval(`[...document.querySelectorAll('.catCard')].map(c=>c.textContent).join(' ')`);
        t.assert('currency-na-label', /加拿大无售/.test(txt), `卡片文案：${txt.slice(0, 120)}`);
        await t.shot('currency-na');
      }
      await t.step('搜一个 caVar 条目（另一配置）', 'KIVIK');
      await t.type('#catSearch', 'kivik');
      await t.waitFor(`document.querySelectorAll('.catCard').length>0`, 5000, '搜到卡片');
      const cv = await t.eval(`[...document.querySelectorAll('.catCard .sub b')].map(b=>b.textContent).join(' | ')`);
      t.assert('currency-variant-star', /\*/.test(cv), `价格标记：${cv}`);
      const tip = await t.eval(
        `[...document.querySelectorAll('.catCard .sub b')].map(b=>b.title).filter(Boolean)[0] || ''`
      );
      t.assert('currency-variant-tooltip', tip.length > 4, `悬停说明：${tip.slice(0, 80)}`);
      await t.shot('currency-variant');
      await t.eval(
        `document.querySelector('#catSearch').value='';document.querySelector('#catSearch').dispatchEvent(new Event('input',{bubbles:true}))`
      );
      await t.step('切回美元');
      await t.click('#curUSD');
      await t.waitFor(`curNow()==='usd'`, 5000, 'curNow=usd');
      t.assert(
        'currency-totals-usd',
        /US\$/.test(await t.eval(`document.querySelector('#totals').textContent`)),
        '合计回到 US$'
      );
    },
  },

  {
    name: 'search-fold',
    title: '搜索把查询词和商品名都折成 ASCII（poang → POÄNG）',
    run: async (t) => {
      const all = await t.eval(`document.querySelectorAll('.catCard').length`);
      await t.step('输入 poang（不带变音符号）');
      await t.type('#catSearch', 'poang');
      await t.waitFor(`document.querySelectorAll('.catCard').length>0`, 5000, '有结果');
      const hit = await t.eval(`[...document.querySelectorAll('.catCard .nm2')].map(x=>x.textContent).join(' | ')`);
      t.assert('search-fold-poang', /POÄNG/.test(hit), `结果：${hit.slice(0, 120)}`);
      await t.step('输入 poäng（带变音符号）');
      await t.type('#catSearch', 'poäng');
      await t.waitFor(
        `[...document.querySelectorAll('.catCard .nm2')].some(x=>/POÄNG/.test(x.textContent))`,
        5000,
        '仍命中 POÄNG'
      );
      t.assert('search-fold-poang-diacritic', true, '带 ¨ 也命中');
      await t.step('输入中文「沙发」');
      await t.type('#catSearch', '沙发');
      await t.waitFor(`document.querySelectorAll('.catCard').length>0`, 5000, '有结果');
      const cn = await t.eval(
        `[...document.querySelectorAll('.catCard .nm2')].slice(0,3).map(x=>x.textContent).join(' | ')`
      );
      t.assert('search-cn', cn.length > 0, `结果：${cn}`);
      await t.step('清空搜索');
      await t.eval(
        `(()=>{const s=document.querySelector('#catSearch');s.value='';s.dispatchEvent(new Event('input',{bubbles:true}));})()`
      );
      await t.waitFor(`document.querySelectorAll('.catCard').length===${all}`, 5000, '目录恢复全量');
      t.assert(
        'search-clear',
        (await t.eval(`document.querySelectorAll('.catCard').length`)) === all,
        `恢复 ${all} 张卡片`
      );
    },
  },

  {
    name: 'measure',
    title: '量尺寸：点起点 → 预览 → 落定 → 清除',
    run: async (t) => {
      const c = await planCenter(t);
      await t.step('点「量尺寸」');
      await t.click('#btnMeas');
      await t.waitFor(`meas && meas.on`, 5000, 'meas.on');
      await t.step('定起点');
      await t.click(await t.planPoint(c.x - 2, c.y));
      await t.step('移动并落定终点');
      await t.click(await t.planPoint(c.x + 2, c.y));
      await t.waitFor(`document.querySelectorAll('#meas text').length>=1`, 6000, '出现标注文字');
      const m = await t.eval(
        `({lines: document.querySelectorAll('#meas line').length, texts: [...document.querySelectorAll('#meas text')].map(x=>x.textContent).join(' | ')})`
      );
      t.assert('measure-shown', m.lines >= 1 && /cm/.test(m.texts), `线 ${m.lines} · 文字 ${m.texts}`);
      await t.shot('measure');
      await t.step('Shift 锁水平');
      await t.click(await t.planPoint(c.x - 2, c.y + 3));
      await t.mouse('mouseMoved', 0, 0); // 复位光标，避免预览线干扰截图
      const p = await t.planPoint(c.x + 3, c.y + 3.7);
      await t.click({ x: p.x, y: p.y });
      const m2 = await t.eval(`[...document.querySelectorAll('#meas text')].map(x=>x.textContent).join(' | ')`);
      t.assert('measure-second-kept', m2.split('|').length >= 2, `两条标注：${m2}`);
      await t.step('点「清除」');
      await t.click('#btnMeasClr');
      await t.waitFor(`document.querySelectorAll('#meas *').length===0`, 6000, '标注清空');
      t.assert('measure-cleared', (await t.eval(`document.querySelectorAll('#meas *').length`)) === 0, '已清空');
      await t.key('Escape', 'Escape', 27);
    },
  },

  {
    name: 'view-3d-fp',
    title: '2D → 娃娃屋 → 室内漫游 → 开关灯 → 日夜',
    run: async (t) => {
      // 房间里没有灯具时「关灯/开灯」没有对象：先放一盏落地灯（目录是 app 数据，两个入口一致）
      await t.step('放一盏落地灯');
      const lamp = await t.eval(
        `(()=>{const sp=CATALOG.find(s=>s.kind==='lamp');return sp?{ref:sp.id,name:sp.name}:null})()`
      );
      if (lamp) {
        await t.type('#catSearch', lamp.name.split(' ')[0]);
        await t.waitFor(`document.querySelectorAll('.catCard').length>=1`, 8000, '搜到落地灯卡片');
        await t.click('.catCard');
        await t.waitFor(`state.items.length>=1`, 8000, '落地灯已放置');
        await t.eval(
          `(()=>{const s=document.querySelector('#catSearch');s.value='';s.dispatchEvent(new Event('input',{bubbles:true}));})()`
        );
        t.assert('lamp-placed', (await t.eval(`state.items.length`)) >= 1, `放了 ${lamp.ref}（${lamp.name}）`);
      }
      await t.step('切到 3D 俯瞰');
      await t.click('#btnDoll');
      await t.waitFor(
        `three && three.scene && (()=>{let n=0;three.scene.traverse(o=>{if(o.isMesh)n++;});return n>20;})()`,
        30000,
        '3D 场景就绪（mesh>20）'
      );
      const s3 = await t.evalRetry(
        `({meshes:(()=>{let n=0;three.scene.traverse(o=>{if(o.isMesh)n++;});return n;})(),
          furn:(()=>{let n=0;three.scene.traverse(o=>{if(o.isGroup&&o.userData&&o.userData.uid!==undefined)n++;});return n;})(),
          canvas: !!document.querySelector('#c3d') && getComputedStyle(document.querySelector('#c3d')).display!=='none'})`
      );
      t.assert('view-doll-scene', s3.meshes > 20 && s3.canvas, `mesh ${s3.meshes} · 画布可见`);
      await t.shot('doll');

      await t.step('切到室内漫游');
      await t.click('#btnFP');
      // setView 把 3D 工作放在 setTimeout(40) 里派发：state.view 立刻变，相机档位要等场景更新跑完
      await t.waitFor(`state.view==='fp' && three && three.camMode==='fp'`, 20000, '相机进入第一人称');
      const cam = await t.evalRetry(
        `({y: three.cam.position.y, eye: EYE_H, mode: three.camMode, fpPos: three.fpPos?[three.fpPos.x,three.fpPos.y,three.fpPos.z]:null})`,
        20000,
        '读相机'
      );
      t.info('fp-cam', JSON.stringify(cam));
      t.assert(
        'view-fp-eye-height',
        Math.abs(cam.y - cam.eye) < 0.25,
        `相机 y=${cam.y.toFixed(3)}ft（眼高 ${cam.eye}）`
      );
      await t.shot('fp');

      // 灯具 = 家具组里带 userData.baseI 的光源；sun/amb/hemi 是环境光，关灯不该动它们
      const lampCount = `(()=>{let n=0;three.furnGroup.traverse(o=>{if(o.isLight&&o.userData&&o.userData.baseI!=null&&o.intensity>0.001)n++;});return n;})()`;
      const envCount = `(()=>{let n=0;three.scene.traverse(o=>{if(o.isLight&&o.userData&&o.userData.baseI==null&&o.intensity>0.001)n++;});return n;})()`;
      const lit0 = await t.evalRetry(lampCount, 15000, '灯具数');
      t.assert('fp-lamps-lit', lit0 > 0, `室内视角亮着的灯具光源 ${lit0} 个`);
      await t.step('关灯');
      await t.click('#lampOff');
      await t.waitFor(`${lampCount}===0`, 10000, '灯具光源全部熄灭');
      const env1 = await t.evalRetry(envCount, 15000, '环境光数');
      t.assert('lamps-off-only-lamps', env1 > 0, `环境光仍在（${env1} 个）→ 关的是灯，不是把房间弄黑`);
      await t.shot('lamps-off');
      await t.step('开灯');
      await t.click('#lampOn');
      await t.waitFor(`${lampCount}>0`, 10000, '灯具重新点亮');
      t.assert('lamps-on', (await t.evalRetry(lampCount, 15000, '灯具数')) > 0, '灯已亮');

      await t.step('切到夜晚');
      await t.click('#dnNight');
      await t.waitFor(`three && three.night===true`, 12000, 'three.night=true');
      t.assert('night-mode', (await t.eval(`three.night`)) === true, '夜晚态（环境色/曝光跟着变）');
      await t.shot('night-3d');
      await t.click('#dnDay');
      await t.step('回到 2D');
      await t.click('#btn2d');
      await t.waitFor(`state.view==='2d'`, 12000, 'view=2d');
      t.assert('view-back-2d', (await stateOf(t)).view === '2d', '回到平面');
    },
  },

  {
    name: 'persistence-reload',
    title: '真实刷新后家具还在（bench 做不到这一段）',
    run: async (t) => {
      const before = await stateOf(t);
      await t.step('放一件家具并记下位置');
      await t.click('.catCard');
      await t.waitFor(`state.items.length>${before.items}`, 6000, '家具 +1');
      const it = await t.eval(
        `(()=>{const i=state.items[state.items.length-1];return {ref:i.ref,x:i.x,y:i.y,rot:i.rot};})()`
      );
      await t.eval('save()');
      await t.shot('before-reload');
      await t.step('真实刷新页面');
      await t.reload();
      const after = await t.eval(
        `(()=>{const i=state.items.find(x=>Math.abs(x.x-${it.x})<0.01&&Math.abs(x.y-${it.y})<0.01&&x.ref===${JSON.stringify(it.ref)});
          return i?{ref:i.ref,x:i.x,y:i.y,rot:i.rot}:null;})()`
      );
      t.assert(
        'persist-after-reload',
        after && after.rot === it.rot,
        after ? `${after.ref} @ (${after.x}, ${after.y}) rot=${after.rot}` : '刷新后找不到那件家具'
      );
      t.assert('persist-count', (await stateOf(t)).items === before.items + 1, `家具数 ${before.items + 1}`);
      await t.eval(
        `(()=>{state.items=state.items.filter(i=>i.ref!==${JSON.stringify(it.ref)}||i.x!==${it.x});drawFurniture();save();})()`
      );
    },
  },

  {
    name: 'panels',
    title: '面板收起 → 竖 tab 点回来 → 刷新后状态保持',
    run: async (t) => {
      await t.step('收起左面板');
      await t.click('#catCollapse');
      await t.waitFor(`document.querySelector('#catalog').classList.contains('collapsed')`, 5000, 'catalog.collapsed');
      t.assert(
        'panel-collapsed',
        (await t.eval(`getComputedStyle(document.querySelector('#catalog')).display`)) === 'none',
        'display:none'
      );
      t.assert(
        'panel-tab-shown',
        await t.eval(`document.querySelector('#catTab').classList.contains('show')`),
        '竖 tab 出现'
      );
      await t.shot('panel-collapsed');
      await t.step('点竖 tab 展开');
      await t.click('#catTab');
      await t.waitFor(`!document.querySelector('#catalog').classList.contains('collapsed')`, 5000, '展开');
      t.assert('panel-expanded', true, '目录回来了');
      await t.step('再收起并刷新');
      await t.click('#catCollapse');
      await t.reload();
      t.assert(
        'panel-persist',
        await t.eval(`document.querySelector('#catalog').classList.contains('collapsed')`),
        '刷新后仍是收起态'
      );
      await t.click('#catTab');
      await t.waitFor(`!document.querySelector('#catalog').classList.contains('collapsed')`, 5000, '展开复位');
    },
  },

  {
    name: 'dxf-import',
    title: '真实文件选择 → 一次性确认（单位/范围/识别）→ 新建一份户型并切过去 → 切回内置',
    run: async (t) => {
      const before = await stateOf(t);
      await t.step('选择 DXF 文件');
      await t.setFiles('#fileDxf', t.fixtureDxf);
      await t.waitFor(`document.querySelector('#dxfModal').style.display==='flex'`, 25000, '确认弹窗出现');
      const info = await t.eval(`document.querySelector('#dxfInfo').textContent.replace(/\\s+/g,' ')`);
      t.assert('dxf-modal-info', /单位/.test(info) && /识别/.test(info), info.slice(0, 160));
      await t.shot('dxf-modal');
      await t.step('点「导入」');
      await t.click('#dxfOk');
      await t.waitFor(`docImported()===true`, 20000, 'DOC 已替换');
      const after = await stateOf(t);
      t.assert(
        'dxf-imported',
        after.imported === true,
        `imported=true · 墙 ${after.walls} 段 · 家具清空 ${after.items} 件`
      );
      await t.step('进编辑模式看导入结果');
      await t.click('#btnWallEdit');
      await t.waitFor(`wallEdit.on`, 5000, '进入编辑');
      const drawn = await t.eval(
        `({wHit: document.querySelectorAll('.wHit').length, dHit: document.querySelectorAll('.dHit').length,
           pHit: document.querySelectorAll('.pHit').length, solids: effFixed().filter(f=>f._src==='u').length,
           win: effWalls().filter(w=>w.t==='g').length})`
      );
      t.assert(
        'dxf-2d-drawn',
        drawn.wHit > 0 && drawn.dHit > 0 && drawn.pHit > 0,
        `2D 可点实体：墙 ${drawn.wHit} · 门 ${drawn.dHit} · 柱/块 ${drawn.pHit}（导入实体 ${drawn.solids}）· 窗段 ${drawn.win}`
      );
      await t.shot('dxf-applied');
      await t.step('「重置内置」回到内置户型');
      await t.dialog('accept');
      await t.click('#wRestore');
      await t.waitFor(`docImported()===false`, 15000, '回到内置户型');
      t.assert('dxf-restore', (await stateOf(t)).imported === false, '已回到内置户型');
      const back = await t.eval(
        `({eff: effWalls().length, docW: DOC.walls.length, docN: DOC.windows.length, user: effWalls().filter(w=>w._src==='u').length, imported: docImported()})`
      );
      t.info('dxf-after-restore', JSON.stringify(back));
      t.assert(
        'dxf-restore-walls',
        back.docW === before.walls && back.docN > 0 && back.user === 0 && !back.imported,
        `墙 ${back.docW}（原 ${before.walls}）· 窗 ${back.docN} · 用户墙 ${back.user} · 投影合计 ${back.eff}`
      );
      await t.click('#wDone');
      t.info('dxf-dialogs', JSON.stringify(t.dialogs.map((d) => d.type)));
    },
  },

  {
    name: 'doc-export-import',
    title: '导出户型 JSON → 再导入回来（真实下载 + 真实文件选择）',
    run: async (t) => {
      await t.step('展开「工具 ⌄」');
      // 导入/导出是渐进披露的第二层（R9 §4）：不展开就点不到
      await t.click('#btnMore');
      await t.waitFor(`proToolsOpen===true`, 5000, 'pro 工具层展开');
      await t.step('点「导出户型」');
      await t.click('#btnExportDoc');
      let downloaded = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 20000) {
        const { readdirSync, existsSync } = await import('node:fs');
        if (existsSync(t.downloads)) {
          const f = readdirSync(t.downloads).find((n) => n.endsWith('.json'));
          if (f) {
            downloaded = t.downloads + '/' + f;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      t.assert('doc-download', !!downloaded, downloaded || '20s 内没有 .json 下载文件');
      if (!downloaded) return;
      const { readFileSync } = await import('node:fs');
      const doc = JSON.parse(readFileSync(downloaded, 'utf8'));
      t.assert(
        'doc-json-shape',
        !!doc.name && Array.isArray(doc.walls) && doc.walls.length > 0,
        `name=${doc.name} · walls=${doc.walls.length} · doors=${(doc.doors || []).length}`
      );
      await t.shot('doc-exported');
      await t.step('把导出的 JSON 再导入');
      await t.setFiles('#fileDoc', [downloaded]);
      await t.waitFor(`document.querySelector('#docModal').style.display==='flex'`, 20000, '确认弹窗');
      const info = await t.eval(`document.querySelector('#docInfo').textContent.replace(/\\s+/g,' ').slice(0,160)`);
      t.assert('doc-modal-info', info.length > 10, info);
      await t.click('#docOk');
      await t.waitFor(`docImported()===true`, 20000, 'DOC 已替换');
      t.assert('doc-reimported', (await stateOf(t)).imported === true, '导入成功（同一份户型往返）');
      await t.shot('doc-reimported');
      await t.step('回到内置户型');
      await t.click('#btnWallEdit');
      await t.waitFor(`wallEdit.on`, 5000, '进入编辑');
      await t.dialog('accept');
      await t.click('#wRestore');
      await t.waitFor(`docImported()===false`, 15000, '复位');
      t.assert('doc-restore', (await stateOf(t)).imported === false, '已复位');
      await t.click('#wDone');
    },
  },

  {
    name: 'multi-plan',
    title: '多户型：新建空白 → 切回内置（编辑还在）→ 重命名 → 两步删除',
    run: async (t) => {
      const before = await stateOf(t);
      const c = await planCenter(t);
      await t.step('打开「工具」第二层');
      await ensureProTools(t);
      const selRect = await t.rectOf('#planSel').catch(() => null);
      t.assert(
        'plan-select-visible',
        !!selRect && selRect.w >= 80 && selRect.h >= 18,
        selRect ? Math.round(selRect.w) + '×' + Math.round(selRect.h) + 'px' : '不在视口'
      );
      const opts0 = await t.eval(`[...document.querySelectorAll('#planSel option')].map(o=>o.textContent.trim())`);
      t.assert('plan-select-listed', Array.isArray(opts0) && opts0.length >= 1, opts0.join(' / '));
      const fit = await t.eval(
        `(()=>{const p=document.querySelector('#proTools'); return {sw:p.scrollWidth, cw:p.clientWidth};})()`
      );
      t.assert('plan-row-fits', fit.sw <= fit.cw + 1, 'proTools scrollWidth=' + fit.sw + ' clientWidth=' + fit.cw);
      t.assert(
        'plan-delete-locked-on-builtin',
        await t.eval(`document.querySelector('#btnPlanDel').disabled===true`),
        '内置户型时删除按钮不可点'
      );

      await t.step('在内置户型里画一段墙（切回来必须还在）');
      await t.click('#btnWallEdit');
      await t.waitFor(`wallEdit.on`, 5000, '进入编辑');
      await t.click('#wtoolSeg button[data-t="wall"]');
      await t.waitFor(`wallEdit.tool==='wall'`, 5000, 'tool=wall');
      await t.click(await t.planPoint(c.x - 3, c.y + 5));
      await t.click(await t.planPoint(c.x + 1, c.y + 5));
      await t.key('Enter', 'Enter', 13);
      await t.waitFor(`DOC.walls.length>${before.walls}`, 8000, '墙数 +1');
      const builtinWalls = (await stateOf(t)).walls;
      t.assert('builtin-wall-added', builtinWalls === before.walls + 1, `墙段 ${before.walls} → ${builtinWalls}`);

      await t.step('新建一份空白户型');
      await ensureProTools(t);
      await t.click('#btnPlanNew');
      await t.waitFor(`PLAN_ID!==BUILTIN_PLAN_ID`, 8000, '切到空白户型');
      const blank = await t.eval(
        `({id:PLAN_ID, walls:effWalls().length, items:state.items.length, fp:floorPts().length, plans:PLAN_REG.plans.length})`
      );
      t.assert(
        'blank-plan-empty',
        blank.walls === 0 && blank.items === 0,
        `walls=${blank.walls} items=${blank.items}（内置布局/家具不能带过去）`
      );
      t.assert('blank-plan-registry', blank.plans >= 2, '注册表 ' + blank.plans + ' 份户型');
      await t.shot('blank-plan');

      await t.step('切回内置户型：刚才那段墙还在');
      const builtinId = await t.eval(`BUILTIN_PLAN_ID`); // 这是页面里的名字，Node 侧要先取回来
      await pickPlan(t, builtinId);
      await t.waitFor(`PLAN_ID===BUILTIN_PLAN_ID`, 8000, '切回内置');
      const back = await stateOf(t);
      t.assert(
        'switch-keeps-builtin-edit',
        back.walls === builtinWalls,
        `内置户型墙段 ${back.walls}（期望 ${builtinWalls}；切户型把编辑弄丢就是 E26 要修的坑）`
      );

      // 重命名 / 删除都作用于「当前户型」，所以先切回那份空白户型。
      // （在内置户型上试删除会被拒 —— 那是故意的，前面已单独断言。）
      await t.step('切回那份空白户型，重命名它');
      await pickPlan(t, blank.id);
      await t.waitFor(`PLAN_ID===${JSON.stringify(blank.id)}`, 8000, '切回空白户型');
      await ensureProTools(t);
      await t.type('#planName', '测试户型 E2E');
      await t.click('#btnPlanRename');
      const names = await t.eval(`[...document.querySelectorAll('#planSel option')].map(o=>o.textContent.trim())`);
      t.assert(
        'plan-renamed',
        names.some((n) => /测试户型 E2E/.test(n)),
        names.join(' / ')
      );
      t.assert(
        'plan-rename-does-not-touch-builtin',
        names.some((n) => /内置/.test(n) && !/测试户型 E2E/.test(n)),
        '内置那份的名字没被改'
      );

      await t.step('两步删除：第一下只确认');
      const delRect = await t.rectOf('#btnPlanDel').catch(() => null);
      t.assert(
        'plan-delete-enabled',
        !!delRect && delRect.w >= 40,
        delRect ? Math.round(delRect.w) + '×' + Math.round(delRect.h) + 'px' : '不可见'
      );
      await t.click('#btnPlanDel');
      const armed = await t.eval(
        `({arm:document.querySelector('#btnPlanDel').classList.contains('arm'), plans:PLAN_REG.plans.length, id:PLAN_ID})`
      );
      t.assert('plan-delete-armed', armed.arm === true && armed.plans >= 2, '第一下只亮确认态：plans=' + armed.plans);
      await t.shot('plan-delete-armed');
      await t.click('#btnPlanDel');
      await t.waitFor(`PLAN_ID===BUILTIN_PLAN_ID`, 8000, '删完自动切回内置');
      const gone = await t.eval(
        `({plans:PLAN_REG.plans.length, has:PLAN_REG.plans.some(p=>p.name.indexOf('测试户型 E2E')>=0)})`
      );
      t.assert('plan-deleted', gone.has === false, '注册表 ' + gone.plans + ' 份，被删的那份已不在');
      const after = await stateOf(t);
      t.assert(
        'delete-keeps-builtin-edit',
        after.walls === builtinWalls && after.imported === false,
        `删掉另一份户型不能动内置户型：walls=${after.walls} imported=${after.imported}`
      );

      await t.step('删掉内置户型里那段测试墙');
      await t.click('#wtoolSeg button[data-t="select"]');
      await t.waitFor(`wallEdit.tool==='select'`, 5000, 'tool=select');
      const last = await t.eval(
        `(()=>{const a=DOC.walls.filter(w=>w.src==='user'); if(!a.length) return null; const s=a[a.length-1];
          return {id:s.id,x:(s.geom.x1+s.geom.x2)/2,y:(s.geom.y1+s.geom.y2)/2};})()`
      );
      if (last) {
        const mid = await t.planPoint(last.x, last.y);
        await t.click({ x: mid.x, y: mid.y });
        await t.waitFor(`wallEdit.sel && wallEdit.sel.id===${JSON.stringify(last.id)}`, 6000, '选中测试墙');
        await t.click('#wDelete');
        await t.waitFor(`DOC.walls.length===${before.walls}`, 8000, '墙数复位');
        t.assert('builtin-wall-cleaned', (await stateOf(t)).walls === before.walls, `回到 ${before.walls} 段`);
      } else {
        t.assert('builtin-wall-cleaned', false, '找不到那段测试墙');
      }
      await t.click('#wDone');
      await t.waitFor(`!wallEdit.on`, 5000, '退出编辑');
    },
  },
  {
    name: 'demo-full',
    ciSkip: true,
    title:
      '完整演示：完全的零 → 画出两室一厅一卫 → 门 / 洁具 / 固定灯具 → 逐件摆家具 → 撤销 → 3D / 室内 / 光追 → 导出 → 真实刷新后还在',
    run: async (t) => {
      /* 演示流程（不是断言流程）。它不新增断言密度 —— 这条路径的每个环节已经分别被
         bench 第 13 节（174 条）和 E2E from-scratch 守着。它的价值是：整条产品路径
         一次性跑给人看，每个阶段留一张截图，并且每一步都有断言兜底（跑歪了当场红）。
         户型 = 演示用的两室一厅一卫（18×12 ft ≈ 5.5×3.7 m）：客厅 / 卧室 / 卫生间 / 门厅。
         坐标写死在流程里，但跑在自建空白户型上，与内置户型无关 ⇒ 两个入口都能跑。
         ciSkip：含真 GPU 光追一步，CI 的软件 GL 上只会拖慢，不会多抓东西。 */

      const WALLS = [
        ['w', 1, 1, 4, 1],
        ['g', 4, 1, 9, 1], // 客厅大窗带
        ['w', 9, 1, 11, 1],
        ['w', 11, 1, 15, 1],
        ['g', 15, 1, 18, 1], // 卧室窗
        ['w', 18, 1, 19, 1],
        ['w', 19, 1, 19, 5],
        ['g', 19, 5, 19, 9], // 卧室侧窗
        ['w', 19, 9, 19, 13],
        ['w', 19, 13, 10.4, 13],
        ['d', 10.4, 13, 8.0, 13], // 入户门洞 73cm
        ['w', 8.0, 13, 1, 13],
        ['w', 1, 13, 1, 1],
        ['w', 1, 9, 3.6, 9],
        ['d', 3.6, 9, 5.8, 9], // 卫生间门洞 67cm
        ['w', 5.8, 9, 8, 9],
        ['d', 8, 9, 10.4, 9], // 门厅↔客厅门洞 73cm
        ['w', 10.4, 9, 11, 9],
        ['w', 11, 1, 11, 6],
        ['d', 11, 6, 11, 8.4], // 卧室门洞 73cm
        ['w', 11, 8.4, 11, 13],
        ['w', 8, 9, 8, 13], // 卫生间 / 门厅隔墙
      ];
      const DOOR_MID = [
        [9.2, 13, '入户'],
        [4.7, 9, '卫生间'],
        [9.2, 9, '门厅↔客厅'],
        [11, 7.2, '卧室'],
      ];
      // 台柜 / 镜子点在内侧 0.35ft 处：贴墙吸附要求「点到墙心线距离 >0 且在半径内」，
      // 正点在墙心线上（d=0）反而不吸附。
      // 两者必须贴不同的墙：洁具工具「点到已有洁具 = 选中它」，
      // 同一个位置放第二件不会新增，而是把第一件选中（实测踩过）。
      const FX = [
        { type: 'counter', at: [7.0, 9.35] }, // 贴卫生间上墙（门洞右侧）
        { type: 'mirror', at: [7.65, 11.0] }, // 贴卫生间右墙（浴缸右侧的空墙）
        { type: 'toilet', at: [2.3, 9.7] },
        { type: 'tub', at: [4.5, 11.7] },
      ];
      const LIGHTS = [
        { ref: 'dl-6', kw: '筒灯', at: [3.5, 5.0] },
        { ref: 'dl-6', kw: '筒灯', at: [7.5, 5.0] },
        { ref: 'dl-6', kw: '筒灯', at: [5.5, 2.5] },
        { ref: 'dl-4', kw: '筒灯', at: [9.5, 11.5] },
        { ref: 'cl-flush-l', kw: '吸顶灯', at: [16.0, 10.8] },
        { ref: 'vanity-3', kw: '镜前灯', at: [7.0, 9.35] },
      ];
      const FURN = [
        { ref: 'morum', kw: 'morum', at: [5.5, 5.0] }, // 客厅地毯
        { ref: 'kivik3', kw: 'kivik', at: [5.0, 7.4] }, // 三人沙发
        { ref: 'listerby_ct', kw: 'listerby', at: [4.9, 4.7] }, // 茶几
        { ref: 'besta180', kw: 'besta', at: [10.3, 4.8], rot90: true }, // 电视柜（贴卧室隔墙）
        { ref: 'pinntorp', kw: 'pinntorp', at: [3.2, 2.3] }, // 餐桌
        { ref: 'vihals-chair-0', kw: 'vihals', at: [2.0, 2.3] },
        { ref: 'vihals-chair-1', kw: 'vihals', at: [4.4, 2.3] },
        { ref: 'malm_q', kw: 'malm', at: [16.0, 5.0] }, // 床
        { ref: 'nordli_ns', kw: 'nordli', at: [12.3, 2.2] }, // 床头柜
        { ref: 'hauga6', kw: 'hauga', at: [16.0, 12.2] }, // 六屉柜
        { ref: 'micke', kw: 'micke', at: [12.2, 9.8], rot90: true }, // 书桌
        { ref: 'markus', kw: 'markus', at: [14.3, 9.8] }, // 办公椅
        { ref: 'stall', kw: 'stall', at: [8.28, 11.4], rot90: true }, // 鞋柜（门厅）
        { ref: 'raskog-3', kw: 'raskog', at: [10.4, 10.0] }, // 手推车
      ];
      const ROOMS = [
        ['客厅', 1, 1, 11, 9],
        ['卧室', 11, 1, 19, 13],
        ['卫生间', 1, 9, 8, 13],
        ['门厅', 8, 9, 11, 13],
      ];
      const cardOf = (ref) => `.catCard:has(.ph[data-thumb="${ref}"])`;
      const counts = () =>
        t.eval(
          `({walls:DOC.walls.filter(e=>e.src==='user').length, win:DOC.windows.filter(e=>e.src==='user').length,` +
            `doors:DOC.doors.filter(e=>e.src==='user').length, fx:DOC.fixtures.filter(e=>e.src==='user').length,` +
            `items:state.items.length})`
        );
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

      /* ===== ① 完全的零：什么都没存过，界面里也什么都没有 ===== */
      await t.step('完全的零：清存档 + 刷新 → 首次引导卡 → 点「新建空白户型」');
      t.keepFirstRun = true;
      await t.freshState();
      t.assert('demo-zero-card', await t.firstRunVisible(), '干净 profile 首次打开出现引导卡');
      await t.shot('zero-card');
      const rows = await t.eval(
        `(()=>[...document.querySelectorAll('#firstRun .frRow')].map(p=>p.querySelector('b').textContent.trim()))()`
      );
      t.assert(
        'demo-zero-paths',
        Array.isArray(rows) && rows.length >= 3,
        `引导卡给出 ${rows.length} 条路：${rows.join(' / ')}`
      );
      await t.click('#frBlank');
      await t.waitFor(`PLAN_ID!==BUILTIN_PLAN_ID && wallEdit.on`, 10000, '空白户型 + 自动进入画墙模式');
      const z = await counts();
      t.assert(
        'demo-zero-state',
        z.walls === 0 && z.win === 0 && z.doors === 0 && z.fx === 0 && z.items === 0,
        `墙${z.walls} 窗${z.win} 门${z.doors} 洁具${z.fx} 家具${z.items}`
      );
      const hint = await t.rectOf('#wMsg').catch(() => null);
      t.assert(
        'demo-zero-hint',
        !!hint && hint.w >= 120 && hint.h >= 12,
        hint ? `编辑提示可见 ${Math.round(hint.w)}×${Math.round(hint.h)}px` : '编辑提示不在视口'
      );

      /* ===== ② 画出房子：22 段（15 实墙 + 3 窗带 + 4 门洞） ===== */
      await t.step('画墙工具：逐段画 22 段（15 实墙 + 3 窗带 + 4 门洞）');
      await t.click('#wtoolSeg button[data-t="wall"]');
      await t.waitFor(`wallEdit.tool==='wall'`, 6000, 'tool=wall');
      const piece = async (type, p, q) => {
        await t.eval(`document.querySelector('#wType').value=${JSON.stringify(type)}`);
        await t.click(await t.planPoint(p[0], p[1]));
        await t.click(await t.planPoint(q[0], q[1]));
        await t.key('Enter', 'Enter', 13);
        await t.waitFor(`wallEdit.drawPts.length===0`, 8000, '这段墙提交');
      };
      for (const [type, x1, y1, x2, y2] of WALLS) await piece(type, [x1, y1], [x2, y2]);
      const g1 = await counts();
      t.assert(
        'demo-walls-count',
        g1.walls === 19 && g1.win === 3,
        `墙实体 ${g1.walls}（期望 15 实墙 + 4 门洞）· 窗带 ${g1.win}（期望 3）`
      );
      const open = await t.eval(`DOC.walls.filter(e=>e.src==='user'&&e.kind==='opening').length`);
      t.assert('demo-openings', open === 4, `门洞 ${open} 段（期望 4）`);
      const shell = await t.eval(
        `(()=>{const P=floorPts();let x1=1e9,y1=1e9,x2=-1e9,y2=-1e9;` +
          `for(const q of P){x1=Math.min(x1,q[0]);y1=Math.min(y1,q[1]);x2=Math.max(x2,q[0]);y2=Math.max(y2,q[1]);}` +
          `return {n:P.length,x1,y1,x2,y2};})()`
      );
      t.assert(
        'demo-shell-outline',
        shell.n >= 4 && shell.x1 <= 1.01 && shell.x2 >= 18.99 && shell.y1 <= 1.01 && shell.y2 >= 12.99,
        `地板轮廓 ${shell.n} 个点，覆盖 ${shell.x1.toFixed(2)}..${shell.x2.toFixed(2)} × ${shell.y1.toFixed(2)}..${shell.y2.toFixed(2)}（画出来的墙成为地板轮廓）`
      );
      await t.shot('walls');

      /* ===== ③ 门：放 4 扇，换一次款式，拖一次门宽 ===== */
      await t.step('门工具：在 4 个门洞上各放一扇门');
      await t.click('#wtoolSeg button[data-t="door"]');
      await t.waitFor(`wallEdit.tool==='door'`, 6000, 'tool=door');
      for (let i = 0; i < DOOR_MID.length; i++) {
        const [mx, my, label] = DOOR_MID[i];
        await t.click(await t.planPoint(mx, my));
        await t.waitFor(`DOC.doors.filter(e=>e.src==='user').length===${i + 1}`, 8000, label + ' 的门放下');
      }
      t.assert('demo-doors-count', (await counts()).doors === 4, '门 4 扇（入户 / 卫生间 / 门厅↔客厅 / 卧室）');
      await t.shot('doors');
      await t.step('换款式：门厅↔客厅那扇改成另一种开法');
      await t.click(await t.planPoint(9.2, 9));
      await t.waitFor(`wallEdit.sel && wallEdit.sel.kind==='door'`, 6000, '选中那扇门');
      const kindBefore = await t.eval(`entById(wallEdit.sel.id).kind`);
      await t.click('#dKind');
      const kindAfter = await t.eval(`entById(wallEdit.sel.id).kind`);
      t.assert('demo-door-kind', kindAfter !== kindBefore, `款式 ${kindBefore} → ${kindAfter}`);
      await t.step('拖门端点改门宽（直接操纵，不是填数字）');
      const dGeom = await t.eval(
        `(()=>{const e=entById(wallEdit.sel.id);return {x1:e.geom.x1,y1:e.geom.y1,x2:e.geom.x2,y2:e.geom.y2};})()`
      );
      const wBefore = Math.hypot(dGeom.x2 - dGeom.x1, dGeom.y2 - dGeom.y1);
      await t.drag(await t.planPoint(dGeom.x2, dGeom.y2), await t.planPoint(dGeom.x2 - 0.8, dGeom.y2), { steps: 10 });
      const wAfter = await t.eval(
        `(()=>{const e=entById(wallEdit.sel.id);return Math.hypot(e.geom.x2-e.geom.x1,e.geom.y2-e.geom.y1);})()`
      );
      t.assert(
        'demo-door-width-drag',
        wAfter < wBefore - 0.4,
        `门宽 ${wBefore.toFixed(2)}ft → ${wAfter.toFixed(2)}ft（拖终点手柄，联动把门洞两侧门垛补回去）`
      );
      await t.shot('door-narrower');

      /* ===== ④ 固定的物品（上）：洁具 4 件，台柜 / 镜子自动贴墙 ===== */
      await t.step('洁具工具：放台柜 / 镜子 / 马桶 / 浴缸');
      await t.click('#wtoolSeg button[data-t="fx"]');
      await t.waitFor(`wallEdit.tool==='fx'`, 6000, 'tool=fx');
      for (let i = 0; i < FX.length; i++) {
        await t.eval(`document.querySelector('#fxType').value=${JSON.stringify(FX[i].type)}`);
        await t.click(await t.planPoint(FX[i].at[0], FX[i].at[1]));
        await t.waitFor(`DOC.fixtures.filter(e=>e.src==='user').length===${i + 1}`, 8000, FX[i].type + ' 放下');
      }
      const fxAll = await t.eval(
        `(()=>DOC.fixtures.filter(e=>e.src==='user').map(f=>({t:f.t,x:(f.x1+f.x2)/2,y:(f.y1+f.y2)/2,rot:f.rot||0})))()`
      );
      t.assert('demo-fx-count', fxAll.length === 4, fxAll.map((f) => f.t).join(' / '));
      const inRoom = (f) => {
        const def = { counter: [2.0, 1.2], mirror: [2.0, 0.3], toilet: [2.3, 1.3], tub: [5.6, 2.5] }[f.t];
        const rot = (f.rot || 0) % 180 !== 0;
        const w = rot ? def[1] : def[0],
          d = rot ? def[0] : def[1];
        return ROOMS.some(
          (r) =>
            f.x - w / 2 >= r[1] - 0.15 &&
            f.x + w / 2 <= r[3] + 0.15 &&
            f.y - d / 2 >= r[2] - 0.15 &&
            f.y + d / 2 <= r[4] + 0.15
        );
      };
      t.assert(
        'demo-fx-inside',
        fxAll.every(inRoom),
        fxAll.map((f) => `${f.t}@(${f.x.toFixed(2)},${f.y.toFixed(2)})`).join(' ')
      );
      const snap = await t.eval(
        `(()=>{const out=[];for(const f of DOC.fixtures.filter(e=>e.src==='user')){` +
          `if(f.t!=='counter'&&f.t!=='mirror')continue;const cx=(f.x1+f.x2)/2,cy=(f.y1+f.y2)/2;` +
          `let best=null,bd=1e9;for(const w of effWalls()){if(w.t!=='w'&&w.t!=='i')continue;` +
          `const dx=w.x2-w.x1,dy=w.y2-w.y1,L2=dx*dx+dy*dy;if(L2<1e-9)continue;` +
          `const ll=Math.sqrt(L2),ux=dx/ll,uy=dy/ll;` +
          `let tt=((cx-w.x1)*dx+(cy-w.y1)*dy)/L2;tt=Math.max(0,Math.min(1,tt));` +
          `const dd=Math.hypot(cx-(w.x1+dx*tt),cy-(w.y1+dy*tt));` +
          `if(dd<bd){bd=dd;let poly=null,pd=1e9;` +
          `for(const q of wallPolys()){const ex=q[1][0]-q[0][0],ey=q[1][1]-q[0][1],el=Math.hypot(ex,ey);` +
          `if(el<0.1||Math.abs((ex*ux+ey*uy)/el)<0.9)continue;` +
          `const qx=(q[0][0]+q[1][0]+q[2][0]+q[3][0])/4,qy=(q[0][1]+q[1][1]+q[2][1]+q[3][1])/4;` +
          `let tq=(qx-w.x1)*ux+(qy-w.y1)*uy;tq=Math.max(0,Math.min(ll,tq));` +
          `const d2=Math.hypot(qx-(w.x1+ux*tq),qy-(w.y1+uy*tq));if(d2<pd){pd=d2;poly=q;}}` +
          `let th=NaN;if(poly&&pd<0.2){const nx=-uy,ny=ux;let lo=1e9,hi=-1e9;` +
          `for(const p of poly){const v=p[0]*nx+p[1]*ny;if(v<lo)lo=v;if(v>hi)hi=v;}th=hi-lo;}` +
          `best={th,wd:w.wd,ang:Math.round(Math.atan2(dy,dx)*180/Math.PI)};}}` +
          `out.push({t:f.t,d:bd,th:best.th,rot:f.rot||0,ang:best.ang});}return out;})()`
      );
      t.assert(
        'demo-fx-wall-snap',
        snap.length === 2 &&
          snap.every(
            (s) =>
              Number.isFinite(s.th) &&
              Math.abs(s.d - (s.th + (s.t === 'mirror' ? 0.3 : 1.2)) / 2) < 0.05 &&
              Math.abs(s.rot - (((s.ang % 180) + 180) % 180)) < 0.6
          ),
        snap
          .map((s) => {
            const depth = s.t === 'mirror' ? 0.3 : 1.2;
            const expect = (s.th + depth) / 2;
            return (
              `${s.t} 中心距墙轴 ${s.d.toFixed(3)}ft · 画出的墙厚 ${s.th.toFixed(3)}ft · 件深 ${depth} → 期望 ${expect.toFixed(3)}ft` +
              ` · rot=${s.rot}（墙角 ${s.ang}°）`
            );
          })
          .join(' · ')
      );
      t.info(
        'demo-wall-angles',
        await t.eval(
          `(()=>DOC.walls.filter(e=>e.src==='user').map(e=>{const a=Math.round(Math.atan2(e.geom.y2-e.geom.y1,e.geom.x2-e.geom.x1)*180/Math.PI);` +
            `return e.kind+'@'+a+'°('+e.geom.x1.toFixed(2)+','+e.geom.y1.toFixed(2)+')→('+e.geom.x2.toFixed(2)+','+e.geom.y2.toFixed(2)+')';}).join(' '))()`
        )
      );
      await t.shot('fixtures');
      await t.click('#wDone');
      await t.waitFor(`!wallEdit.on`, 6000, '退出编辑模式');

      /* ===== ⑤ 固定的物品（下）：公寓自带灯具，界面明说它们不计价 ===== */
      await t.step('目录 → 固定灯具：筒灯 ×4、吸顶灯 ×1、镜前灯 ×1');
      let placedCount = 0;
      const place = async (ref, kw, at, rot90) => {
        placedCount++;
        await t.type('#catSearch', kw);
        await t.waitFor(`!!document.querySelector(${JSON.stringify(cardOf(ref))})`, 8000, '目录里出现 ' + ref);
        await t.click(cardOf(ref));
        await t.waitFor(`state.items.length===${placedCount}`, 8000, ref + ' 加入目录清单');
        const it = await t.eval(
          `(()=>{const i=state.items[state.items.length-1];return {uid:i.uid,ref:i.ref,x:i.x,y:i.y};})()`
        );
        if (rot90) {
          await t.click('#pRot90');
          await t.waitFor(`state.items.find(i=>i.uid===${it.uid}).rot===90`, 6000, ref + ' 转 90°');
        }
        await t.drag(await t.planPoint(it.x, it.y), await t.planPoint(at[0], at[1]), { steps: 14 });
        return await t.eval(
          `(()=>{const i=state.items.find(x=>x.uid===${it.uid});return i?{ref:i.ref,x:i.x,y:i.y,rot:i.rot}:null;})()`
        );
      };
      const placed = [];
      for (const L of LIGHTS) placed.push(await place(L.ref, L.kw, L.at, false));
      const lights = await t.eval(
        `(()=>state.items.filter(i=>{const s=itemSpec(i);return s&&isBuiltIn(s);}).map(i=>i.ref))()`
      );
      t.assert('demo-lights-count', lights.length === 6, `固定灯具 ${lights.length} 件：${lights.join(' / ')}`);
      const totals1 = await t.eval(`document.querySelector('#totals').textContent.replace(/\\s+/g,' ')`);
      t.assert('demo-totals-builtin', /固定灯具不计价/.test(totals1), '#totals = ' + totals1);
      await t.shot('lights');

      /* ===== ⑥ 摆家具：逐件搜索 → 点卡片 → 拖到位 ===== */
      await t.step('目录 → 逐件摆家具（14 件）：搜索 → 点卡片 → 拖到位');
      for (const F of FURN) placed.push(await place(F.ref, F.kw, F.at, F.rot90));
      await t.eval(
        `(()=>{const s=document.querySelector('#catSearch');s.value='';s.dispatchEvent(new Event('input'));})()`
      );
      const off = [];
      for (const F of FURN) {
        const p = placed.find((x) => x && x.ref === F.ref);
        if (!p) {
          off.push(`${F.ref} 没找到`);
          continue;
        }
        const dd = Math.hypot(p.x - F.at[0], p.y - F.at[1]);
        if (dd > 0.8) off.push(`${F.ref} 偏 ${(dd * 30.48).toFixed(0)}cm`);
      }
      t.assert(
        'demo-items-placed',
        off.length === 0,
        off.length ? off.join(' · ') : '14 件家具都落在目标位置（容差 0.8ft ≈ 24cm）'
      );
      t.assert('demo-items-count', (await counts()).items === 20, '家具 + 固定灯具共 20 件');
      const red = await t.eval(`document.querySelectorAll('#furn [stroke="#e05656"]').length`);
      t.assert('demo-no-overlap', red === 0, `红色描边（与其他家具重叠）件数 = ${red}`);
      t.info('demo-totals-all', await t.eval(`document.querySelector('#totals').textContent.replace(/\\s+/g,' ')`));
      await t.shot('furnished');

      /* ===== ⑦ 摆错了：红描边报警 → Ctrl+Z 撤销 ===== */
      await t.step('摆错一件（书柜直接压进沙发）→ 红描边报警 → Ctrl+Z 两步退回去');
      const bad = await place('billy', 'billy', [5.0, 7.4], false);
      await t.waitFor(`document.querySelectorAll('#furn [stroke="#e05656"]').length>=1`, 8000, '红描边报警出现');
      const redBad = await t.eval(`document.querySelectorAll('#furn [stroke="#e05656"]').length`);
      const nBad = (await counts()).items;
      const posBad = await t.eval(`(()=>{const i=state.items.find(x=>x.ref==='billy');return i?[i.x,i.y]:null;})()`);
      /* Ctrl+Z 的输入框守卫：焦点在 <input> 里时快捷键让位给输入框原生撤销。
         上一步 t.type('#catSearch') 把焦点留在搜索框里 → 先真实地离开输入框。 */
      await t.eval(`(()=>{const a=document.activeElement;if(a&&a.blur)a.blur();})()`);
      await t.key('z', 'KeyZ', 90, 2); // Ctrl+Z
      await sleep(900);
      t.info(
        'demo-undo-diag',
        await t.eval(
          `JSON.stringify({act:document.activeElement?document.activeElement.tagName:'?',undo:undoRing.length,redo:redoRing.length,items:state.items.length,lastG:lastGesture})`
        )
      );
      /* 一步撤销 = 一个手势。摆这件书柜是两个手势：点卡片加入（addItem）+ 拖到位（drag）。
         所以第一次 Ctrl+Z 只退拖动，件还在原位；退到「没这件东西」需要第二步。
         演示把这两步都跑出来，而不是假装一步就能撤销整件。 */
      await t.waitFor(`state.items.length===${nBad}`, 8000, '撤销拖动后件还在');
      const posBack = await t.eval(`(()=>{const i=state.items.find(x=>x.ref==='billy');return i?[i.x,i.y]:null;})()`);
      const redMid = await t.eval(`document.querySelectorAll('#furn [stroke="#e05656"]').length`);
      t.assert(
        'demo-undo-drag',
        posBack != null &&
          (await counts()).items === nBad &&
          Math.hypot(posBack[0] - posBad[0], posBack[1] - posBad[1]) > 1.0,
        `Ctrl+Z ①（只退拖动）：${posBad.map((v) => v.toFixed(2)).join(',')} → ${posBack ? posBack.map((v) => v.toFixed(2)).join(',') : '?'}，件数仍 ${nBad}，红描边 ${redMid}（回到默认放置点也可能压到别的件，红描边如实报）`
      );
      await t.eval(`(()=>{const a=document.activeElement;if(a&&a.blur)a.blur();})()`);
      await t.key('z', 'KeyZ', 90, 2); // Ctrl+Z ②
      await sleep(900);
      await t.waitFor(`state.items.length===${nBad - 1}`, 8000, '再撤销一次：这件书柜整个撤掉');
      const redAfter = await t.eval(`document.querySelectorAll('#furn [stroke="#e05656"]').length`);
      t.assert(
        'demo-undo-overlap',
        redBad >= 1 && redAfter === 0 && (await counts()).items === nBad - 1,
        `压进沙发的 ${bad ? bad.ref : '书柜'} 触发 ${redBad} 件红描边 → 两步 Ctrl+Z 后件数 ${nBad - 1}、红描边 ${redAfter}`
      );
      await t.shot('undo');

      /* ===== ⑧ 看见它：3D 俯瞰 ===== */
      await t.step('3D 俯瞰：墙真的立到顶、家具真的在里面');
      await t.click('#btnDoll');
      await t.waitFor(`is3D() && three && three.renderer`, 25000, '3D 场景就绪');
      await t.waitFor(`three.furnMap && three.furnMap.size>=20`, 25000, '家具进场景');
      const scene = await t.eval(
        `(()=>({furn:three.furnMap.size,tri:(()=>{let n=0;three.staticGroup.traverse(o=>{if(o.isMesh&&o.geometry)n+=o.geometry.attributes.position.count/3;});return Math.round(n);})()}))()`
      );
      t.assert('demo-3d-scene', scene.furn === 20, `场景家具 ${scene.furn} 件 · 静态几何 ${scene.tri} 三角形`);
      const hit = await t.eval(
        `(()=>{const rc=new THREE.Raycaster();rc.set(new THREE.Vector3(1,CEIL_H+1.5,5),new THREE.Vector3(0,-1,0));` +
          `const h=rc.intersectObjects(three.staticGroup.children,true);` +
          `return h.length?{y:+h[0].point.y.toFixed(2),d:+h[0].distance.toFixed(2)}:null;})()`
      );
      const ceil = await t.eval('CEIL_H');
      t.assert(
        'demo-3d-wall-stands',
        !!hit && hit.y > 8.0,
        hit ? `左墙 x=1 在 y=${hit.y}ft 处挡住射线（层高 ${ceil}ft）` : '射线穿过左墙打到地板：墙没立起来'
      );
      await t.shot('3d-doll');

      /* ===== ⑨ 走进去：室内视角 ===== */
      await t.step('室内视角（第一人称漫游）');
      await t.click('#btnFP');
      await t.waitFor(`state.view==='fp'`, 15000, '进入室内视角');
      await t.waitFor(`three && three.cam`, 15000, '相机就绪');
      await sleep(600);
      const eye = await t.eval(`+three.cam.position.y.toFixed(2)`);
      const eyeH = await t.eval('EYE_H');
      t.assert('demo-fp-eye', Math.abs(eye - eyeH) < 0.25, `眼高 ${eye}ft（EYE_H=${eyeH}）`);
      const fpo = JSON.parse(
        await t.eval(
          `(()=>{const fp=floorPts();const x=three.cam.position.x,z=three.cam.position.z;let ins=false;for(let i=0,j=fp.length-1;i<fp.length;j=i++){const xi=fp[i][0],yi=fp[i][1],xj=fp[j][0],yj=fp[j][1];if((yi>z)!==(yj>z)&&x<(xj-xi)*(z-yi)/(yj-yi)+xi)ins=!ins;}return JSON.stringify({x:+x.toFixed(2),z:+z.toFixed(2),ins});})()`
        )
      );
      t.assert(
        'demo-fp-inside',
        fpo.ins,
        `站内点 (${fpo.x}, ${fpo.z}) 在户型内 → 看见的是室内（旧版落在硬编码的内置户型客厅）`
      );
      await t.shot('fp');

      /* ===== ⑩ 照片级：GPU 路径追踪（草稿档） ===== */
      await t.step('光追渲染（草稿档）：真全局光照 / 真反射折射 / 真软阴影');
      await t.click('#btnPT');
      await t.waitFor(`getComputedStyle(document.querySelector('#ptModal')).display!=='none'`, 8000, '光追对话框');
      await t.click('#ptSeg button[data-q="draft"]');
      await t.click('#ptGo');
      await t.waitFor(`!!window.__PT_DIAG`, 240000, '光追跑完（草稿档）');
      const diag = await t.eval(`window.__PT_DIAG`);
      const px = await t.eval(
        `(()=>{const cv=three.ptResult;if(!cv)return null;const g=cv.getContext('2d');` +
          `const d=g.getImageData(0,0,cv.width,cv.height).data;let s=0,mx=0;` +
          `for(let i=0;i<d.length;i+=4){const l=(d[i]+d[i+1]+d[i+2])/3;s+=l;if(l>mx)mx=l;}` +
          `return {w:cv.width,h:cv.height,mean:+(s/(d.length/4)).toFixed(1),max:Math.round(mx)};})()`
      );
      t.assert(
        'demo-pt-render',
        !!diag && diag.spp > 0 && !!px && px.mean > 8 && px.max > 90,
        diag && px
          ? `${diag.spp}/${diag.want} 次采样 · 出图 ${px.w}×${px.h} · 平均亮度 ${px.mean} · 最亮 ${px.max}${diag.lost ? ' · 显卡上下文被重置' : ''} · 分块 ${diag.grid}`
          : '光追没出图'
      );
      await t.shot('pt');
      await t.click('#photoOut > div:last-child > button:last-child');
      await t.waitFor(`getComputedStyle(document.querySelector('#photoModal')).display==='none'`, 8000, '关掉光追出图');

      /* ===== ⑪ 带走它：导出户型 ===== */
      await t.step('回 2D → 导出户型（工具 ⌄ → 导出户型）');
      await t.click('#btn2d');
      await t.waitFor(`state.view==='2d'`, 10000, '回到 2D');
      await ensureProTools(t);
      const { readdirSync, readFileSync } = await import('node:fs');
      const dlBefore = new Set(readdirSync(t.downloads).filter((n) => n.endsWith('.json')));
      await t.click('#btnExportDoc');
      let file = null;
      for (let i = 0; i < 40 && !file; i++) {
        await sleep(500);
        const now = readdirSync(t.downloads).filter((n) => n.endsWith('.json'));
        file = now.find((n) => !dlBefore.has(n)) || null;
      }
      t.assert('demo-export-file', !!file, file ? '下载 ' + file : '20s 内没有新的 .json 下载');
      if (file) {
        const doc = JSON.parse(readFileSync(t.downloads + '/' + file, 'utf8'));
        const live = await counts();
        /* 导出户型 = 户型几何（ProjectDoc）；家具不在这份文件里 ——
           它们走「导入布局」（另一个入口）。导入确认框里也这么写。
           断言把这条边界坐实，而不是假装导出一份「什么都在」的文件。 */
        t.assert(
          'demo-export-content',
          doc.walls.length === live.walls &&
            doc.windows.length === live.win &&
            doc.doors.length === live.doors &&
            doc.fixtures.length === live.fx &&
            doc.items === undefined &&
            Array.isArray(doc.floorOutline) &&
            doc.floorOutline.length >= 3,
          `导出 JSON：墙${doc.walls.length} 窗${doc.windows.length} 门${doc.doors.length} 洁具${doc.fixtures.length}（与界面逐项相等）· 地板轮廓 ${doc.floorOutline && doc.floorOutline.length} 个点 · 家具不在户型文档里（走「导入布局」）· 户型名「${doc.name}」`
        );
      }

      /* ===== ⑫ 刷新后还在 ===== */
      await t.step('真实刷新（F5）：房子、门、洁具、家具都还在');
      await t.reload();
      const after = await counts();
      t.assert(
        'demo-reload-persist',
        after.walls === 19 && after.win === 3 && after.doors === 4 && after.fx === 4 && after.items === 20,
        `刷新后 墙${after.walls} 窗${after.win} 门${after.doors} 洁具${after.fx} 家具${after.items}`
      );
      const builtinId = await t.eval('BUILTIN_PLAN_ID');
      const still = await t.eval(
        `({id:PLAN_ID, name:(PLAN_REG.plans.find(p=>p.id===PLAN_ID)||{}).name, active:PLAN_REG.active})`
      );
      t.assert(
        'demo-reload-plan',
        still.id !== builtinId && still.active === still.id,
        `当前户型仍是演示户型「${still.name}」（id ${still.id}）`
      );
      await t.click('#btnDoll');
      await t.waitFor(`is3D() && three && three.renderer`, 25000, '3D 重建');
      await t.waitFor(`three.furnMap && three.furnMap.size>=20`, 25000, '家具重建');
      t.assert('demo-reload-3d', (await t.eval(`three.furnMap.size`)) === 20, '3D 里 20 件都在');
      await t.shot('after-reload');

      /* ===== ⑬ 收尾：这份演示户型删掉，回到内置 ===== */
      await t.step('收尾：切回内置户型 → 两步删除演示户型');
      await ensureProTools(t);
      await t.eval(`switchPlan(${JSON.stringify(builtinId)}, true)`);
      await t.waitFor(`PLAN_ID===${JSON.stringify(builtinId)}`, 12000, '切回内置');
      await t.eval(
        `(()=>{const s=document.querySelector('#planSel');for(const o of s.options){if(o.value!==${JSON.stringify(builtinId)}){s.value=o.value;s.dispatchEvent(new Event('change'));return;}}})()`
      );
      await t.waitFor(`PLAN_ID!==${JSON.stringify(builtinId)}`, 12000, '选中演示户型');
      await t.click('#btnPlanDel');
      await t.waitFor(`document.querySelector('#btnPlanDel').classList.contains('arm')`, 8000, '第一次点击 = 待确认');
      await t.click('#btnPlanDel');
      await t.waitFor(`PLAN_ID===${JSON.stringify(builtinId)}`, 12000, '删除后回到内置');
      const reg = await t.eval(
        `({n:PLAN_REG.plans.length, active:PLAN_REG.active, builtin:${JSON.stringify(builtinId)}})`
      );
      t.assert(
        'demo-plan-cleanup',
        reg.n === 1 && reg.active === reg.builtin,
        `户型列表剩 ${reg.n} 份（内置），当前 = ${reg.active}`
      );
    },
  },
];
