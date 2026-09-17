# R3. 3D 渲染管线（WebGL2 → WebGPU 的抉择）

日期：2026-09（研究，未实施）· 关联 ADR-0004 · 服务 roadmap S4 与长期画质升级

## 1. 现状管线（已建成，M2 真机实测）

```
光栅（three.js r147 WebGL2）：ACES + PMREM 环境 + 程序化贴图 + 法线
照片级（ptRender）：
  CPU: BVH 分箱 SAH → 打包 RGBA32F 纹理
  GPU: G-buffer 两趟 → 片元着色器栈式 BVH 遍历（any-hit 阴影）
       → 8-32×8-32 分块渐进累积（ptPickGrid 按实测耗时自适应）
       → fenceSync 节流（退化：轮询计数判据）
       → 萤火虫 3×3 抑制 → NaN 守卫 → À-Trous 降噪 → ACES+sRGB
实测（Apple M2，246k 三角形/31 灯）：草稿 120spp 60s，精细 900spp 398s
```

## 2. 浏览器硬件光追：不存在（2026-09）

- **WebGPU 规范（2026-09-15 CRD）没有 ray query / acceleration structure**
  （全文检索确认：只有 GPUQuerySet 这类统计查询）
- gpuweb **issue #535「Ray Tracing extension」仍 open**，Milestone **4+**、
  无 due date（2020 年开的）
- Rust `wgpu` 有**实验性** RT API（BLAS/TLAS/`@ray_query`，🧪EXPERIMENTAL），
  但那是 Rust 侧，不暴露给 Web
- **结论**：浏览器里的 RT 只能是**软件 BVH**（我们的现状就是正解）。
  重新评估时机：gpuweb #535 有实质进展（进入 Milestone 3 或 spec 草案）

## 3. three.js WebGPURenderer 现状（2026-09）

- **已「production-ready」**（社区共识，bitsoulhosting 2026 评测等）：
  - 浏览器支持面：WebGPU 已在 **Chrome / Edge / Safari 26 / Firefox 141+
    （Windows）/ 145+（Apple Silicon macOS）** 默认启用——「覆盖绝大多数」
  - three.js r184/r185：`import from 'three/webgpu'` + **TSL**（`three/tsl`）
    节点着色 + NodeMaterial + RenderPipeline
  - **自动回退**：不支持 WebGPU 的环境落回 WebGL2 后端
- **已知坑**（迁移评估必知）：
  - KTX2 压缩纹理在 WebGPU 后端出黑（GLB 场景）
  - 从 WebGL 教程抄的 **EffectComposer 后处理会静默抛错**
  - 多 mesh × 多材质有性能/内存回归（issue #33194，2026-03 已关闭）
  - 自定义 GLSL 需迁到 TSL（节点化）——**我们的 ptRender 是裸 WebGL2 +
    手写 GLSL（~2000 行），迁 TSL 是实质性重写，不是换 renderer 一行**
- 我们 pin 在 **r147**（2022）。r147→r185 之间 material/shader 系统大改。

### 判断（MiniDen 专属）

| | 保持 r147/WebGL2（现状） | 迁移 r185/WebGPU |
|---|---|---|
| 照片级渲染 | 已工作（M2 实测），软件 BVH 与 WebGPU 无关 | 收益 = compute 建 BVH（CPU ~百 ms → GPU 几 ms）+ 未来 ray query |
| 移动端 | WebGL2 全平台稳定 | 移动端 WebGPU 覆盖仍参差（Android 视 GPU 而定） |
| 回归风险 | 零 | 高：208 断言 + calib md5 全量重验；自定义着色器重写 |
| 单文件 | 不变 | three 体积涨（WebGL2+WebGPU 双后端 + TSL runtime） |

**推荐**：**保持 WebGL2 为基线**。src/ 模块化（E1）完成后，把
`render3d/` 做成「后端可插拔」，WebGPU 作为**二期画质/性能升级项**
（触发条件：① TSL 对 compute-heavy 工作负载的生态成熟 ② 我们的 BVH/累积
管线在 TSL 下有清晰映射 ③ 移动端覆盖达标）。在此之前，
把精力投到 10 环境预设（S4）与降噪质量——这些在 WebGL2 内就能做。

## 4. 降噪升级选项（WebGL2 内可做的）

- **现状 À-Trous**（空间域保边，确定性，零依赖）——保留
- **OIDN（Open Image Denoise，神经降噪）进浏览器的三个实现**（2026-09 搜索）：
  | 库 | 引擎 | 特点 |
  |---|---|---|
  | `pmndrs/denoiser`（DennisSmolek/Denoiser） | **onnxruntime-web + WebGPU EP**，前后处理 WGSL compute | 「~1080p 单次推理」；需 WebGPU |
  | `pissang/oidn-web` | U-Net 直接跑 WebGPU（WGSL 卷积） | 用在 Figma 插件；需 WebGPU |
  | `DennisSmolek/Denoiser`（tfjs 版） | tfjs（WebGL 也能跑，WebGPU 最快） | 兼容性最好；tfjs 体积大 |
- **MiniDen 判断**：OIDN 是质量升级（尤其低 spp 下），但 = WebGPU 依赖 +
  模型几 MB（单文件预算）+ 非确定性（U-Net 权重确定则推理确定，但算子
  实现跨平台可能有 ±1 差异 → 破坏 calib md5 回归）。
  **结论：À-Trous 留作确定性基线；OIDN 归入 WebGPU 二期的「高画质模式」开关**

## 5. 环境 / HDRI（服务 S4）

- **程序化全景**（现状 `cityPanorama(night)`，种子 1007/18798）：
  泛化成 `panorama(preset, mode)`，5 景观 × 昼夜 = 10 预设（设计文档 §3.4）
- **Poly Haven**：数百张 **CC0**（无版权无署名）等距柱状 HDRI，
  4K EXR 可下采样 2K JPEG ~200-400KB/张（10 张 ~3MB，进 repo 或懒加载）
  ——做「真实感」可选开关，程序化做默认（离线、确定性、零成本）
- 光照联动：昼夜已改灯光（`applyLightMode`）；预设叠加环境色温/亮度
  （走现有 `uEnvInt`，不动管线）

## 来源

- W3C WebGPU spec（2026-09-15 CRD 全文索引检索）；gpuweb issue #535
- wgpu wiki「Ray tracing」（factory.ai 镜像）
- threejs.org manual/docs WebGPURenderer；bitsoulhosting 2026 评测；
  three.js issue #33194；threejs-skills.com 迁移指南
- pmndrs/denoiser、pissang/oidn-web、DennisSmolek/Denoiser（GitHub README）
- polyhaven.com（CC0 许可、EXR 下载）
