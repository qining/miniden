#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""新入库条目的单件体检 + 全量回归。

  python3 check-item.py <条目id>     # 单件：包围盒/填充率/重心/贴地/材质/缩略图 + 隔离渲染出图
  python3 check-item.py --regress    # 全量：三个测试台 + #calib 指纹

单件体检对应 SKILL.md 的验证关 2/3，全量对应关 4。
"""
import os, re, subprocess, sys, tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
PLANNER = os.path.join(ROOT, 'planner.html')
WORK = os.path.join(ROOT, 'work')
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
CALIB_BASELINE = '1ac26921871db50ef1c055674c10e6e7'


def die(msg):
    print('✗ ' + msg)
    sys.exit(1)


def syntax_check():
    src = open(PLANNER, encoding='utf-8').read()
    m = re.search(r'<script>\n(.*?)</script>', src, re.S)
    if not m:
        die('planner.html 里找不到主 script 块')
    with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False, encoding='utf-8') as f:
        f.write(m.group(1))
        path = f.name
    r = subprocess.run(['node', '--check', path], capture_output=True, text=True)
    os.unlink(path)
    if r.returncode:
        die('JS 语法错误:\n' + r.stderr)
    print('✓ 语法')
    return src


def make_page(src, body):
    """把探针脚本注进 planner.html 的副本，修好相对路径。"""
    out = src.replace('</body>', body + '\n</body>', 1)
    return (out.replace("'work/clean_plan.jpg'", "'clean_plan.jpg'")
               .replace('lib/three.min.js', '../lib/three.min.js')
               .replace('lib/OrbitControls.js', '../lib/OrbitControls.js'))


# 隔离标记：所有临时页面名字里带本进程 pid，收尾只杀命令行里含这个标记的 Chrome。
# 不能用 `pkill -f headless`——并行跑多个 agent 时会把别人的 Chrome 一起杀掉。
# 也不要用 --user-data-dir 做隔离：每次新建 profile 会让 Chrome 启动慢到超时。
TAG = f'_cci{os.getpid()}'


def kill_mine():
    subprocess.run(['pkill', '-f', TAG], capture_output=True)


def run_chrome(page_path, budget, size, extra=None):
    cmd = [CHROME, '--headless', '--use-angle=swiftshader', '--allow-file-access-from-files',
           '--dump-dom', f'--virtual-time-budget={budget}', f'--window-size={size}']
    if extra:
        cmd += extra
    cmd.append('file://' + page_path)
    kill_mine()
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=budget / 1000 + 180)
    kill_mine()
    m = re.search(r'<pre id="probe">(.*?)</pre>', r.stdout, re.S)
    if not m:
        die('探针页没有输出（多半是脚本抛错或超时）')
    import html
    return html.unescape(m.group(1))


PROBE = r'''<script>
window.__E=[]; window.addEventListener('error',e=>window.__E.push(e.message+':'+e.lineno));
const _cw=console.warn; console.warn=function(){ window.__E.push('warn:'+[].slice.call(arguments).join(' ').slice(0,160)); _cw.apply(console,arguments); };
window.addEventListener('load', ()=>{ setTimeout(async ()=>{
  const L=[], wait=ms=>new Promise(r=>setTimeout(r,ms||200));
  const ID='__ITEM__';
  try{
    const sp=CATALOG.find(c=>c.id===ID) || state.customCat.find(c=>c.id===ID);
    if(!sp){ L.push('FAIL 目录里没有 id='+ID); throw new Error('no such item'); }
    L.push('条目 '+sp.name);
    L.push('声明 '+sp.w+'×'+sp.d+'×'+sp.h+'cm · kind='+sp.kind+' · model='+(sp.model||'(通用)'));
    // --- 建模 ---
    const g=furn3D({uid:-1, ref:sp.id, x:0, y:0, rot:0}, sp);
    g.updateMatrixWorld(true);
    const b=new THREE.Box3().setFromObject(g);
    const sz=new THREE.Vector3(), ct=new THREE.Vector3(); b.getSize(sz); b.getCenter(ct);
    const fx=sz.x/cm2ft(sp.w), fz=sz.z/cm2ft(sp.d), fy=sz.y/cm2ft(sp.h);
    const P=(n,ok,x)=>L.push((ok?'PASS ':'FAIL ')+n+(x!==undefined?' | '+x:''));
    P('填充率 92~102%', fx>=.92&&fx<=1.02&&fz>=.92&&fz<=1.02&&fy>=.92&&fy<=1.02,
      [fx,fz,fy].map(v=>(v*100).toFixed(0)+'%').join(' / '));
    P('水平重心归零', Math.abs(ct.x)<0.03&&Math.abs(ct.z)<0.03,
      '('+ct.x.toFixed(2)+', '+ct.z.toFixed(2)+')');
    P('所有部件贴地', b.min.y>-0.02, 'min.y='+b.min.y.toFixed(3));
    // --- 材质 ---
    let mesh=0, noMap=0, noNrm=0, tri=0, skip=0; const mats=new Set();
    // 豁免规则要和 ensureTextured() 一致：玻璃、自发光面、显式 noTex 不要求贴图
    const exempt=m=>!m || m.isMeshBasicMaterial
      || (m.transparent && m.opacity!=null && m.opacity<0.8)
      || (m.emissiveIntensity!=null && m.emissiveIntensity>=1.5)
      || (m.userData && m.userData.noTex);
    g.traverse(o=>{ if(!o.isMesh||!o.material) return;
      const m=Array.isArray(o.material)?o.material[0]:o.material;
      mesh++; mats.add(m.uuid);
      if(o.geometry&&o.geometry.attributes.position) tri+=o.geometry.attributes.position.count/3;
      if(exempt(m)){ skip++; return; }
      if(!m.map) noMap++;
      if(!m.normalMap && !(m.userData&&m.userData.noNrm)) noNrm++; });
    const need=mesh-skip;
    P('材质都有贴图', noMap===0,
      noMap? noMap+'/'+need+' 个网格没有 map' : need+' 个网格全有'+(skip? '（'+skip+' 个豁免：玻璃/自发光）':''));
    P('材质都有法线贴图', noNrm===0, noNrm? noNrm+'/'+need+' 个没有 normalMap' : 'ok');
    P('三角形数 500~40000', tri>=500&&tri<=40000, Math.round(tri)+' 面 · '+mats.size+' 种材质');
    if(tri<2000) L.push('  注意：面数偏低，检查是不是「几个方块拼一下」');
    // --- 最高/最低的部件（排查沉底用）---
    const rows=[];
    g.children.forEach((ch,i)=>{ ch.updateMatrixWorld(true);
      const bb=new THREE.Box3().setFromObject(ch);
      if(!bb.isEmpty()) rows.push([i, bb.min.y, bb.max.y]); });
    rows.sort((a,b)=>a[1]-b[1]);
    L.push('最低的三个部件 y: '+rows.slice(0,3).map(r=>'#'+r[0]+'@'+r[1].toFixed(2)).join('  '));
    disposeOwned(g);
    // --- 缩略图 ---
    const url=furnThumb(sp);
    if(!url){ P('缩略图', false, '渲染失败'); }
    else{
      const im=await new Promise(r=>{ const i=new Image(); i.onload=()=>r(i); i.onerror=()=>r(null); i.src=url; });
      const c=document.createElement('canvas'); c.width=im.width; c.height=im.height;
      const gg=c.getContext('2d'); gg.drawImage(im,0,0);
      const d=gg.getImageData(0,0,c.width,c.height).data;
      let n=0,x0=1e9,x1=-1,y0=1e9,y1=-1,r2=0,g2=0,b2=0;
      for(let y=0;y<c.height;y++) for(let x=0;x<c.width;x++){
        const i2=(y*c.width+x)*4;
        if(d[i2+3]>16){ n++; r2+=d[i2]; g2+=d[i2+1]; b2+=d[i2+2];
          if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y; } }
      const span=Math.max((x1-x0+1)/c.width, (y1-y0+1)/c.height);
      P('缩略图取景贴合(>70%)', span>0.70, (span*100).toFixed(0)+'%');
      P('缩略图不过曝', Math.max(r2,g2,b2)/Math.max(n,1)<246,
        '平均色 rgb('+[r2/n,g2/n,b2/n].map(v=>v.toFixed(0))+') · 目录色 '+sp.color);
    }
    // --- 价格 ---
    if(isBuiltIn(sp)) L.push('价格：公寓自带，不计价');
    else{
      P('有价格', !!priceOf(sp,'usd')||!!priceOf(sp,'cad'),
        'US '+(fmtPrice(sp,'usd')||'—')+' / CA '+(fmtPrice(sp,'cad')||'—'));
      if(sp.price!=null && sp.priceCA==null && !sp.caNA)
        L.push('  注意：没有加拿大实际标价，加元视图会按汇率折算并标 ≈');
    }
    // --- 隔离渲染出图 ---
    state.items=[]; save=()=>{};
    state.items.push({uid:uidSeq++, ref:sp.id, x:18, y:26, rot:0});
    refresh(); setView('doll'); await wait(3400);
    three.staticGroup.visible=false;
    three.scene.background=new THREE.Color(0x1b1f26); three.scene.fog=null;
    const g0=three.furnMap.values().next().value.g; g0.updateMatrixWorld(true);
    const bb2=new THREE.Box3().setFromObject(g0);
    const s2=new THREE.Vector3(), c2=new THREE.Vector3(); bb2.getSize(s2); bb2.getCenter(c2);
    const dir=new THREE.Vector3(0.5,0.42,1).normalize();
    let dist=s2.length()*0.5/Math.tan(34*Math.PI/360)*1.05;
    const cs=[]; for(let i=0;i<8;i++) cs.push(new THREE.Vector3(
      (i&1)?bb2.max.x:bb2.min.x,(i&2)?bb2.max.y:bb2.min.y,(i&4)?bb2.max.z:bb2.min.z));
    three.cam.fov=34;
    for(let k=0;k<4;k++){
      three.cam.position.copy(c2).addScaledVector(dir,dist); three.cam.lookAt(c2);
      three.cam.updateMatrixWorld(true);
      three.cam.matrixWorldInverse.copy(three.cam.matrixWorld).invert();
      three.cam.updateProjectionMatrix();
      let mx=0; for(const q of cs){ const p2=q.clone().project(three.cam);
        mx=Math.max(mx,Math.abs(p2.x),Math.abs(p2.y)); }
      dist*=mx/0.86;
    }
    three.cam.position.copy(c2).addScaledVector(dir,dist); three.cam.lookAt(c2);
    // OrbitControls.update() 每帧会把手摆的相机拉回去，必须同步 target
    three.controls.target.copy(c2); three.controls.enabled=true; three.controls.update();
    three.cam.updateProjectionMatrix(); requestRender();
    await wait(600);
    const cr=three.canvas.getBoundingClientRect();     // 供外面裁掉侧栏，只留画布
    L.push('CANVAS '+[cr.left,cr.top,cr.width,cr.height].map(v=>Math.round(v)).join(' '));
  }catch(e){ L.push('EXC '+e.message+' | '+(e.stack||'').split(String.fromCharCode(10))[1]); }
  L.push('ERR='+JSON.stringify(window.__E.slice(0,4)));
  const p=document.createElement('pre'); p.id='probe'; p.textContent=L.join(String.fromCharCode(10));
  document.body.appendChild(p);
}, 900); });
</script>'''


def check_one(item_id):
    src = syntax_check()
    page = os.path.join(WORK, f'_check_item_{TAG}.html')
    open(page, 'w', encoding='utf-8').write(make_page(src, PROBE.replace('__ITEM__', item_id)))
    shot = os.path.join(WORK, 'ref', f'check_{item_id}.png')
    os.makedirs(os.path.dirname(shot), exist_ok=True)
    out = run_chrome(page, 60000, '1500,1000', ['--screenshot=' + shot])
    print(re.sub(r'^CANVAS .*$', '', out, flags=re.M).rstrip())
    if os.path.exists(shot):
        m = re.search(r'CANVAS (\d+) (\d+) (\d+) (\d+)', out)
        if m:                                    # 裁掉侧栏，只留 3D 画布
            x, y, w, h = (int(v) for v in m.groups())
            subprocess.run(['sips', '-c', str(h), str(w), '--cropOffset', str(y), str(x),
                            shot, '--out', shot], capture_output=True)
        subprocess.run(['sips', '-Z', '900', shot, '--out', shot], capture_output=True)
        print(f'\n渲染图 → {shot}')
        print('用 Read 工具打开它，对照 work/ref/ 里的实拍图逐项比：')
        print('  部件数量 → 形状 → 相对位置朝向 → 比例 → 颜色 → 材质 → 特征细节')
    os.unlink(page)
    if 'FAIL' in out or 'EXC' in out:
        sys.exit(1)


HARNESS = [('t_walledit.html', 80000, '1700,1100', 'wetest'),
           ('t_3d.html', 170000, '1400,950', 't3d'),
           ('t_pt.html', 300000, '1200,850', 'tpt')]


def regress():
    src = syntax_check()
    # 三个测试台都要按最新 planner.html 重新生成
    for name, _, _, _ in HARNESS:
        f = os.path.join(WORK, name)
        mark = {'t_walledit.html': r'window\.__ERRS', 't_3d.html': r'window\.__E3',
                't_pt.html': r'window\.__EPT'}[name]
        m = re.search(r'(\n<script>\n' + mark + r'.*?</script>\n</body>)',
                      open(f, encoding='utf-8').read(), re.S)
        if not m:
            die(f'{name} 里找不到测试脚本')
        open(f, 'w', encoding='utf-8').write(make_page(src, m.group(1)).replace('\n</body>\n</body>', '\n</body>'))
    print('✓ 测试台已重新生成')

    bad = 0
    for name, budget, size, pid in HARNESS:
        kill_mine()
        r = subprocess.run([CHROME, '--headless', '--use-angle=swiftshader',
                            '--allow-file-access-from-files', '--dump-dom',
                            f'--virtual-time-budget={budget}', f'--window-size={size}',
                            'file://' + os.path.join(WORK, name)],
                           capture_output=True, text=True, timeout=budget / 1000 + 240)
        kill_mine()
        m = re.search(r'<pre id="' + pid + r'">(.*?)</pre>', r.stdout, re.S)
        if not m:
            print(f'✗ {name}: 无输出'); bad += 1; continue
        import html
        lines = html.unescape(m.group(1)).split('\n')
        fails = [l for l in lines if l.startswith(('FAIL', 'EXC'))]
        total = len([l for l in lines if l.startswith(('PASS', 'FAIL'))])
        print(('✓ ' if not fails else '✗ ') + f'{name}: {total} 条，失败 {len(fails)}')
        for l in fails:
            print('    ' + l)
        bad += len(fails)

    # #calib 指纹
    kill_mine()
    ck, ckc = f'/tmp/{TAG}_ck.png', f'/tmp/{TAG}_ckc.png'
    subprocess.run([CHROME, '--headless', '--disable-gpu',
                    f'--screenshot={ck}', '--window-size=2400,1500',
                    '--virtual-time-budget=9000',
                    'file://' + PLANNER + '#calib'], capture_output=True, timeout=200)
    kill_mine()
    subprocess.run(['sips', '-c', '1360', '1674', '--cropOffset', '72', '369',
                    ck, '--out', ckc], capture_output=True)
    md5 = subprocess.run(['md5', '-q', ckc], capture_output=True, text=True).stdout.strip()
    ok = md5 == CALIB_BASELINE
    print(('✓ ' if ok else '✗ ') + f'#calib md5 {md5}' + ('' if ok else f'（基线 {CALIB_BASELINE}）'))
    if not ok:
        print('    校准变了。加家具不该动到它——检查是不是改了 LABELS/FIXED，'
              '或者改了侧栏宽度（见 AGENTS.md §5.4.6）')
        bad += 1
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(2)
    if sys.argv[1] == '--regress':
        regress()
    else:
        check_one(sys.argv[1])
