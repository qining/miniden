# Third-Party Software

MiniDen 是单文件 Web 应用，运行时依赖全部 **vendored 在 `lib/`**（离线可用、零版本漂移）。
本文件是它们的署名清单（MIT / Apache-2.0 的 attribution 义务在此履行）。

## 随产物分发的运行时库（vendored 进 `lib/`，并内联进 `dist/*.html` 单文件）

| 库 | 版本 | 许可证 | 用途 | 位置 |
|---|---|---|---|---|
| [three.js](https://github.com/mrdoob/three.js) | r147 | MIT | 3D 渲染（娃娃屋/第一人称/光追） | `lib/three.min.js`（文件头保留原始 MIT 声明） |
| three.js examples — [OrbitControls](https://github.com/mrdoob/three.js/blob/r147/examples/js/controls/OrbitControls.js) | r147 | MIT | 3D 相机轨道控制 | `lib/OrbitControls.js` |
| [dxf-parser](https://github.com/mdgserver/dxf-parser) | 1.1.2 | MIT | DXF 导入解析 | `lib/dxf-parser.iife.js`（官方 UMD 原样；`node scripts/build-dxf-lib.mjs` 从 node_modules 重新生成） |
| [pdf.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist` legacy build) | 4.10.38 | Apache-2.0 | PDF 向量导入 | `lib/pdf.min.js` + `lib/pdf.worker.min.js`（`node scripts/build-pdf-lib.mjs` 生成；文件头带 VENDORED 注记） |

### three.js — MIT

    The MIT License

    Copyright (c) 2010-2022 three.js authors

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in
    all copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
    THE SOFTWARE.

### dxf-parser — MIT

    The MIT License (MIT)

    Copyright (c) 2015 mdgserver

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

### pdf.js — Apache License 2.0

    Copyright (c) 1995-2025, Mozilla Contributors. All rights reserved.

    Licensed under the Apache License, Version 2.0 (the "License"); you may not
    use this file except in compliance with the License. You may obtain a copy
    of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
    WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
    License for the specific language governing permissions and limitations
    under the License.

## 仅开发期使用、不随单文件产物分发

| 工具 | 许可证 | 用途 |
|---|---|---|
| [esbuild](https://github.com/evanw/esbuild) 0.28 | MIT | 构建管线（`build.mjs`） |
| [vitest](https://github.com/vitest-dev/vitest) 5 | MIT | 单元测试 |
| [TypeScript](https://github.com/microsoft/TypeScript) 7 | Apache-2.0 | schema/geo 层编译 |
| [pngjs](https://github.com/luke-ap/pngjs) 7 | MIT | ui-gate 像素 diff |
| ezdxf / LibreDWG / QCAD | 各自开源 | 仅用于生成测试 fixture（`tests/fixtures/integration/`），不进运行时 |

## 明确未使用

- **OpenCV.js**：路线图早期设想用于图片描摹，实际 S7 实现为纯 JS 管线
  （Otsu + Canny-lite + Hough），产物中不含 OpenCV.js。
