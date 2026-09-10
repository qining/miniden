# -*- coding: utf-8 -*-
"""光追压力测试：4 套真实的满家具客厅布局，逐套跑 PT，验证能不能跑完。

  python3 work/pt_stress.py                 # 全部 4 套
  python3 work/pt_stress.py D_极限堆料 8 8800   # 指定布局 / spp / 像素数

布局也导出成了 work/layouts/*.json，可以直接用界面上的「导入布局」载进去手动看。

重点看：分块标定选了几乘几、单块耗时、是否上下文丢失、实际完成的 spp 是否等于请求值。
"""
import html, os, re, subprocess, sys

ROOT = '/Users/dako/planner'
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
TAG = f'_ptstress{os.getpid()}'

PROBE = r'''<script>
window.__E=[]; window.addEventListener('error',e=>window.__E.push(e.message+':'+e.lineno));
const _ce=console.error; console.error=function(){ window.__E.push('E:'+[].slice.call(arguments).join(' ').slice(0,200)); _ce.apply(console,arguments); };
window.addEventListener('load', ()=>{ setTimeout(async ()=>{
  const L=[], wait=ms=>new Promise(r=>setTimeout(r,ms||200));
  try{
    try{ localStorage.removeItem('planner_v1'); }catch(e){}
    save=()=>{};
    /* ---- 客厅区域（英尺）：客厅/餐厅大致 x 14..33, y 20..34 ---- */
    const LAY = __LAYOUTS__;
    const NAME = __NAME__;
    const lay = LAY[NAME];
    state.items = lay.map((p,i)=>({uid:1000+i, ref:p[0], x:p[1], y:p[2], rot:p[3]||0}));
    refresh(); setView('fp'); await wait(3800);
    // 站到客厅中间朝北看，视野里家具最多
    three.cam.position.set(23, EYE_H, 30);
    fpYaw = Math.PI; fpPitch = -0.06;
    if(typeof fpAim==='function') fpAim();
    await wait(500);

    const scene = ptCollect();
    L.push('布局 '+NAME+'：'+state.items.length+' 件家具');
    L.push('场景 '+scene.nTri.toLocaleString()+' 三角形 · '+scene.mats.length+' 材质 · '+scene.maps.length+' 贴图');
    const lights = ptLights();
    L.push('光源 '+lights.length+' 盏');

    const txts=[];
    const el0=document.querySelector('#photoTxt');
    const mo=new MutationObserver(()=>{ const t=el0.textContent;
      if(t && txts[txts.length-1]!==t) txts.push(t); });
    mo.observe(el0,{childList:true,characterData:true,subtree:true});

    const t0=performance.now();
    const res = await new Promise(r=>{
      ptRender(__SPP__, {maxPx: __MAXPX__, bounces: __BOUNCES__, denoise:true,
        onDone:(cv,spp)=>{ mo.disconnect(); r({cv,spp}); }});
      setTimeout(()=>{ mo.disconnect(); r(null); }, 600000);
    });
    const secs=(performance.now()-t0)/1000;
    if(!res){ L.push('FAIL 渲染超时未返回'); }
    else {
      L.push((res.spp>=__SPP__ ? 'PASS ' : 'FAIL ')+'完成采样 '+res.spp+'/'+__SPP__
             +(secs>0?(' · '+secs.toFixed(1)+'s'):''));
      // 分块标定 / 单块耗时
      const grid=txts.map(t=>{ const m=t.match(/@(\d+)x\d+/); return m?+m[1]:null; }).filter(Boolean);
      const per =txts.map(t=>{ const m=t.match(/([\d.]+)ms\/块/); return m?parseFloat(m[1]):null; }).filter(v=>v!==null);
      L.push('分块 '+(grid.length? [...new Set(grid)].join('→')+'（'+grid[grid.length-1]+'x'+grid[grid.length-1]+' 收敛）' : '未报告'));
      L.push('单块耗时 '+(per.length? (Math.min.apply(null,per).toFixed(0)+'~'+Math.max.apply(null,per).toFixed(0)+'ms') : '未报告'));
      // 进度粒度与单调性
      const pct=txts.map(t=>{ const m=t.match(/([\d.]+)%/); return m?parseFloat(m[1]):null; }).filter(v=>v!==null);
      L.push((pct.length>=15?'PASS ':'FAIL ')+'进度更新 '+pct.length+' 次');
      L.push((pct.every((v,i)=>i===0||v>=pct[i-1]-0.01)?'PASS ':'FAIL ')+'进度单调');
      // 上下文丢失
      const lost = txts.some(t=>/重置/.test(t)) || document.querySelector('#photoOut')
        && /重置/.test(document.querySelector('#photoOut').textContent||'');
      L.push((lost?'FAIL ':'PASS ')+'上下文'+(lost?'被重置':'未丢失'));
      // 出图质量
      if(res.cv){
        const g=res.cv.getContext('2d'), w=res.cv.width, h=res.cv.height;
        const d=g.getImageData(0,0,w,h).data;
        let sum=0,nz=0,spike=0;
        const Lm=(x,y)=>{const i=(y*w+x)*4; return d[i]*.299+d[i+1]*.587+d[i+2]*.114;};
        for(let i=0;i<d.length;i+=4){ const v=d[i]*.299+d[i+1]*.587+d[i+2]*.114; sum+=v; if(v>6) nz++; }
        for(let y=1;y<h-1;y++) for(let x=1;x<w-1;x++){ const c=Lm(x,y);
          if(c<200) continue;
          const nb=(Lm(x-1,y)+Lm(x+1,y)+Lm(x,y-1)+Lm(x,y+1))/4;
          if(c-nb>110) spike++; }
        const n=d.length/4;
        L.push((sum/n>6 && nz/n>0.5 ? 'PASS ':'FAIL ')+'出图 '+w+'x'+h
               +' 均值'+(sum/n).toFixed(1)+' 亮像素'+((nz/n)*100).toFixed(0)+'%');
        L.push((spike/n<0.004?'PASS ':'FAIL ')+'孤立亮点 '+spike+'/'+n);
      }
    }
  }catch(e){ L.push('EXC '+e.message+' | '+(e.stack||'').split(String.fromCharCode(10))[1]); }
  L.push('ERR='+JSON.stringify(window.__E.slice(0,4)));
  const p=document.createElement('pre'); p.id='probe'; p.textContent=L.join(String.fromCharCode(10));
  document.body.appendChild(p);
}, 900); });
</script>'''

# ---- 4 套客厅布局（客厅/餐厅区约 x 14..33, y 20..34 ft）----
LAYOUTS = {
  'A_基本客厅': [
    ['soderhamn3', 20.0, 24.0, 0], ['borgeby', 20.0, 27.5, 0],
    ['stoense23', 20.5, 26.5, 0], ['besta180', 20.0, 21.0, 0],
    ['saltsjobaden-0', 25.5, 24.5, -35], ['lack_side', 26.5, 27.0, 0],
    ['vidja', 16.5, 22.0, 0], ['hektar_f', 24.5, 21.5, 0],
    ['billy', 15.5, 25.5, 90], ['kallax-a-0', 15.5, 29.0, 90],
    ['docksta', 28.5, 29.0, 0], ['teodores', 27.0, 29.0, 90],
    ['teodores', 30.0, 29.0, -90], ['odger', 28.5, 27.4, 0],
    ['lisabo_ch', 28.5, 30.6, 180],
    ['dl-6', 19.0, 23.0, 0], ['dl-6', 24.0, 23.0, 0], ['dl-6', 19.0, 28.0, 0],
    ['dl-6', 24.0, 28.0, 0], ['cl-flush', 28.5, 29.0, 0],
  ],
  'B_满配客厅': [
    ['kivik3', 19.5, 24.0, 0], ['kivik2', 15.8, 27.5, 90],
    ['listerby_ct', 19.5, 27.2, 0], ['stoense23', 19.5, 26.8, 0],
    ['besta180', 19.5, 21.0, 0], ['lack_tv', 24.5, 21.0, 0],
    ['poang', 24.8, 25.0, -40], ['strandmon', 23.0, 30.0, 150],
    ['vittsjo_nest', 24.6, 27.4, 0], ['gladom', 16.6, 24.4, 0],
    ['billy', 14.9, 22.5, 90], ['billy', 14.9, 25.2, 90],
    ['vittsjo_sh', 14.9, 30.0, 90], ['kallax-b-0', 30.5, 22.0, -90],
    ['docksta', 29.0, 29.5, 0], ['tobias', 27.4, 29.5, 90],
    ['tobias', 30.6, 29.5, -90], ['odger', 29.0, 27.9, 0], ['odger', 29.0, 31.1, 180],
    ['raskog-0', 31.0, 26.0, 0], ['vidja', 16.3, 21.6, 0],
    ['ranarp_f', 25.8, 22.4, 0], ['hektar_f', 22.2, 31.2, 0],
    ['hw-02e', 26.6, 31.4, 0],
    ['dl-6', 18.0, 22.5, 0], ['dl-6', 23.0, 22.5, 0], ['dl-6', 28.0, 22.5, 0],
    ['dl-6', 18.0, 27.5, 0], ['dl-6', 23.0, 27.5, 0], ['dl-6', 28.0, 27.5, 0],
    ['dl-4', 20.5, 31.5, 0], ['dl-4', 25.5, 31.5, 0],
    ['cl-flush-l', 29.0, 29.5, 0], ['pendant', 21.0, 19.0, 0],
  ],
  'C_儿童区': [
    ['soderhamn3', 19.0, 23.5, 0], ['borgeby', 19.0, 27.0, 0],
    ['wk-mat-l-0', 24.5, 27.5, 0], ['pg_magnolia', 25.0, 24.0, 0],
    ['pg_hazel', 29.5, 30.0, 20], ['lunix-0', 16.5, 30.5, 0],
    ['figgy-0', 30.0, 24.5, 0], ['pg_qriser', 31.0, 21.5, 0],
    ['besta120', 19.0, 21.0, 0], ['kallax-a-0', 14.9, 25.0, 90],
    ['raskog-1', 15.4, 28.5, 0], ['sniglar-crib-0', 31.0, 27.0, 0],
    ['hw-02e-gen', 22.0, 31.5, 0], ['vidja', 16.4, 22.2, 0],
    ['dl-6', 18.5, 23.0, 0], ['dl-6', 23.5, 23.0, 0], ['dl-6', 28.5, 23.0, 0],
    ['dl-6', 18.5, 28.5, 0], ['dl-6', 23.5, 28.5, 0], ['dl-6', 28.5, 28.5, 0],
    ['cl-flush', 26.0, 31.0, 0],
  ],
  'D_极限堆料': [
    ['kivik3', 19.5, 23.8, 0], ['ekholma3', 15.6, 27.0, 90], ['uppland3', 30.6, 27.0, -90],
    ['listerby_ct', 19.5, 27.0, 0], ['stoense23', 19.5, 26.6, 0], ['morum', 26.0, 30.5, 0],
    ['besta180', 19.5, 20.9, 0], ['lack_tv', 25.0, 20.9, 0], ['besta120', 29.5, 20.9, 0],
    ['poang', 23.4, 24.6, -40], ['strandmon', 26.4, 24.6, 40],
    ['saltsjobaden-1', 22.0, 30.4, 160], ['dyvlinge-0', 28.6, 24.2, 200],
    ['vittsjo_nest', 24.0, 27.2, 0], ['gladom', 16.6, 24.0, 0], ['lack_side', 29.0, 30.0, 0],
    ['billy', 14.9, 21.6, 90], ['billy', 14.9, 24.3, 90], ['vittsjo_sh', 14.9, 30.4, 90],
    ['kallax-b-0', 31.0, 22.6, -90], ['kallax-d-0', 31.0, 31.0, -90],
    ['docksta', 27.6, 29.2, 0], ['tobias', 26.0, 29.2, 90], ['tobias', 29.2, 29.2, -90],
    ['odger', 27.6, 27.6, 0], ['lisabo_ch', 27.6, 30.8, 180],
    ['bergmund_bar', 21.0, 19.2, 0], ['skogsta_st', 22.6, 19.2, 0], ['franklin', 24.2, 19.2, 0],
    ['raskog-0', 31.4, 25.6, 0], ['markus', 17.4, 31.4, 30], ['lagkapten140', 18.6, 32.4, 0],
    ['lunix-2', 24.6, 32.6, 0], ['pg_hazel', 31.0, 28.6, 15],
    ['vidja', 16.4, 21.2, 0], ['ranarp_f', 25.4, 22.0, 0], ['hektar_f', 21.4, 31.6, 0],
    ['hw-02e-max', 29.8, 32.0, 0],
    ['dl-6', 17.5, 22.0, 0], ['dl-6', 21.5, 22.0, 0], ['dl-6', 25.5, 22.0, 0], ['dl-6', 29.5, 22.0, 0],
    ['dl-6', 17.5, 26.5, 0], ['dl-6', 21.5, 26.5, 0], ['dl-6', 25.5, 26.5, 0], ['dl-6', 29.5, 26.5, 0],
    ['dl-4', 19.5, 31.0, 0], ['dl-4', 23.5, 31.0, 0], ['dl-4', 27.5, 31.0, 0],
    ['cl-flush-l', 27.6, 29.2, 0], ['pendant', 21.0, 19.0, 0], ['vanity-3', 15.2, 26.0, 90],
  ],
}


def run(name, spp, maxpx, bounces, budget):
    src = open(f'{ROOT}/planner.html', encoding='utf-8').read()
    probe = (PROBE.replace('__LAYOUTS__', repr(LAYOUTS).replace("'", '"'))
                  .replace('__NAME__', '"%s"' % name)
                  .replace('__SPP__', str(spp))
                  .replace('__MAXPX__', str(maxpx))
                  .replace('__BOUNCES__', str(bounces)))
    page = f'{ROOT}/work/_{TAG}.html'
    out = (src.replace('</body>', probe + '\n</body>', 1)
              .replace("'work/clean_plan.jpg'", "'clean_plan.jpg'")
              .replace('lib/three.min.js', '../lib/three.min.js')
              .replace('lib/OrbitControls.js', '../lib/OrbitControls.js'))
    open(page, 'w', encoding='utf-8').write(out)
    subprocess.run(['pkill', '-f', TAG], capture_output=True)
    r = subprocess.run([CHROME, '--headless', '--use-angle=swiftshader',
                        '--allow-file-access-from-files', '--dump-dom',
                        f'--virtual-time-budget={budget}', '--window-size=1100,800',
                        'file://' + page], capture_output=True, text=True,
                       timeout=budget/1000 + 400)
    subprocess.run(['pkill', '-f', TAG], capture_output=True)
    m = re.search(r'<pre id="probe">(.*?)</pre>', r.stdout, re.S)
    os.unlink(page)
    return html.unescape(m.group(1)) if m else 'NO OUTPUT'


if __name__ == '__main__':
    which = sys.argv[1] if len(sys.argv) > 1 else None
    spp = int(sys.argv[2]) if len(sys.argv) > 2 else 8
    maxpx = int(sys.argv[3]) if len(sys.argv) > 3 else 120*90
    names = [which] if which else list(LAYOUTS)
    bad = 0
    for nm in names:
        print(f'\n{"="*56}\n{nm}\n{"="*56}')
        txt = run(nm, spp, maxpx, 5, 600000)
        print(txt)
        bad += sum(1 for l in txt.split('\n') if l.startswith(('FAIL', 'EXC')))
    print(f'\n总失败 {bad}')
    sys.exit(1 if bad else 0)
