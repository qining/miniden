// dxf-parser 没有官方类型（无 @types 包）——最小声明，只覆盖 src/geo 用到的面。
// 包是 CJS：module.exports = DxfParser 类本身（named import 走 esbuild/Node 互操作不可靠，
// 一律 default import）。完整输出结构见 src/geo/import-dxf.ts 的 DxfDoc/DxfEntity
// （结构化类型，零运行时耦合）。
declare module 'dxf-parser' {
  export default class DxfParser {
    parseSync(data: string | Uint8Array): unknown;
  }
}
