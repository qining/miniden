# -*- coding: utf-8 -*-
"""UI 第四步：左右面板可折叠/可拖宽 + 目录改成大图卡片"""
import re

P = '/Users/dako/planner/planner.html'
s = open(P).read()

# ---------- 1. 布局 CSS ----------
old = """  #main{flex:1; display:flex; min-height:0;}
  #catalog{
    width:270px; background:var(--panel); border-right:1px solid var(--line);
    display:flex; flex-direction:column; min-height:0;
  }"""
new = """  #main{flex:1; display:flex; min-height:0; position:relative;}
  #catalog{
    width:400px; min-width:240px; max-width:70vw;
    background:var(--panel); border-right:1px solid var(--line);
    display:flex; flex-direction:column; min-height:0; position:relative;
  }
  #catalog.collapsed, #props.collapsed{display:none;}
  /* 拖动改宽度的分隔条 */
  .splitter{width:6px; flex:none; cursor:col-resize; background:transparent; position:relative;}
  .splitter::after{content:''; position:absolute; left:2px; top:0; bottom:0; width:2px;
    background:var(--line); transition:background .12s;}
  .splitter:hover::after, .splitter.dragging::after{background:var(--accent);}
  /* 面板折叠后留一个竖条可以点开 */
  .panelTab{width:22px; flex:none; background:var(--panel); border-right:1px solid var(--line);
    display:none; align-items:center; justify-content:center; cursor:pointer; user-select:none;
    color:var(--muted); font-size:11px; writing-mode:vertical-rl; letter-spacing:2px; padding:8px 0;}
  .panelTab:hover{color:var(--fg); background:#20242b;}
  .panelTab.show{display:flex;}
  #propsTab{border-right:none; border-left:1px solid var(--line);}
  .panelHead{display:flex; align-items:center; gap:8px; padding:8px 10px 0 10px;}
  .panelHead .ttl{font-size:12px; color:var(--muted); font-weight:600; flex:1;}
  .panelHead .xbtn{background:#20242b; border:1px solid var(--line); color:var(--muted);
    border-radius:5px; padding:2px 7px; font-size:11px; cursor:pointer;}
  .panelHead .xbtn:hover{color:var(--fg); border-color:var(--accent);}"""
assert old in s; s = s.replace(old, new, 1)

# ---------- 2. 目录卡片样式 ----------
old2 = re.search(r"  #catList\{[^\n]*\n(?:.*?\n)*?  \.catItem \.price\{[^\n]*\n(?:.*?\n)*?  \.catItem \.price\.builtin\{[^\n]*\n", s)
# 直接替换已知的几条
CSS_OLD = """  #catList{flex:1; overflow-y:auto; padding-bottom:20px;}"""
CSS_NEW = """  #catList{flex:1; overflow-y:auto; padding-bottom:20px;}
  /* 卡片网格：挑家具靠的是看图，列表里塞小图根本挑不动 */
  .catGrid{display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr));
    gap:8px; padding:8px 10px 12px 10px;}
  .catCard{background:#1b1f26; border:1px solid var(--line); border-radius:8px;
    overflow:hidden; cursor:pointer; display:flex; flex-direction:column;
    transition:border-color .12s, transform .08s, background .12s;}
  .catCard:hover{border-color:var(--accent); background:#20252e; transform:translateY(-1px);}
  .catCard .ph{width:100%; aspect-ratio:4/3; background:#12151a center/contain no-repeat;
    border-bottom:1px solid var(--line);}
  .catCard .meta{padding:6px 8px 8px;}
  .catCard .nm2{font-size:12px; line-height:1.3; color:var(--fg);
    display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;}
  .catCard .sub{font-size:10.5px; color:var(--muted); margin-top:3px;
    display:flex; justify-content:space-between; gap:6px;}
  .catCard .sub b{color:var(--accent2); font-weight:600; white-space:nowrap;}
  .catCard .sub .builtin{color:var(--muted); font-weight:400;}"""
assert CSS_OLD in s; s = s.replace(CSS_OLD, CSS_NEW, 1)

# ---------- 3. HTML：分隔条 + 折叠条 + 面板头 ----------
old = """<div id="main">
  <div id="catalog">
    <div class="search"><input id="catSearch" type="text" placeholder="搜索家具（如 poang→POÄNG / 沙发）"></div>"""
new = """<div id="main">
  <div class="panelTab" id="catTab" title="展开家具目录">家具目录 ▸</div>
  <div id="catalog">
    <div class="panelHead"><span class="ttl">家具目录</span>
      <button class="xbtn" id="catCollapse" title="收起面板">收起 ◂</button></div>
    <div class="search"><input id="catSearch" type="text" placeholder="搜索家具（如 poang→POÄNG / 沙发）"></div>"""
assert old in s; s = s.replace(old, new, 1)

old = """  <div id="stage">"""
new = """  <div class="splitter" id="splitL"></div>
  <div id="stage">"""
assert old in s; s = s.replace(old, new, 1)

old = """  <div id="props">
    <h3 id="pTitle">未选中家具</h3>"""
new = """  <div class="splitter" id="splitR"></div>
  <div id="props">
    <div class="panelHead"><span class="ttl">属性 / 清单</span>
      <button class="xbtn" id="propsCollapse" title="收起面板">收起 ▸</button></div>
    <h3 id="pTitle">未选中家具</h3>"""
assert old in s; s = s.replace(old, new, 1)

# props 后面加折叠条
m = re.search(r"(<div id=\"placedList\">[\s\S]*?\n  </div>\n)</div>\n</div>\n", s)
assert m, "props 收尾没找到"
s = s[:m.end(1)] + "  </div>\n  <div class=\"panelTab\" id=\"propsTab\" title=\"展开属性面板\">◂ 属性 / 清单</div>\n</div>\n" + s[m.end(0):]

# ---------- 4. buildCatalog 改成卡片 ----------
old = """    const items = document.createElement('div'); items.className='items';
    for(const c of cats[cat]){
      const row = document.createElement('div'); row.className='catItem';
      row.innerHTML = `<div class="sw" data-thumb="${c.id}" style="background:${c.color}"></div>
        <div class="nm">${c.name}<small>${c.w}×${c.d}×${c.h}cm${c.note? ' · '+c.note:''}</small></div>
        <div class="price${isBuiltIn(c)?' builtin':''}">${fmtPrice(c)}</div>`;
      row.onclick=()=>addItem(c.id);
      items.appendChild(row);
    }"""
new = """    const items = document.createElement('div'); items.className='catGrid';
    for(const c of cats[cat]){
      const card = document.createElement('div'); card.className='catCard';
      const p = fmtPrice(c);
      card.innerHTML = `<div class="ph" data-thumb="${c.id}" style="background-color:${c.color}"></div>
        <div class="meta">
          <div class="nm2" title="${c.name.replace(/"/g,'&quot;')}${c.note? ' — '+c.note.replace(/"/g,'&quot;'):''}">${c.name}</div>
          <div class="sub"><span>${fmtLen(cm2ft(c.w))}×${fmtLen(cm2ft(c.d))}</span>${p?`<b class="${isBuiltIn(c)?'builtin':''}">${p}</b>`:''}</div>
        </div>`;
      card.onclick=()=>addItem(c.id);
      items.appendChild(card);
    }"""
assert old in s; s = s.replace(old, new, 1)

# 缩略图选择器：.sw → .ph
s = s.replace(".sw[data-thumb]", ".ph[data-thumb]")

# ---------- 5. 缩略图尺寸放大 ----------
old = "const THUMB_W = 132, THUMB_H = 108;"
new = "const THUMB_W = 320, THUMB_H = 240;      // 卡片按 4:3 显示，渲得大一点才看得清"
assert old in s; s = s.replace(old, new, 1)
s = s.replace("const cam = new THREE.PerspectiveCamera(28, THUMB_W/THUMB_H, 0.02, 400);",
              "const cam = new THREE.PerspectiveCamera(26, THUMB_W/THUMB_H, 0.02, 400);", 1)
s = s.replace("Math.tan(28*Math.PI/360)", "Math.tan(26*Math.PI/360)")

# 兜底色块也改成 .ph 的用法
old = """function _thumbFallback(el, spec){ el.style.backgroundImage=''; el.style.background = spec.color || '#7d848e'; }
function _thumbApply(el, spec, url){
  if(url){ el.style.backgroundImage = 'url('+url+')'; el.style.backgroundColor = 'transparent'; el.classList.add('has'); }
  else _thumbFallback(el, spec);
}"""
new = """function _thumbFallback(el, spec){ el.style.backgroundImage=''; el.style.backgroundColor = spec.color || '#7d848e'; }
function _thumbApply(el, spec, url){
  if(url){ el.style.backgroundImage = 'url('+url+')'; el.style.backgroundColor = '#12151a'; el.classList.add('has'); }
  else _thumbFallback(el, spec);
}"""
assert old in s; s = s.replace(old, new, 1)

open(P, 'w').write(s)
print("面板折叠/拖宽 + 目录卡片化 已注入")
