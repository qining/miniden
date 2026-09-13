# 地毯三款（stoense/morum/tiphede，俯视实拍 work/ref/{stoense,morum,tiphede}/v0.jpg）

| 条目 | 尺寸 | 厚 | 特征 |
|---|---|---|---|
| stoense23/17 | 300×200 / 240×170 | 2 | 圈绒、均色、无纹 |
| morum | 230×160 | 1 | 平织、细方格织纹、边带 |
| tiphede | 220×155 | 1 | 棉平织、素色+包边 |

## 建模（共用手法）
- 底衬包边片（w+0.8×厚×d+0.8）+ 主片 rb 高 seg（角圆 r0.5）
- morum/tiphede 四边窄边带（1.5 宽）
- 材质：carpetTexture + normalFromTexture(1.6) 强法线（绒感），rough .95 envI .1
