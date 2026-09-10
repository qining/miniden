# -*- coding: utf-8 -*-
"""UI 第三步：量尺寸接线（图层 / 事件 / 按钮 / 样式）"""
import re

P = '/Users/dako/planner/planner.html'
s = open(P).read()

# ---------- 1. 图层变量 + 建图层 ----------
old = "let gFurn=null, gSel=null;"
new = "let gFurn=null, gSel=null, gMeas=null;"
assert old in s; s = s.replace(old, new, 1)

old = """  gSel = el('g',{id:'ctxDims'},root);
  gEdit = el('g',{id:'wedit'},root);"""
new = """  gSel = el('g',{id:'ctxDims'},root);
  gEdit = el('g',{id:'wedit'},root);
  gMeas = el('g',{id:'meas'},root);
  drawMeasure();"""
assert old in s; s = s.replace(old, new, 1)

old = """  if(IMGONLY){ gFurn = el('g',{id:'furn'},root); gSel = el('g',{id:'ctxDims'},root); return; }"""
new = """  if(IMGONLY){ gFurn = el('g',{id:'furn'},root); gSel = el('g',{id:'ctxDims'},root); gMeas = el('g',{id:'meas'},root); return; }"""
assert old in s; s = s.replace(old, new, 1)

# drawMeasure 里要有 k
old = """function drawMeasure(){
  if(!gMeas) return;
  gMeas.innerHTML = '';"""
new = """function drawMeasure(){
  if(!gMeas) return;
  gMeas.innerHTML = '';
  const k = Math.max(0.05, (svg.getScreenCTM()||{a:1}).a || 1);   // 标注按屏幕尺寸恒定"""
assert old in s; s = s.replace(old, new, 1)

# ---------- 2. 指针事件：量尺寸优先于选中/平移 ----------
old = """svg.addEventListener('pointerdown', ev=>{
  if(wallEdit.on){ wallEditDown(ev); return; }"""
new = """svg.addEventListener('pointerdown', ev=>{
  if(meas.on && ev.button===0){ measClick(svgPoint(ev), ev.shiftKey); ev.preventDefault(); return; }
  if(wallEdit.on){ wallEditDown(ev); return; }"""
assert old in s; s = s.replace(old, new, 1)

old = """svg.addEventListener('pointermove', ev=>{
  if(wallEdit.on && (!drag || drag.mode!=='pan')){ wallEditMove(ev); return; }"""
new = """svg.addEventListener('pointermove', ev=>{
  if(meas.on){ measMove(svgPoint(ev), ev.shiftKey); return; }
  if(wallEdit.on && (!drag || drag.mode!=='pan')){ wallEditMove(ev); return; }"""
assert old in s; s = s.replace(old, new, 1)

# 缩放/平移之后标注的屏幕尺寸要跟着重算
old = "svg.addEventListener('wheel', ev=>{"
new = """function refreshOverlays(){ if(meas.on || meas.list.length) drawMeasure(); }
svg.addEventListener('wheel', ev=>{"""
assert old in s; s = s.replace(old, new, 1)

# ---------- 3. 按钮 + 快捷键 ----------
BIND = """
/* 量尺寸 */
$('#btnMeas').onclick=()=>{ $('#btnMeas').blur(); meas.on ? measEnd() : measStart(); };
$('#btnMeasClr').onclick=()=>{ $('#btnMeasClr').blur(); measClear(); };
"""
anchor = "/* 墙体编辑 */"
assert anchor in s
s = s.replace(anchor, BIND + anchor, 1)

# Esc 退出
m = re.search(r"if\(e\.key==='Escape'\)\{", s)
assert m, "找不到 Esc 处理"
s = s[:m.start()] + "if(e.key==='Escape' && meas.on){ measEnd(); return; }\n  " + s[m.start():]

# ---------- 4. 样式 ----------
CSS = """  body.measuring #svg2d{cursor:crosshair;}
  body.measuring .furn{pointer-events:none;}
  #measSeg{display:none;}
"""
anchor = "  .wall{stroke:#0c0d0f; stroke-linecap:butt;}"
assert anchor in s
s = s.replace(anchor, CSS + anchor, 1)

open(P, 'w').write(s)
print("量尺寸接线完成")
