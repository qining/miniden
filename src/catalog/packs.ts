/* =====================================================================
   src/catalog/packs.ts — 目录扩展包（S10 ④ / R8-5K-1）

   包 = 一个 JSON 文件，装「目录条目」与（可选）「模型代码」：

     {
       "pack": "acme-2026",            // 全局命名空间 id（必填）
       "name": "Acme 沙发系列",         // 显示名（可选，默认 = pack id）
       "version": 1,
       "homepage": "https://…",        // 可选
       "note": "…",                    // 可选
       "entries": [ {目录条目…}, … ],   // 必填，1..MAX_PACK_ENTRIES
       "models": { "acme-sofa": "(C)=>{ … }" }   // 可选：模型源码（函数表达式字符串）
     }

   模型解析链（R8-5K-2）：**内置 MODELS → 扩展包 models → kind 通用回退**。
   内置永远优先：包不能把内置商品换成别的东西（同名 model 被忽略并报告）。

   条目 id 冲突（R8-5K-2 的命名空间要求）：**内置赢**，包里同 id 的条目被跳过并逐条报告。
   为什么不是「包赢」也不是「整包拒收」：内置目录是 app 数据、也是用户已经摆好的家具的参照；
   一个包不该能顶掉它。而「整包拒收」会让一个条目写错毁掉其余 200 条。

   信任模型（必须如实告诉用户）：`models` 里的代码在用户本机执行（`new Function`）。
   这个应用没有账号、没有凭据、数据不出本机，包文件由用户自己选；
   但「本地执行任意 JS」这件事本身必须在导入确认里写清楚，不能默默做。

   纯度：不 import three / document（R7）。`new Function` 在 node 与浏览器都可用，可单测。
   ===================================================================== */

import { duplicateIds, validateEntry, type CatalogEntry, type CatalogIssue } from './schema';

export const PACK_SCHEMA = 1;
export const PACKS_KEY = 'planner_packs_v1';
export const packKeyFor = (id: string): string => 'planner_pack:' + id;

export const MAX_PACK_ENTRIES = 2000;
export const MAX_PACK_MODELS = 500;
export const MAX_MODEL_SRC = 60000; // 单个模型源码字符上限
export const MAX_PACK_MODELS_BYTES = 400000; // 整包模型源码上限
export const MAX_PACKS = 32; // 同时加载的包数量上限

const PACK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MODEL_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface PackMeta {
  pack: string;
  name: string;
  version: number;
  entries: number;
  models: number;
  addedAt: number;
}

export interface PackRegistry {
  v: number;
  packs: PackMeta[];
}

export interface ParsedPack {
  pack: string;
  name: string;
  version: number;
  homepage?: string;
  note?: string;
  entries: CatalogEntry[];
  models: Record<string, string>;
}

export interface PackCheck {
  pack?: ParsedPack;
  /** 包层问题（包 id / 上限 / 模型源码…）：有 error 就整包不加载 */
  issues: CatalogIssue[];
  /** 条目层问题：逐条拒收，不连坐整包（一个条目写错不该毁掉其余 200 条） */
  entryIssues: CatalogIssue[];
  ok: boolean;
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 解析并校验一个目录包。entries 全部逐条过 schema；坏条目逐条拒收（不连坐）。 */
export function validatePack(raw: unknown): PackCheck {
  const issues: CatalogIssue[] = [];
  const entryIssues: CatalogIssue[] = [];
  const bad = (field: string, message: string) => issues.push({ level: 'error', where: '?', field, message });

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    bad('', '目录包必须是一个 JSON 对象');
    return { issues, entryIssues, ok: false };
  }
  const p = raw as Record<string, unknown>;
  const where = isStr(p.pack) && p.pack ? p.pack : '?';
  const push = (level: 'error' | 'warning', field: string, message: string) =>
    issues.push({ level, where, field, message });

  if (!isStr(p.pack) || !p.pack) bad('pack', '缺少包 id（pack）');
  else if (!PACK_ID_RE.test(p.pack)) bad('pack', `包 id 只能用字母/数字/._-，且不超过 64 字符（当前 "${p.pack}"）`);
  else if (p.pack === 'builtin') bad('pack', '包 id 不能叫 "builtin"（那是内置目录的命名空间）');

  let version = 1;
  if (p.version !== undefined) {
    if (!isNum(p.version) || !Number.isInteger(p.version) || p.version < 1) bad('version', 'version 必须是 ≥1 的整数');
    else version = p.version;
  }

  let name = isStr(p.pack) ? p.pack : '未命名目录包';
  if (p.name !== undefined) {
    if (!isStr(p.name) || !p.name.trim() || p.name.length > 80) bad('name', 'name 必须是 1–80 字符的文本');
    else name = p.name.trim();
  }

  if (!Array.isArray(p.entries)) bad('entries', '缺少 entries（条目数组）');
  else if (p.entries.length === 0) bad('entries', 'entries 是空的：这个包没有任何条目');
  else if (p.entries.length > MAX_PACK_ENTRIES)
    bad('entries', `entries 超过 ${MAX_PACK_ENTRIES} 条上限（当前 ${p.entries.length}）`);

  const models: Record<string, string> = {};
  if (p.models !== undefined) {
    if (!p.models || typeof p.models !== 'object' || Array.isArray(p.models))
      bad('models', 'models 必须是 {名字: 函数源码字符串} 对象');
    else {
      const keys = Object.keys(p.models);
      if (keys.length > MAX_PACK_MODELS) bad('models', `models 超过 ${MAX_PACK_MODELS} 个上限（当前 ${keys.length}）`);
      let total = 0;
      for (const k of keys) {
        const src = (p.models as Record<string, unknown>)[k];
        if (!MODEL_KEY_RE.test(k)) {
          push('error', `models.${k}`, '模型名只能用字母/数字/._-，且不超过 64 字符');
          continue;
        }
        if (!isStr(src)) {
          push('error', `models.${k}`, '模型必须是函数源码字符串（如 "(C)=>{ … }"）');
          continue;
        }
        if (src.length > MAX_MODEL_SRC) {
          push('error', `models.${k}`, `单个模型源码超过 ${MAX_MODEL_SRC} 字符`);
          continue;
        }
        total += src.length;
        models[k] = src;
      }
      if (total > MAX_PACK_MODELS_BYTES)
        bad('models', `整包模型源码超过 ${MAX_PACK_MODELS_BYTES} 字符上限（当前 ${total}）`);
    }
  }

  for (const k of Object.keys(p)) {
    if (
      k !== 'pack' &&
      k !== 'name' &&
      k !== 'version' &&
      k !== 'entries' &&
      k !== 'models' &&
      k !== 'homepage' &&
      k !== 'note'
    )
      push('warning', k, `未知字段 "${k}"（会被忽略）`);
  }
  if (p.homepage !== undefined && (!isStr(p.homepage) || !/^https?:\/\//.test(p.homepage) || p.homepage.length > 300))
    push('error', 'homepage', 'homepage 必须是 http(s) 链接（≤300 字符）');
  if (p.note !== undefined && (!isStr(p.note) || p.note.length > 600))
    push('error', 'note', 'note 必须是 ≤600 字符的文本');

  const entries: CatalogEntry[] = [];
  if (Array.isArray(p.entries)) {
    for (const raw2 of p.entries) {
      const r = validateEntry(raw2);
      /* 条目层问题另表记账：包层没有 error 时，坏条目逐条拒收、其余照常用 */
      entryIssues.push(...r.issues);
      if (r.ok && r.entry) entries.push({ ...r.entry, sourcePack: where });
    }
    for (const id of duplicateIds(entries))
      issues.push({ level: 'error', where, field: 'entries', message: `包内 id 重复："${id}"（后一条被丢弃）` });
    // 包内重复：只保留第一条
    const seen = new Set<string>();
    const deduped = entries.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
    entries.length = 0;
    entries.push(...deduped);
  }

  /* 两层判定（这是刻意的）：
     包层 error（包 id 非法 / 上限超了 / 模型源码不是字符串）→ 整包不加载；
     只有条目层 error → 拒收那几条，其余照常用（一个条目写错不该毁掉其余 200 条）。
     全部条目都坏 = 这个包什么都没得加载 → 也算不通过。 */
  if (issues.some((i) => i.level === 'error')) return { issues, entryIssues, ok: false };
  if (entries.length === 0) return { issues, entryIssues, ok: false };

  const out: ParsedPack = { pack: String(p.pack), name, version, entries, models };
  if (isStr(p.homepage)) out.homepage = p.homepage;
  if (isStr(p.note)) out.note = p.note;
  return { pack: out, issues, entryIssues, ok: true };
}

export interface CompiledModel {
  fn?: (C: unknown) => void;
  error?: string;
}

/** 把模型源码编译成函数。失败返回 error（调用方据此退回 kind 通用回退建模）。 */
export function compileModel(src: string): CompiledModel {
  try {
    // 只接受「一个函数表达式」：外层括号 + 立即取回，不执行任何额外语句
    const fn = new Function('"use strict";return (' + src + ');')();
    if (typeof fn !== 'function') return { error: '源码求值结果不是函数' };
    return { fn: fn as (C: unknown) => void };
  } catch (e) {
    return { error: (e instanceof Error ? e.message : '') || '编译失败' };
  }
}

export interface MergeResult {
  entries: CatalogEntry[];
  conflicts: Array<{ id: string; pack: string; reason: string }>;
}

/** 内置目录 + 各包 → 一份可渲染的目录。内置赢，包按传入顺序（先到先得）。 */
export function mergeCatalog(base: readonly CatalogEntry[], packs: readonly ParsedPack[]): MergeResult {
  const entries: CatalogEntry[] = [];
  const conflicts: MergeResult['conflicts'] = [];
  const seen = new Set<string>();
  for (const e of base) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    entries.push(e);
  }
  for (const p of packs) {
    for (const e of p.entries) {
      if (seen.has(e.id)) {
        conflicts.push({ id: e.id, pack: p.pack, reason: '与已加载的条目同 id（内置目录 / 先加载的包赢）' });
        continue;
      }
      seen.add(e.id);
      entries.push({ ...e, sourcePack: p.pack });
    }
  }
  return { entries, conflicts };
}

/* ---------------- 注册表（存的是元数据；包内容另存一个键） ---------------- */

function readMeta(v: unknown): PackMeta | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const m = v as Record<string, unknown>;
  if (!isStr(m.pack) || !PACK_ID_RE.test(m.pack)) return null;
  const name = isStr(m.name) && m.name && m.name.length <= 80 ? m.name : m.pack;
  const num = (x: unknown, max: number) => (isNum(x) && x >= 0 ? Math.min(Math.floor(x), max) : 0);
  return {
    pack: m.pack,
    name,
    version: isNum(m.version) && m.version >= 1 ? Math.floor(m.version) : 1,
    entries: num(m.entries, MAX_PACK_ENTRIES),
    models: num(m.models, MAX_PACK_MODELS),
    addedAt: isNum(m.addedAt) && m.addedAt >= 0 ? Math.floor(m.addedAt) : 0,
  };
}

export function normalizeRegistry(raw: unknown): PackRegistry {
  const packs: PackMeta[] = [];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    if (Array.isArray(r.packs)) {
      const map = new Map<string, PackMeta>();
      for (const it of r.packs) {
        const m = readMeta(it);
        if (m) map.set(m.pack, m);
      }
      packs.push(...Array.from(map.values()));
    }
  }
  return { v: PACK_SCHEMA, packs: packs.slice(0, MAX_PACKS) };
}

export const serializeRegistry = (r: PackRegistry): string => JSON.stringify({ v: PACK_SCHEMA, packs: r.packs });

export function upsertPackMeta(r: PackRegistry, m: PackMeta, now: number): PackRegistry {
  const meta: PackMeta = { ...m, addedAt: m.addedAt || now };
  const found = r.packs.some((p) => p.pack === meta.pack);
  const packs = found ? r.packs.map((p) => (p.pack === meta.pack ? meta : p)) : [...r.packs, meta];
  return { v: PACK_SCHEMA, packs: packs.slice(0, MAX_PACKS) };
}

export function removePackMeta(r: PackRegistry, id: string): PackRegistry {
  return { v: PACK_SCHEMA, packs: r.packs.filter((p) => p.pack !== id) };
}

export const packMetaFor = (p: ParsedPack): PackMeta => ({
  pack: p.pack,
  name: p.name,
  version: p.version,
  entries: p.entries.length,
  models: Object.keys(p.models).length,
  addedAt: 0,
});
