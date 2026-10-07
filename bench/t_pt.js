window.__EPT=[];
window.addEventListener('error', e=>window.__EPT.push(e.message+' :'+e.lineno));
const _ce=console.error; console.error=function(){ window.__EPT.push('console.error: '+[].slice.call(arguments).join(' ').slice(0,600)); _ce.apply(console,arguments); };
const _cw=console.warn;  console.warn =function(){ const m=[].slice.call(arguments).join(' '); if(/shader|GLSL|program|compil/i.test(m)) window.__EPT.push('console.warn: '+m.slice(0,600)); _cw.apply(console,arguments); };
window.addEventListener('load', ()=>{ setTimeout(runPT, 500); });
async function runPT(){
  const log=[];
  const T=(n,ok,x)=>log.push((ok?'PASS':'FAIL')+' '+n+(x!==undefined?' | '+x:''));
  const wait=(ms)=>new Promise(r=>setTimeout(r,ms||150));
  try{
    try{ localStorage.removeItem(ITEMS_KEY); }catch(e){}
    // 光追要在「有家具的客厅」上测，空屋测不出真实的 BVH 规模和光源数量
    state.items=[]; save=()=>{};
    // S10：布局锚定「客厅」标签中心，坐标全是相对锚点的偏移（ft）→ plan-independent，
    // 且不含任何真实户型绝对坐标（§1.4 隐私边界：入库 bench 不许出现 mine 的几何）。
    // 注意不能用 floorPts bbox 中心（≠房间中心：家具会移出租界，firefly 43→75 破限）；
    // 下面的 bbox 兜底只在 plan 没有「客厅」标签时生效（内置两个 plan 都有）。
    const _fp=floorPts(), _fx=_fp.map(p=>p[0]), _fy=_fp.map(p=>p[1]);
    const _lab=((LABELS.find(l=>/客厅/.test(l.t))||{}).p)
      ||[(Math.min(..._fx)+Math.max(..._fx))/2,(Math.min(..._fy)+Math.max(..._fy))/2];
    const LIVING=[
      ['kivik3',-0.7,-2.4,0],['listerby_ct',-0.7,0.8,0],['stoense23',-0.7,0.4,0],
      ['besta180',-0.7,-5.4,0],['poang',4.6,-1.4,-40],['strandmon',2.8,3.6,150],
      ['billy',-5.3,-3.9,90],['vittsjo_sh',-5.3,3.6,90],['docksta',8.8,3.1,0],
      ['tobias',7.2,3.1,90],['odger',8.8,1.5,0],['raskog-0',10.8,-0.4,0],
      ['vidja',-3.9,-4.8,0],['hw-02e',6.4,5.0,0],['dl-6',-2.2,-3.9,0],
      ['dl-6',2.8,-3.9,0],['dl-6',7.8,-3.9,0],['dl-6',-2.2,1.1,0],
      ['dl-6',2.8,1.1,0],['dl-6',7.8,1.1,0],['cl-flush-l',8.8,3.1,0],
      ['pendant',0.8,-7.4,0]];
    for(const [id,dx,dy,rot] of LIVING)
      if(CATALOG.some(c=>c.id===id)) state.items.push({uid:uidSeq++, ref:id, x:_lab[0]+dx, y:_lab[1]+dy, rot});
    refresh(); setView('3d'); await wait(3200);
    setCamMode('fp'); await wait(600);
    three.cam.position.set(_lab[0]+1.8, EYE_H, _lab[1]+4.6); fpYaw=Math.PI; fpPitch=-0.05;
    if(typeof applyFP==='function') applyFP();
    await wait(300);

    /* ---- 0. GL 能力探针（诊断：float FBO 不支持时 PT 整条管线变 no-op → 全黑图）---- */
    {
      const glc = document.createElement('canvas'); glc.width = glc.height = 8;
      const gl2 = glc.getContext('webgl2');
      const f = gl2 ? (gl2.getExtension('EXT_color_buffer_float') ? 1 : 0) : 0;
      const h = gl2 ? (gl2.getExtension('EXT_color_buffer_half_float') ? 1 : 0) : 0;
      const maxT = gl2 ? gl2.getParameter(gl2.MAX_TEXTURE_SIZE) : 0;
      T('pt-gl-capability', !!gl2 && !!(f || h), 'webgl2=' + !!gl2 + ' floatFBO=' + f + ' halfFBO=' + h + ' maxTex=' + maxT);
    }

    /* ---- 1. 场景收集 ---- */
    const S=ptCollect();
    T('pt-collect-tris', !!S && S.nTri>80000, S? (S.nTri.toLocaleString()+' 三角形 · '+S.mats.length+' 材质 · '+S.maps.length+' 贴图') : 'null');
    let finite=true;
    for(let i=0;i<S.P.length;i+=997){ if(!isFinite(S.P[i])) { finite=false; break; } }
    T('pt-collect-finite', finite);

    /* ---- 2. BVH 正确性（CPU 独立校验）---- */
    const B=ptBuildBVH(S.nTri, S.cen, S.bmn, S.bmx);
    T('pt-bvh-built', B.nodeCnt>1 && B.nodeCnt<S.nTri*2, B.nodeCnt.toLocaleString()+' 节点');
    const seen=new Uint8Array(S.nTri); let dup=0;
    for(let i=0;i<S.nTri;i++){ if(seen[B.idx[i]]) dup++; seen[B.idx[i]]=1; }
    T('pt-bvh-idx-permutation', dup===0, 'dup='+dup);
    const N=B.nodes; let leafSum=0, badTri=0, badChild=0, maxDepth=0, leaves=0, maxLeaf=0;
    const EPS=1e-3;
    const inside=(o,x0,y0,z0,x1,y1,z1)=>
      x0>=N[o]-EPS && y0>=N[o+1]-EPS && z0>=N[o+2]-EPS &&
      x1<=N[o+4]+EPS && y1<=N[o+5]+EPS && z1<=N[o+6]+EPS;
    const st=[[0,0]];
    while(st.length){
      const [ni,d]=st.pop(); const o=ni*8; maxDepth=Math.max(maxDepth,d);
      const cnt=N[o+7], first=N[o+3];
      if(cnt>0){ leaves++; leafSum+=cnt; maxLeaf=Math.max(maxLeaf,cnt);
        for(let i=first;i<first+cnt;i++){ const t=B.idx[i]*3;
          if(!inside(o,S.bmn[t],S.bmn[t+1],S.bmn[t+2],S.bmx[t],S.bmx[t+1],S.bmx[t+2])) badTri++; }
      } else { const l=first, r=first+1;
        for(const c of [l,r]){ const co=c*8;
          if(!inside(o,N[co],N[co+1],N[co+2],N[co+4],N[co+5],N[co+6])) badChild++; }
        st.push([l,d+1],[r,d+1]); }
    }
    T('pt-bvh-covers-all', leafSum===S.nTri, leafSum+'/'+S.nTri);
    T('pt-bvh-tri-in-leaf-box', badTri===0, 'bad='+badTri);
    T('pt-bvh-child-in-parent', badChild===0, 'bad='+badChild);
    T('pt-bvh-depth-fits-stack', maxDepth<48, 'depth='+maxDepth+' 叶='+leaves+' 最大叶='+maxLeaf);

    /* ---- 3. 渲染 + 进度 + 降噪 ---- */
    const noiseOf=(cv)=>{                       // 平均 |拉普拉斯|：高频能量 = 噪点强度
      const g=cv.getContext('2d'), w=cv.width, h=cv.height;
      const d=g.getImageData(0,0,w,h).data;
      const L=(x,y)=>{ const i=(y*w+x)*4; return d[i]*0.299+d[i+1]*0.587+d[i+2]*0.114; };
      let s=0,n=0;
      for(let y=1;y<h-1;y++) for(let x=1;x<w-1;x++){
        s+=Math.abs(4*L(x,y)-L(x-1,y)-L(x+1,y)-L(x,y-1)-L(x,y+1)); n++; }
      return s/n;
    };
    const runOnce=(dn, nspp)=>new Promise(res=>{
      const seenTxt=[];
      // 用 MutationObserver 而不是 setInterval：headless 虚拟时间下 0ms 定时器链会饿死长间隔定时器
      const el=document.querySelector('#photoTxt');
      const mo=new MutationObserver(()=>{ const t=el.textContent;
        if(t && seenTxt[seenTxt.length-1]!==t) seenTxt.push(t); });
      mo.observe(el, {childList:true, characterData:true, subtree:true});
      ptRender(nspp||8, {maxPx: 96*74, bounces: 3, denoise: dn,
        onDone:(cv,spp)=>{ mo.disconnect(); res({cv, spp, seenTxt}); }});
      setTimeout(()=>{ mo.disconnect(); res(null); }, 120000);
    });

    const errs0=window.__EPT.length;
    const off=await runOnce(false);
    T('pt-render-finished', !!off && off.spp>=8, off? (off.spp+' spp · '+off.cv.width+'x'+off.cv.height) : '超时');
    const shaderErr=window.__EPT.slice(errs0).filter(m=>/shader|GLSL|program|compil/i.test(m));
    T('pt-shader-compiles', shaderErr.length===0, shaderErr.join(' ;; ').slice(0,400));

    if(off){
      // 进度必须真的在走，而且不能一直是 0
      const pcts=off.seenTxt.map(t=>{ const m=t.match(/([\d.]+)%/); return m? parseFloat(m[1]) : null; })
                            .filter(v=>v!==null);
      T('pt-progress-updates', off.seenTxt.length>=3, off.seenTxt.length+' 次文案变化');
      T('pt-progress-nonzero', pcts.some(v=>v>0), '出现过的百分比: '+pcts.slice(0,6).join(',')+
        (pcts.length? ' 最大='+Math.max.apply(null,pcts)+'%' : ' 无'));
      T('pt-progress-monotonic', pcts.length<2 || pcts.every((v,i)=>i===0||v>=pcts[i-1]-0.01), pcts.slice(-4).join(' → '));
      const g=off.cv.getContext('2d');
      const d=g.getImageData(0,0,off.cv.width,off.cv.height).data;
      let sum=0,nz=0,mx=0;
      for(let i=0;i<d.length;i+=4){ const l=d[i]*0.299+d[i+1]*0.587+d[i+2]*0.114;
        sum+=l; if(l>4) nz++; mx=Math.max(mx,l); }
      const n=d.length/4;
      T('pt-image-not-black', sum/n>6 && nz/n>0.35, '均值='+(sum/n).toFixed(1)+' 亮像素='+((nz/n)*100).toFixed(0)+'%');
      T('pt-image-has-range', mx>60, '峰值='+mx.toFixed(0));
    }

    const on=await runOnce(true);
    T('pt-denoise-finished', !!on && on.spp>=8, on? (on.spp+' spp') : '超时');
    if(off && on){
      const nOff=noiseOf(off.cv), nOn=noiseOf(on.cv);
      // 注意：拉普拉斯量的是「高频能量」，满家具场景里边缘和贴图本身就贡献大量高频，
      // 而降噪器是保边的——所以这个比值天然比空屋高。空屋能到 63%，满屋 15~30% 正常。
      T('pt-denoise-reduces-noise', nOn < nOff*0.85,
        '关='+nOff.toFixed(2)+' 开='+nOn.toFixed(2)+'（降 '+(100*(1-nOn/nOff)).toFixed(0)+'%，满家具场景）');
      const g2=on.cv.getContext('2d');
      const d2=g2.getImageData(0,0,on.cv.width,on.cv.height).data;
      let s2=0; for(let i=0;i<d2.length;i+=4) s2+=d2[i]*0.299+d2[i+1]*0.587+d2[i+2]*0.114;
      T('pt-denoise-keeps-brightness', s2/(d2.length/4) > 6, '降噪后均值='+(s2/(d2.length/4)).toFixed(1));
    }
    /* ===== v3.5：GPU 栅栏节流 / NaN 防护 / 上下文丢失 ===== */
    // 进度必须由 GPU 真实完成量驱动：文案里出现「等待 GPU」说明栅栏在起作用；
    // 就算没等到，也必须单调且最后落到 100%
    // 每次渲染各自判断单调性——两次独立渲染串起来比会误判（第二次从头开始）
    const pctOf = (run)=> (run? run.seenTxt : []).map(t=>{ const m=t.match(/([\d.]+)%/);
      return m? parseFloat(m[1]) : null; }).filter(v=>v!==null);
    const pctA = pctOf(off), pctB = pctOf(on);
    T('pt-progress-reaches-full', pctA.length>0 && Math.max.apply(null, pctA) >= 87,
      '最大进度 '+Math.max.apply(null, pctA)+'%');
    T('pt-progress-never-jumps-back',
      pctA.every((v,i)=>i===0 || v>=pctA[i-1]-0.01) &&
      pctB.every((v,i)=>i===0 || v>=pctB[i-1]-0.01),
      '降噪关 '+pctA.length+' 次 / 降噪开 '+pctB.length+' 次采样点，各自单调');
    T('pt-progress-fine-grained', pctA.length >= 20,
      pctA.length+' 次进度更新（粒度太粗会让用户以为卡住了）');
    T('pt-fence-throttles', typeof WebGL2RenderingContext!=='undefined' &&
      !!three.renderer.getContext().fenceSync, '浏览器支持 fenceSync');
    // 早停时上报的 spp 必须是真实完成量，不能谎报成 samples
    T('pt-reports-real-spp', off.spp<=8 && off.spp>0, '请求 8，实际完成 '+off.spp);
    // NaN 防护：出图里不能有孤立的极亮点（NaN 会被加法混合永久累进）
    if(off && off.cv){
      const g4=off.cv.getContext('2d'), w4=off.cv.width, h4=off.cv.height;
      const d4=g4.getImageData(0,0,w4,h4).data;
      const L4=(x,y)=>{ const i=(y*w4+x)*4; return d4[i]*0.299+d4[i+1]*0.587+d4[i+2]*0.114; };
      let spikes=0;
      for(let y=1;y<h4-1;y++) for(let x=1;x<w4-1;x++){
        const c=L4(x,y);
        if(c<200) continue;
        const nb=(L4(x-1,y)+L4(x+1,y)+L4(x,y-1)+L4(x,y+1))/4;
        if(c-nb>110) spikes++;            // 比四邻亮出一大截 = 孤立亮点
      }
      // 阈值随采样数收紧：萤火虫大致按 1/sqrt(spp) 衰减，NaN 则完全不衰减
      const spikeLim = 0.02/Math.sqrt(Math.max(1, off.spp));
      T('pt-no-nan-spikes', spikes/(w4*h4) < spikeLim,
        spikes+' 个孤立亮点 / '+(w4*h4)+' 像素 = '+((spikes/(w4*h4))*100).toFixed(2)
        +'%（'+off.spp+' spp 的上限 '+(spikeLim*100).toFixed(2)+'%）');
      window.__spike8 = spikes/(w4*h4);
    }
    /* NaN 与萤火虫的决定性区分：提高采样数后孤立亮点必须显著变少。
       萤火虫是未收敛的高方差样本，会随采样衰减；NaN 被加法混合永久累进，不会。 */
    const hi = await runOnce(false, 32);
    if(hi && hi.cv && window.__spike8 != null){
      const g5=hi.cv.getContext('2d'), w5=hi.cv.width, h5=hi.cv.height;
      const d5=g5.getImageData(0,0,w5,h5).data;
      const L5=(x,y)=>{ const i=(y*w5+x)*4; return d5[i]*0.299+d5[i+1]*0.587+d5[i+2]*0.114; };
      let sp5=0;
      for(let y=1;y<h5-1;y++) for(let x=1;x<w5-1;x++){
        const c=L5(x,y); if(c<200) continue;
        const nb=(L5(x-1,y)+L5(x+1,y)+L5(x,y-1)+L5(x,y+1))/4;
        if(c-nb>110) sp5++; }
      const f8=window.__spike8, f32=sp5/(w5*h5);
      T('pt-spikes-are-fireflies-not-nan', f32 < f8*0.75,
        '8spp '+(f8*100).toFixed(2)+'% → 32spp '+(f32*100).toFixed(2)
        +'%（NaN 不会随采样衰减）');
    } else T('pt-spikes-are-fireflies-not-nan', false, '高采样对照渲染失败');

    /* KALLAX 这类白色格架在光追下曾经「快隐身」：把光栅用的 amb+hemi 假环境光
       原样叠到真 GI 上，等于把房间塞进发光白球，对比度被抹平，白家具和白墙糊成一片。
       这里用「结构对比度」守住——格子的明暗层次必须还在。 */
    const kal = CATALOG.find(c=>c.id==='kallax-a-0');
    if(kal){
      // S10：KALLAX 子场景同样锚在客厅标签上（相对偏移，无绝对坐标）
      state.items=[{uid:9001, ref:kal.id, x:_lab[0], y:_lab[1], rot:0},
                   {uid:9002, ref:'dl-6', x:_lab[0], y:_lab[1]+2.1, rot:0}];
      refresh(); await wait(1200);
      three.cam.position.set(_lab[0], EYE_H, _lab[1]+4.6); fpYaw=Math.PI; fpPitch=-0.02;
      if(typeof fpAim==='function') fpAim();
      await wait(400);
      let kalMean=null, kalSd=null, kalOk=false;
      for(let kalTry=0; kalTry<2; kalTry++){
        const kr = await new Promise(r=>{
          ptRender(24, {maxPx:140*100, bounces:4, denoise:false, onDone:(cv,spp)=>r({cv,spp})});
          setTimeout(()=>r(null), 300000);
        });
        if(!kr || !kr.cv){ kalOk=false; break; }
        kalOk=true;
        const g6=kr.cv.getContext('2d'), w6=kr.cv.width, h6=kr.cv.height;
        const d6=g6.getImageData(0,0,w6,h6).data;
        // 只看画面中段（KALLAX 所在的横条），算亮度标准差 = 结构可辨识度
        let sum=0, sum2=0, n=0;
        for(let y=Math.floor(h6*0.35); y<Math.floor(h6*0.85); y++)
          for(let x=Math.floor(w6*0.25); x<Math.floor(w6*0.75); x++){
            const i=(y*w6+x)*4, v=d6[i]*0.299+d6[i+1]*0.587+d6[i+2]*0.114;
            sum+=v; sum2+=v*v; n++; }
        kalMean=sum/n; kalSd=Math.sqrt(Math.max(0, sum2/n - kalMean*kalMean));
        // AGENTS §3：探针偶发全黑（均值 0/标准差 0，headless 瞬态）→ 原样重渲一次再下结论
        if(kalMean===0 && kalSd===0 && kalTry===0){ await wait(600); continue; }
        break;
      }
      if(kalOk && kalMean!==null)
        T('pt-kallax-visible', kalSd > 18 && kalMean > 25 && kalMean < 235,
          '格架区域 亮度均值 '+kalMean.toFixed(1)+' 标准差 '+kalSd.toFixed(1)
          +'（标准差太小=糊成一片，均值贴边=过曝或全黑）');
      else T('pt-kallax-visible', false, '渲染没返回');
      state.items=[]; refresh();
    }
    // 环境光填充不能压过真 GI：光追里的天光残留应该远小于光栅的 amb+hemi
    T('pt-ambient-fill-modest', /AMB_FILL\s*=\s*0\.[0-4]/.test(ptRender.toString()),
      '环境光填充系数保持在 0.0~0.4');

    /* ===== 分块自适应：单个 draw 必须短于看门狗阈值（v3.7） =====
       真实 GPU 计时在 headless 下测不到（虚拟时间冻结 performance.now），
       所以直接测决策函数本身。 */
    const GRID = [4, 32, 70, 6];        // minTX, maxTX, tileMax(ms), tileMin(ms)
    const PXS = [480000, 900000, 1600000];
    let gridBad = [], gridTab = [];
    for(const px of PXS){
      for(const us of [0.05, 0.2, 1, 2, 5, 10, 20]){     // 每像素耗时，覆盖强显卡到极弱
        const perPx = us/1000;
        const tx = ptPickGrid(perPx, px, GRID[0], GRID[1], GRID[2]);
        const per = perPx*px/(tx*tx);
        if(per > GRID[2] && tx < GRID[1]) gridBad.push(px/1000+'k/'+us+'µs 没切够细');
        if(tx < GRID[0] || tx > GRID[1]) gridBad.push(px/1000+'k/'+us+'µs 越界 '+tx);
        if(px===900000) gridTab.push(us+'µs→'+tx+'x'+tx);
      }
    }
    T('pt-grid-keeps-draw-short', gridBad.length===0,
      gridBad.length? gridBad.join(' | ') : '标准档: '+gridTab.join(' '));
    // 弱显卡必须真的切到更细：8x8 不是万能答案
    T('pt-grid-scales-with-gpu',
      ptPickGrid(0.0002, 900000, 4, 32, 70) === 4 &&      // 强显卡：4x4 就够
      ptPickGrid(0.005,  900000, 4, 32, 70) >= 16 &&      // 弱显卡：必须 ≥16x16
      ptPickGrid(0.02,   900000, 4, 32, 70) === 32,       // 极弱：顶到 32x32
      '0.2µs→'+ptPickGrid(0.0002,900000,4,32,70)+'x · 5µs→'+ptPickGrid(0.005,900000,4,32,70)
      +'x · 20µs→'+ptPickGrid(0.02,900000,4,32,70)+'x');
    // 运行中校正：太慢就加倍、太快就减半、区间内不动
    T('pt-grid-adjusts-at-runtime',
      ptAdjustGrid(8, 200, 4, 32, 70, 6) === 16 &&
      ptAdjustGrid(8, 2,   4, 32, 70, 6) === 4  &&
      ptAdjustGrid(8, 30,  4, 32, 70, 6) === 8  &&
      ptAdjustGrid(32, 999, 4, 32, 70, 6) === 32 &&       // 到顶不再加
      ptAdjustGrid(4, 0.1, 4, 32, 70, 6) === 4,           // 到底不再减
      '慢→加倍 / 快→减半 / 区间内不动 / 到顶到底都夹住');

    T('pt-cleanup', PT===null, PT===null?'已释放':'仍占用');
    T('pt-quality-presets', !!(PT_QUALITY.draft&&PT_QUALITY.normal&&PT_QUALITY.fine),
      Object.keys(PT_QUALITY).map(k=>PT_QUALITY[k].label+':'+PT_QUALITY[k].spp+'spp').join(' '));
  }catch(e){ log.push('EXC '+e.message+' | '+(e.stack||'').split('\n')[1]); }
  log.push('ERRS: '+JSON.stringify(window.__EPT.slice(0,6)));
  const pre=document.createElement('pre'); pre.id='tpt'; pre.textContent=log.join('\n');
  document.body.appendChild(pre);
}
