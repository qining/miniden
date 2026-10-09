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
    name: 'multi-plan',
    title: '多户型：新建空白 → 切回内置（编辑还在）→ 重命名 → 两步删除',
    run: async (t) => {
      const before = await stateOf(t);
      const c = await planCenter(t);
      const ensurePro = async () => {
        const open = await t.eval(`getComputedStyle(document.querySelector('#proTools')).display!=='none'`);
        if (open) return;
        await t.click('#btnMore'); // 「工具 ⌄」是个开关：只在关着的时候点，不然会把它关掉
        await t.waitFor(
          `getComputedStyle(document.querySelector('#proTools')).display!=='none'`,
          5000,
          'proTools 展开'
        );
      };
      await t.step('打开「工具」第二层');
      await ensurePro();
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
      await ensurePro();
      await t.click('#btnPlanNew');
      await t.waitFor(`PLAN_ID!==BUILTIN_PLAN_ID`, 8000, '切到空白户型');
      const blank = await t.eval(
        `({id:PLAN_ID, walls:effWalls().length, items:state.items.length, fp:floorPts().length, plans:PLAN_REG.plans.length})`
      );
      const pickPlan = (id) =>
        t.eval(
          `(()=>{const s=document.querySelector('#planSel'); s.value=${JSON.stringify(id)};` +
            `s.dispatchEvent(new Event('change',{bubbles:true}));})()`
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
      await pickPlan(builtinId);
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
      await pickPlan(blank.id);
      await t.waitFor(`PLAN_ID===${JSON.stringify(blank.id)}`, 8000, '切回空白户型');
      await ensurePro();
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
];
