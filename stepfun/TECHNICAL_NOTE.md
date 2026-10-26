# 一页技术说明 · 端侧向量化 + seekdb 混合检索迷你知识库

## 1. 模型与量化

| 项目 | 内容 |
|---|---|
| 模型来源 | `Xenova/bge-small-zh-v1.5`（BAAI `bge-small-zh-v1.5` 的 ONNX 导出），MIT 许可 |
| 向量维度 | 512，CLS 池化 + L2 归一化 |
| 运行时 | Transformers.js 3.x + ONNX Runtime Web，全部在浏览器 Web Worker 内执行 |
| 量化方式 | INT8：ONNX Runtime 动态量化权重（`model_quantized.onnx`）；FP16：半精度权重（`model_fp16.onnx`） |

| 精度方案 | 权重体积 | 压缩比（相对 FP32） | Recall@5 | Recall@10 | nDCG@10 | MRR@10 |
|---|---|---|---|---|---|---|
| FP32（基线） | 90.5 MiB | 1.00× | 0.875 | 0.969 | 0.899 | 0.912 |
| FP16 | 45.3 MiB | 2.00× | 0.875 | 0.969 | 0.899 | 0.912 |
| INT8 | 22.9 MiB | 3.95× | 0.875 | 0.969 | 0.899 | 0.912 |

评测方法：40 篇中文技术语料、16 条人工标注查询，混合检索 Top-10，按文档级去重后计算指标；三档使用同一语料、同一查询集、同一 seekdb 集合配置。该规模下三档排序完全一致，未观察到量化带来的可观测质量损失；受语料规模限制，结论仅代表本评测集。

## 2. 端侧运行

- 后端选择：先判断 `navigator.gpu` 是否存在，再 `requestAdapter()`；成功用 `device=webgpu` + `dtype=fp16`，失败用 `device=wasm` + `dtype=q8`。
- 降级提示：状态条显示当前后端徽章（WebGPU / WASM），降级时额外显示黄色提示与原因；`?backend=wasm` 可强制模拟不支持 WebGPU 的环境用于验收。
- 推理位置：权重下载与算子执行均在浏览器，服务端只接收文本与向量，不调用任何云端推理 API。

| 配置 | 模型体积 | 加载耗时 | 预热耗时 | 查询向量化 | seekdb 检索 |
|---|---|---|---|---|---|
| FP16 + WebGPU（冷启动含下载） | 45.7 MB | 10.13 s | 3.12 s | 127 ms | 14 ms |
| FP16 + WebGPU（缓存命中） | 45.7 MB | 1.70 s | 1.69 s | 127 ms | 14 ms |
| INT8 + WASM | 23.3 MB | 4.67 s | 95 ms | 34 ms | 15 ms |
| FP32 + WASM（基线） | 90.9 MB | 6.38 s | 21 ms | 34 ms | 12 ms |

WASM 路径单独验证：强制 `?backend=wasm` 后徽章为 WASM、提示条说明降级原因，导入与混合检索流程照常完成。

## 3. seekdb 使用

- 部署方式：seekdb-js 1.4.0 嵌入式模式（`SeekdbClient({ path: ./.data/seekdb })`），无需独立服务进程。
- 集合结构：每个知识库一个集合 `kb_<id>`，`Schema` 同时声明 `FulltextIndexConfig("ik", { ik_mode: "smart" })` 与 `VectorIndexConfig({ hnsw: { dimension: 512, distance: "cosine" }, embeddingFunction: null })`；写入字段为 `id / document / embedding / metadata(source, chunk)`。
- 混合检索：调用 `collection.hybridSearch()`，其内部通过 `DBMS_HYBRID_SEARCH.GET_SQL` 生成单条 SQL，在库内完成全文召回、向量召回与 RRF 融合（`rank.rrf.rank_constant = 60`），前端不做两路结果拼合。
- 增量写入与刷新：按 32 条一批写入，写入返回后新文档即可被检索（探针实测新增文档 17 ms 后命中）；导入流程在写入完成后才提示可用。
- 状态管理：知识库注册表记录名称、集合名、维度与模型；列表实时读取 `collection.count()`，切换与删除同步作用到对应集合。

## 4. 状态与优化

| 优化项 | 优化前 | 优化后 | 说明 |
|---|---|---|---|
| 向量化批大小 | 1：3.23 s / 736 字每秒 | 16：886 ms / 2,686 字每秒 | 32 批为 694 ms / 3,429 字每秒，继续加大收益递减 |
| 模型加载 | 冷启动 10.13 s（含权重下载） | 缓存命中 1.70 s | 浏览器缓存权重 + Worker 复用 |
| 首次推理 | 首条 3.12 s 预热开销 | 预热后 127 ms/查询 | 加载完成后主动跑一次 warmup |
| 检索延迟 | 首次 1.23 s（含 HNSW 构建） | 预热后 12–15 ms | 集合首批写入后触发索引构建 |
| 查询端到端 | 首次 1.52 s | 预热后 782 ms | 首次包含索引构建与算子编译 |
| 导入端到端（40 片段） | 新建集合 16.36 s | 已有集合 3.50 s（批 16） | 写入耗时主要在集合首次建索引 |

写入侧保持 32 条一批：批大小 1 时逐条事务开销明显（9.02 s），批 16/32 写入耗时相近（2.54 s / 2.93 s），端到端以 16 批最优。

## 5. 测试条件

WSL2 Ubuntu 24.04，Node.js v20.20.2，Chrome（WebGPU 可用，FP16 推理），seekdb 1.4.0 嵌入式，语料 40 篇 / 2,381 字，查询 16 条。所有数字取自提交应用的界面实测，重复运行取中位数附近的稳定值；冷启动与缓存命中分开记录。
