#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""带界面（headful）的真实 GPU 光追验证。

headless + swiftshader 测不到真东西：fenceSync 不 signal、虚拟时间冻结计时器、
也没有真正的 GPU 看门狗。要验证分块自适应和栅栏节流是否工作，只能开真窗口跑。

  python3 work/headful_test.py                 # 默认布局 B + 标准档
  python3 work/headful_test.py D_极限堆料 fine  # 指定布局和画质

做法：起一个本地 HTTP 服务器（headful 拿不到 --dump-dom），页面跑完把结果和
出图 POST 回来，服务器落盘，脚本再打印。
"""
import http.server, json, os, socketserver, subprocess, sys, threading, time, base64, re

ROOT = '/Users/dako/planner'
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
PORT = 8731
OUT = os.path.join(ROOT, 'work', 'ref')
RESULT = {}
DONE = threading.Event()

PROBE = r'''<script>
window.__E=[]; window.addEventListener('error',e=>window.__E.push(e.message+':'+e.lineno));
const report=(o)=>fetch('/report',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify(o)}).catch(()=>{});
window.addEventListener('load', ()=>{ setTimeout(async ()=>{
  const wait=ms=>new Promise(r=>setTimeout(r,ms||200));
  const L=[]; let img=null;
  try{
    try{ localStorage.removeItem('planner_v1'); }catch(e){}
    save=()=>{};
    const lay = __LAYOUT__;
    state.items = lay.map((p,i)=>({uid:2000+i, ref:p[0], x:p[1], y:p[2], rot:p[3]||0}));
    state.ptQ = '__QUAL__'; state.ptDN = true;
    refresh(); setView('fp'); await wait(4000);
    three.cam.position.set(23, EYE_H, 30); fpYaw=Math.PI; fpPitch=-0.06;
    if(typeof fpAim==='function') fpAim();
    await wait(600);

    const gl = three.renderer.getContext();
    L.push('GPU: ' + (()=>{ const d=gl.getExtension('WEBGL_debug_renderer_info');
      return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); })());
    L.push('fenceSync 可用: ' + !!gl.fenceSync);
    const sc = ptCollect();
    L.push('场景 '+sc.nTri.toLocaleString()+' 三角形 · '+ptLights().length+' 盏灯 · '
           +state.items.length+' 件家具');
    const Q = PT_QUALITY[state.ptQ];
    L.push('画质 '+state.ptQ+'：'+Q.spp+' spp · '+Q.bounces+' 弹射 · 上限 '+(Q.maxPx/1000)+'k 像素');

    const txts=[]; const el0=document.querySelector('#photoTxt');
    const mo=new MutationObserver(()=>{ const t=el0.textContent;
      if(t && txts[txts.length-1]!==t) txts.push(t); });
    mo.observe(el0,{childList:true,characterData:true,subtree:true});
    let maxGap=0, lastT=performance.now();
    const gapTimer=setInterval(()=>{ const n=performance.now();
      if(txts.length){ } maxGap=Math.max(maxGap, n-lastT); lastT=n; }, 100);

    const t0=performance.now();
    const res=await new Promise(r=>{
      ptRender(__SPP__, {onDone:(cv,spp)=>{ mo.disconnect(); clearInterval(gapTimer); r({cv,spp}); }});
      setTimeout(()=>{ mo.disconnect(); clearInterval(gapTimer); r(null); }, 900000);
    });
    const secs=(performance.now()-t0)/1000;
    if(!res){ L.push('FAIL 渲染没返回'); }
    else{
      const want=(__SPP__)||Q.spp;
      L.push((res.spp>=want?'PASS ':'FAIL ')+'完成采样 '+res.spp+'/'+want+' · 用时 '+secs.toFixed(1)+'s');
      const grid=txts.map(t=>{const m=t.match(/@(\d+)x\d+/); return m?+m[1]:null;}).filter(Boolean);
      const per =txts.map(t=>{const m=t.match(/([\d.]+)ms\/块/); return m?parseFloat(m[1]):null;}).filter(v=>v!==null);
      L.push('分块 '+(grid.length? ([...new Set(grid)].map(g=>g+'x'+g).join(' → ')) : '未变（保持 8x8）'));
      L.push('单块耗时 '+(per.length? (Math.min.apply(null,per).toFixed(1)+'~'+Math.max.apply(null,per).toFixed(1)+'ms · 末值 '+per[per.length-1].toFixed(1)+'ms') : '未报告'));
      if(per.length) L.push((Math.max.apply(null,per)<400?'PASS ':'FAIL ')
        +'单块峰值 '+Math.max.apply(null,per).toFixed(0)+'ms（看门狗阈值约 2000ms）');
      const waits=txts.filter(t=>/等待 GPU/.test(t)).length;
      L.push('栅栏节流生效 '+waits+' 次（CPU 等 GPU 画完再排下一批）');
      const pct=txts.map(t=>{const m=t.match(/([\d.]+)%/); return m?parseFloat(m[1]):null;}).filter(v=>v!==null);
      L.push((pct.length>=20?'PASS ':'FAIL ')+'进度更新 '+pct.length+' 次');
      L.push((pct.every((v,i)=>i===0||v>=pct[i-1]-0.01)?'PASS ':'FAIL ')+'进度单调');
      const lost=/重置/.test(document.querySelector('#photoOut').textContent||'');
      L.push((lost?'FAIL ':'PASS ')+'上下文'+(lost?'被重置':'全程未丢失'));
      if(res.cv){
        const g=res.cv.getContext('2d'), w=res.cv.width, h=res.cv.height;
        const d=g.getImageData(0,0,w,h).data;
        let sum=0,nz=0,spike=0;
        const Lm=(x,y)=>{const i=(y*w+x)*4; return d[i]*.299+d[i+1]*.587+d[i+2]*.114;};
        for(let i=0;i<d.length;i+=4){const v=d[i]*.299+d[i+1]*.587+d[i+2]*.114; sum+=v; if(v>6)nz++;}
        for(let y=1;y<h-1;y++) for(let x=1;x<w-1;x++){const c=Lm(x,y); if(c<200)continue;
          const nb=(Lm(x-1,y)+Lm(x+1,y)+Lm(x,y-1)+Lm(x,y+1))/4; if(c-nb>110) spike++;}
        const n=d.length/4;
        L.push((sum/n>6&&nz/n>0.5?'PASS ':'FAIL ')+'出图 '+w+'x'+h+' 均值'+(sum/n).toFixed(1));
        L.push((spike/n<0.002?'PASS ':'FAIL ')+'孤立亮点 '+((spike/n)*100).toFixed(3)+'%（满采样后应该很低）');
        img=res.cv.toDataURL('image/png');
      }
    }
  }catch(e){ L.push('EXC '+e.message+' | '+(e.stack||'').split(String.fromCharCode(10))[1]); }
  L.push('ERR='+JSON.stringify(window.__E.slice(0,4)));
  await report({lines:L, img});
}, 1200); });
</script>'''


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, *a):
        pass

    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0))
        try:
            RESULT.update(json.loads(self.rfile.read(n).decode()))
        except Exception as e:
            RESULT['lines'] = ['解析失败: ' + str(e)]
        self.send_response(200); self.end_headers(); self.wfile.write(b'ok')
        DONE.set()


def main():
    name = sys.argv[1] if len(sys.argv) > 1 else 'B_满配客厅'
    qual = sys.argv[2] if len(sys.argv) > 2 else 'normal'
    # 第三个参数可以只截断采样数，保留该档的弹射次数和分辨率——
    # 验证「单块会不会踩看门狗」不需要等它收敛完
    spp_arg = sys.argv[3] if len(sys.argv) > 3 else 'undefined'
    lay = json.load(open(f'{ROOT}/work/layouts/{name}.json', encoding='utf-8'))['items']
    layarr = [[i['ref'], i['x'], i['y'], i.get('rot', 0)] for i in lay]

    src = open(f'{ROOT}/planner.html', encoding='utf-8').read()
    page = os.path.join(ROOT, 'work', '_headful.html')
    open(page, 'w', encoding='utf-8').write(
        src.replace('</body>',
                    PROBE.replace('__LAYOUT__', json.dumps(layarr))
                         .replace('__QUAL__', qual)
                         .replace('__SPP__', spp_arg) + '\n</body>', 1)
           .replace("'work/clean_plan.jpg'", "'clean_plan.jpg'")
           .replace('lib/three.min.js', '../lib/three.min.js')
           .replace('lib/OrbitControls.js', '../lib/OrbitControls.js'))

    socketserver.TCPServer.allow_reuse_address = True
    srv = socketserver.TCPServer(('127.0.0.1', PORT), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    print(f'布局 {name} · 画质 {qual}' + ('' if spp_arg=='undefined' else f' · 采样截断到 {spp_arg}'))
    print('开真窗口跑（会弹出一个 Chrome 窗口，跑完自动关）…')
    proc = subprocess.Popen(
        [CHROME, '--new-window', '--window-size=1400,900',
         '--user-data-dir=/tmp/_headful_pt', '--no-first-run', '--no-default-browser-check',
         f'http://127.0.0.1:{PORT}/work/_headful.html'],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    ok = DONE.wait(timeout=1500)
    time.sleep(0.5)
    proc.terminate()
    subprocess.run(['pkill', '-f', '_headful_pt'], capture_output=True)
    srv.shutdown()
    try:
        os.unlink(page)
    except OSError:
        pass

    if not ok:
        print('✗ 超时，页面没回报'); sys.exit(1)
    for l in RESULT.get('lines', []):
        print('  ' + l)
    if RESULT.get('img'):
        os.makedirs(OUT, exist_ok=True)
        fn = os.path.join(OUT, f'headful_{name}_{qual}.png')
        open(fn, 'wb').write(base64.b64decode(RESULT['img'].split(',', 1)[1]))
        print(f'\n出图 → {fn}')
    bad = sum(1 for l in RESULT.get('lines', []) if l.startswith(('FAIL', 'EXC')))
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
