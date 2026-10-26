# 🧠 StepFun × seekdb · 端侧迷你知识库

> 在浏览器里完成向量化，用 seekdb 做向量 + 全文混合检索的迷你知识库应用。
> 推理全程在用户设备上，检索全程在数据库里，服务端只做转发。

## ✨ 做了什么

| 能力 | 实现方式 |
|---|---|
| 📄 语料导入 | 粘贴文本或选择本地文件，按 320 字切块、保留 64 字重叠 |
| 🔢 端侧向量化 | Transformers.js + ONNX Runtime Web，在 Web Worker 内完成编码 |
| ⚡ 推理后端 | 优先 WebGPU（FP16）；不可用时自动降级 WASM（INT8），界面明确提示 |
| 🗄️ 存储与检索 | seekdb 嵌入式模式，向量索引 + 全文索引，`hybridSearch` 在库内完成 RRF 融合 |
| 🔁 增量写入 | 新文档写入后立即可检索，支持多知识库切换与删除 |
| 📊 质量评测 | 内置 40 篇语料 / 16 条标注查询，一键算 Recall@5/10、nDCG@10、MRR@10 |

## 🏗️ 架构

```
┌──────────────────────── 浏览器 ────────────────────────┐
│  React UI ──► Web Worker ──► Transformers.js           │
│                 (WebGPU FP16 / WASM INT8)              │
│      │ 只发送文本与向量                                  │
│      ▼                                                  │
│  HTTP /api  ─────────────┐                              │
└──────────────────────────┼──────────────────────────────┘
                           ▼
              ┌────────────────────────┐
              │ Node API (Express)     │
              │ seekdb-js 1.4.0        │
              │  └─ seekdb embedded    │
              │     DBMS_HYBRID_SEARCH │
              │     向量 + 全文 + RRF   │
              └────────────────────────┘
```

关键约束：**两路召回与融合排序都在 seekdb 内完成**。前端只发一次请求，不做"分别查两次再拼合"。

## 🚀 快速开始

环境要求：Node.js ≥ 20，Chrome / Edge 最新版。首次运行需要联网下载 seekdb 原生运行时（约 198 MB，缓存到 `~/.seekdb`）与 embedding 模型（FP16 45.7 MB / INT8 23.3 MB，走浏览器缓存）。

```bash
cd stepfun
npm install          # 依赖安装（.npmrc 已处理 seekdb-js 的 peer 协议问题）
npm run dev          # 同时启动 API(8090) 与前端(5173)
```

打开 <http://localhost:5173>。

生产模式：

```bash
npm run build        # 前端产物输出到 web/dist
npm start            # 单进程：API 同时托管静态页面，访问 :8090
```

### 🌍 环境变量（可选）

| 变量 | 作用 | 默认 |
|---|---|---|
| `PORT` | API 端口 | `8090` |
| `SEEKDB_DATA_DIR` | seekdb 数据目录 | `./.data` |
| `EMBEDDING_DIM` | 新知识库默认向量维度 | `512` |
| `VITE_EMBEDDING_MODEL` | 前端嵌入模型 | `Xenova/bge-small-zh-v1.5` |
| `VITE_HF_ENDPOINT` | 模型下载镜像 | 官方地址 |

### 🐧 Linux 说明

Ubuntu 24.04 把 libaio 改名为 `libaio.so.1t64`，且 `libseekdb.so` 延迟加载会遇到静态 TLS 空间不足。`scripts/start.mjs` 会自动建立 `libaio.so.1` 软链并通过 `LD_PRELOAD` 预加载 `libseekdb.so`，无需手工配置。

## 🧭 使用流程

1. 左侧输入名称 → `创建`，得到独立知识库（seekdb 中对应一个集合）。
2. `导入` 页粘贴文本或选择文件，点击 `本地向量化并写入 seekdb`；演示可直接点 `导入示例语料`。
3. `检索` 页输入问题，选择 `混合检索 / 仅向量 / 仅全文`，查看排序结果、向量距离与分阶段耗时。
4. `质量评测` 页点击 `运行评测`，跑完整评测集并导出 JSON。

验证降级路径：打开 <http://localhost:5173/?backend=wasm>，界面会显示 WASM 徽章与降级原因提示，核心流程照常可用。

## 🔌 API

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/health` | 服务与 seekdb 状态 |
| `GET` | `/api/kb` | 知识库列表（含片段数） |
| `POST` | `/api/kb` | 创建知识库 |
| `DELETE` | `/api/kb/:id` | 删除知识库及其集合 |
| `POST` | `/api/kb/:id/docs` | 批量写入已验证的向量与原文 |
| `POST` | `/api/kb/:id/search` | 混合 / 向量 / 全文检索 |

## 📈 实测结果

详见 [TECHNICAL_NOTE.md](./TECHNICAL_NOTE.md)。摘要：

| 配置 | 模型体积 | 查询向量化 | seekdb 检索 | Recall@10 |
|---|---|---|---|---|
| FP16 + WebGPU | 45.7 MB | 127 ms | 14 ms | 0.969 |
| INT8 + WASM | 23.3 MB | 34 ms | 15 ms | 0.969 |
| FP32 + WASM（基线） | 90.9 MB | 34 ms | 12 ms | 0.969 |

向量化批大小从 1 提到 16，吞吐由 736 字/秒提升到 2,686 字/秒。

## 📁 目录

```
stepfun/
├── server/            # Express + seekdb-js（嵌入式）
├── web/               # React + Vite + Transformers.js
│   ├── src/embedder.worker.ts   # 端侧推理 Worker
│   └── public/eval/             # 评测语料与标注查询
├── scripts/start.mjs  # 一键启动（含 Linux 运行时垫片）
└── TECHNICAL_NOTE.md  # 一页技术说明
```

## ⚠️ 已知限制

- 评测集规模为 40 篇语料 / 16 条查询，仅用于同口径横向对比，不代表大规模场景的绝对指标。
- seekdb 嵌入式运行时在进程退出时会打印一条 teardown 提示，不影响数据一致性与后续启动。
- 文本知识库为必选功能，图片内容未纳入本期实现。

## 📦 提交产物

- 可运行 Web 应用与完整源码（本目录）
- 一页技术说明：[TECHNICAL_NOTE.md](./TECHNICAL_NOTE.md)
- 复现实验所需数据与步骤：`web/public/eval/` + 下文"复现实验"

## 🔬 复现实验

```bash
npm install && npm run dev
# 浏览器打开 http://localhost:5173
# 1) 侧栏创建知识库  2) 导入页点"导入示例语料"（40 片段）
# 3) 质量评测页点"运行评测"，记录 Recall/nDCG/MRR 与耗时
# 4) 切换精度方案（FP16+WebGPU / INT8+WASM / FP32 基线）后重复步骤 3
# 5) 打开 ?backend=wasm 验证降级提示与核心流程
```
