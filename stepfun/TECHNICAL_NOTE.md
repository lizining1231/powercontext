# 一页技术说明 · 端侧向量化 + seekdb 混合检索迷你知识库

## 1. 模型与量化

| 项目 | 内容 |
|---|---|
| 模型 | `Xenova/bge-small-zh-v1.5`（BAAI `bge-small-zh-v1.5` 的 ONNX 导出），MIT 许可，512 维 |
| 获取方式 | `onnx/model.onnx`、`onnx/model_fp16.onnx`、`onnx/model_quantized.onnx` 与分词器文件，均由 `npm run fetch-model` 从 HuggingFace 下载并记录体积到 `manifest.json` |
| 量化方式 | INT8：ONNX Runtime 动态量化权重（`model_quantized.onnx`），权重存 8 位整数、推理时反量化；FP16：半精度权重（`model_fp16.onnx`）。INT8 权重随仓库提供（23.4 MB），默认离线可用 |
| 池化 | CLS 池化 + L2 归一化 |

| 精确度 | 权重体积 | 压缩比 | Recall@5 | Recall@10 | nDCG@10 | MRR@10 |
|---|---|---|---|---|---|---|
| FP32（基线） | 90.5 MiB | 1.00× | 0.875 | 0.969 | 0.899 | 0.912 |
| FP16 | 45.3 MiB | 2.00× | 0.875 | 0.969 | 0.899 | 0.912 |
| INT8 | 22.9 MiB | 3.95× | 0.875 | 0.969 | 0.899 | 0.912 |

评测方法：40 篇中文语料、16 条人工标注查询，混合检索 Top-10，文档级去重后计算指标；三档使用同一语料、同一查询集、同一 seekdb 集合配置，重复运行取中位数。该规模下三档排序一致，量化未造成可观测的质量下降；受语料规模限制，结论仅代表本评测集。

## 2. 端侧运行

- 运行时：Transformers.js 3.x + ONNX Runtime Web，全部在 Web Worker 内执行，主线程只做界面。
- 后端选择：`navigator.gpu` 存在且 `requestAdapter()` 成功时用 `webgpu + fp16`；否则 `wasm + q8`。若 WebGPU 适配器存在但会话创建失败，自动重试 `wasm + q8` 并在界面说明原因。
- 降级验证：`?backend=wasm` 可强制模拟"无 WebGPU"环境，界面显示 WASM 徽章与降级原因，导入与检索流程正常。
- 模型来源优先级：仓库内置 INT8 权重优先（完全离线），选择 FP16/FP32 时回落到在线下载。

| 配置 | 模型体积 | 加载耗时 | 预热 | 查询向量化 | seekdb 检索 | 端到端查询 |
|---|---|---|---|---|---|---|
| FP16 + WebGPU（冷启动含下载） | 45.7 MB | 10.13 s | 3.12 s | 127 ms | 14 ms | 1.52 s（首次）/ 782 ms（预热后） |
| INT8 + WASM | 23.3 MB | 4.67 s | 95 ms | 34 ms | 15 ms | 约 60 ms |
| FP32 + WASM（基线） | 90.9 MB | 6.38 s | 21 ms | 34 ms | 12 ms | 约 55 ms |

## 3. seekdb 使用

- 部署：seekdb-js 1.4.0 嵌入式模式，`SeekdbClient({ path: ./.data/seekdb })`，无需独立服务进程。
- 集合结构：每个知识库一个集合 `kb_<id>`，同时声明 `FulltextIndexConfig("ik", { ik_mode: "smart" })` 与 `VectorIndexConfig({ hnsw: { dimension: 512, distance: "cosine" }, embeddingFunction: null })`；字段为 `id / document / embedding / metadata(source, chunk)`。
- 混合检索：`collection.hybridSearch()` 内部走 `DBMS_HYBRID_SEARCH.GET_SQL`，生成一条 SQL 在库内完成全文召回、向量召回与 RRF 融合（`rank_constant = 60`）；前端不下发两次查询，也不在客户端拼合结果。
- 增量写入与刷新：32 条一批 `upsert`，同一文件重复导入按稳定 chunk id 覆盖而不是报主键冲突；写入返回后新文档立即可检索（实测 17 ms），导入完成才提示可用。
- 状态管理：知识库注册表记录名称、集合、维度与模型；列表实时读取 `collection.count()`，切换与删除同步到对应集合。

## 4. 状态与优化

| 优化项 | 优化前 | 优化后 | 说明 |
|---|---|---|---|
| 向量化批大小 | 1：3.23 s / 736 字每秒 | 16：886 ms / 2,686 字每秒 | 32 批为 694 ms / 3,429 字每秒，继续加大收益递减 |
| 模型加载 | 冷启动 10.13 s（含下载） | 缓存/内置 1.70–3.25 s | 权重随仓库提供 + 浏览器缓存 |
| 首次推理 | 无预热 3.12 s 一次性开销 | 预热后 127 ms/查询 | 加载完成后主动 warmup |
| 检索延迟 | 首次 1.23 s（含 HNSW 构建） | 预热后 12–15 ms | 集合首批写入后触发索引构建 |
| 查询端到端 | 1.52 s | 782 ms | 首次包含索引构建与算子编译 |
| 导入端到端（40 片段） | 新建集合 16.36 s | 已有集合 3.50 s（批 16） | 写入耗时主要在集合首次建索引 |

写入侧保持 32 条一批：批大小 1 时逐条事务开销明显（9.02 s），批 16/32 写入相近（2.54 s / 2.93 s），端到端以 16 批最优。

## 5. 测试条件与原始数据

WSL2 Ubuntu 24.04，Node.js v20.20.2，Chrome（WebGPU 可用），seekdb 1.4.0 嵌入式，语料 40 篇 / 2,381 字，查询 16 条。首次加载与预热后分开报告，重复运行取中位数；原始记录见 [docs/measurements.md](./docs/measurements.md)。
