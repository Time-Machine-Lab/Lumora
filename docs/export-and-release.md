# 预览导出与发布验收

本文定义 Lumora MVP 的分镜导出契约、浏览器降级策略、性能基准方法和发布检查项。自动化结果只覆盖仓库可执行的环境；标为“人工”的项目必须由发布负责人记录浏览器版本、设备和结论。

## WebM muxing implementation

Lumora uses Mediabunny for WebM container writing. The Studio exporter keeps
WebCodecs `VideoEncoder` in charge of frame production and converts each
`EncodedVideoChunk` into a Mediabunny `EncodedPacket` before adding it to an
`EncodedVideoPacketSource`. This preserves explicit microsecond timestamps and
durations, while Mediabunny's `WebMOutputFormat` and `BufferTarget` provide the
container finalization and in-memory output.

The exporter still enforces a combined maximum of four frames across the
WebCodecs queue and pending packet writes, checks cancellation and operation
ownership around every wait, and encodes an unchanged zero-duration terminal
packet at `N / fps`. It waits for `VideoEncoder.flush()` and pending packet
writes, and only then awaits `Output.finalize()` and returns a Blob. Any error or
cancellation closes the WebCodecs encoder and awaits cancellation of an output
that has not begun finalizing. Mediabunny finalization itself is non-cancellable;
if it has started, the exporter waits for that in-flight cleanup before returning
the cancellation or timeout so the next export can retry cleanly.
`finalizationTimeoutMs` is therefore a watchdog for the flush/finalization
operation, not a hard upper bound on the caller's returned promise: if
`Output.finalize()` is already running when the watchdog fires, the exporter
records the timeout but waits for that promise to settle before returning.
This is the only safe way to avoid detached writes because Mediabunny's
`Output.cancel()` is intentionally a no-op once finalization has begun.

Mediabunny is distributed under the MPL-2.0. Keep its license and attribution
entry in `docs/THIRD_PARTY_NOTICES.md`; regenerate that inventory after every
dependency or lockfile change and do not ship a bundle with an `UNKNOWN`
license.

### Dependency comparison

| Dependency | Capability | License | npm unpacked size | Browser support | Migration risk |
| --- | --- | --- | ---: | --- | --- |
| `webm-muxer@5.1.4` | WebM muxing only; synchronous WebCodecs chunk handoff | MIT; deprecated and superseded | 147,682 bytes | Depends on Lumora's WebCodecs implementation | No maintenance path; retained custom timing and cleanup code |
| `mediabunny@1.55.6` | Maintained WebM/Matroska muxing plus packet, input, and conversion APIs; tree-shakable | MPL-2.0 | 10,431,508 bytes | Modern browsers with WebCodecs; Lumora still performs explicit VP8 preflight | Larger source distribution and MPL notice; packet writes are asynchronous and must be serialized before finalization |

The size figures are npm `dist.unpackedSize` values, not shipped JavaScript
bundle sizes. Vite tree-shakes and bundles Mediabunny into the Studio artifact,
so it is a build-time dependency rather than a dependency installed again by
Studio consumers. This also prevents Mediabunny's pinned WebCodecs ambient type
package from conflicting with consumer DOM libraries. The Studio build keeps
the existing WebCodecs encoder boundary. The main compatibility risk is
therefore the seconds-based packet API and asynchronous writer backpressure;
regression tests cover the conversion from microsecond WebCodecs timestamps and
the finalization barrier.

## 导出契约

导出工作台默认选择全部分镜、1280 x 720 和 24fps。用户也可选择单个分镜、854 x 480 或 30fps。

开始 WebM 编码前必须满足：

1. 至少选择一个分镜。
2. 每个分镜的开始/结束时间有效，且结束时间晚于开始时间。
3. 每个分镜绑定活动场景中可达的摄像机对象。
4. 浏览器提供 WebCodecs `VideoEncoder`、`VideoFrame` 和 `VideoEncoder.isConfigSupported()`，且能力检查确认当前分辨率、帧率和码率对应的 VP8 配置可用。

工作台打开及分辨率、帧率或项目会话变化后，会异步检查精确的 VP8 配置；检查完成前 WebM 按钮保持禁用并显示检查状态。不支持、检查失败或陈旧检查结果都不能进入 `configure()`，本轮不协商 VP9 回退。

时间线录制进行中不允许开始 PNG 或 WebM 画面导出，避免录制机位跳过轨道求值。编码按项目中的分镜顺序逐帧推进，源时间为 `shot.startTime + frameIndex / fps`。第 `i` 个内容帧显式使用 `round(i * 1,000,000 / fps)` 微秒 PTS，其 duration 为相邻量化时间戳之差，因此文件时钟不依赖墙钟、计时器节流或渲染耗时。编码器和待写 packet 的合计在途队列上限为 4 帧；达到上限时等待容量降到 3 帧后再继续，并且即使未触发背压也至少每 4 个内容帧通过计时器让出一次浏览器宏任务。每次背压等待或宏任务让步恢复后立即复核取消信号和操作所有权。`N` 个内容帧完成后，再把未改变的末帧作为零时长终止 packet 编码到 `N / fps`；Mediabunny 按 packet 结束时间计算容器时长，因此该零时长可保留终止 PTS 而不额外延长一帧。随后等待 `VideoEncoder.flush()`、所有 Mediabunny packet 写入和 `Output.finalize()`，才允许下载。失败或取消时，尚未进入 finalizing 的输出等待 `Output.cancel()` 清理；若不可取消的 finalization 已开始，则等待该 promise 完成后再返回取消或超时结果。

真实产物门禁使用 `ffprobe` 检查视频 packet、末 PTS 和容器 duration。`N` 个内容帧必须产生 `N + 1` 个 packet，末 PTS 和容器 duration 必须命中 `N / fps`，且容差小于四分之一帧；源时间线到量化目标的误差单独限制在半帧内，不能用该误差掩盖缺失终止帧。

固定 16:9 输出会在项目画幅外补背景，不拉伸 4:3 或竖屏项目。项目画幅用于计算居中的整数捕获视口；透视投影使用该整数视口的实际宽高比，避免 `854 x 480` 等分辨率因项目比例与取整后比例不一致产生轻微拉伸。编辑网格、变换控件和 DOM 辅助线不进入 PNG 或视频帧。

WebM、PNG、清单和插件导出共享同一个工作台操作令牌，任一时刻只运行一项。关闭或卸载工作台、切换项目会话，或移除正在运行的插件导出器时，当前令牌立即失效；异步回调、背压/宏任务等待以及可重入的播放头跳转和画面捕获后必须重新验证 `{uri, sessionGeneration, operationGeneration}`，因此过期操作不能继续捕获、编码、下载文件、恢复旧播放头或覆盖新会话状态。导出期间暂停时间线，完成、失败或取消后恢复原播放头；取消、失效、编码错误、flush 超时以及同步 `configure()` 失败都会关闭已构造的 `VideoEncoder`，其他完成路径也会缩小临时画布并释放对象 URL。

### 输出

| 输出 | 内容 | 隐私边界 |
| --- | --- | --- |
| PNG | 指定分镜中点、指定分辨率的机位画面 | 仅像素，不包含编辑器覆盖层 |
| JSON 清单 | 项目标识、画幅、分镜顺序/时间/可空机位和可选 AI 元数据 | 不包含资产、载荷、存储引用、`pluginData` 或运行时凭据 |
| WebM | 所选分镜拼接后的 VP8 WebM | 浏览器本地编码，不上传帧或项目 |
| 插件导出 | `exporter.export(project)` 的返回数据 | 插件负责格式、转码和敏感字段剥离；失败与核心编辑隔离 |

MP4 不是 MVP 内置能力。需要 MP4 时，由嵌入宿主或 exporter 插件提供真实转码，并单独声明编解码器、许可证、性能和失败策略；不得通过改扩展名伪装格式。

## 浏览器兼容矩阵

| 浏览器 | WebM 预览 | 降级/验收 |
| --- | --- | --- |
| Chrome 当前稳定版 | 目标支持 | 自动化覆盖 Chromium；发布前在目标稳定版人工复验一次 |
| Chrome 前一稳定版 | 目标支持 | 人工执行三分镜 720p/24fps 导出、取消和重试 |
| Edge 当前稳定版 | 目标支持 | 人工执行同一用例并记录版本、文件时长和控制台 |
| Edge 前一稳定版 | 目标支持 | 人工执行同一用例并记录版本、文件时长和控制台 |
| Safari 当前稳定版 | 能力检测后决定 | 不支持 WebCodecs `VideoEncoder`/`VideoFrame` 或 VP8 时，编码前显示说明且禁用 WebM；PNG/清单和编辑必须可用 |

兼容测试使用 3 个持久化重开后仍视觉可区分的机位，验证 EBML 文件头、非零文件、目标分辨率、可解码画面、逐段画面顺序、packet/末 PTS/容器时长、精确 VP8 配置预检、长导出任务队列取消、最大 `encodeQueueSize <= 4`、取消不下载、编码器关闭和取消后的继续编辑。Safari 不能在 Windows CI 上作可信替代，必须在 macOS 真机人工签署降级结果。

### 生产 Preview 自动化前置条件

`npm run e2e:preview` 使用生产构建、系统 Microsoft Edge 和 `ffprobe`。命令会先运行 `scripts/check-preview-prerequisites.mjs`，在启动 Vite 或执行产品断言前检查以下依赖，并在缺失时给出安装或 PATH 修复说明：

1. 系统 Microsoft Edge 可由 Playwright 的 `msedge` channel 启动；非标准安装可通过 `PLAYWRIGHT_EDGE_PATH` 指向实际可执行文件。预检会按与生产 Preview 配置相同的方式实际启动该浏览器，并要求 user agent 包含 `Edg/`，因此目录、普通文件和其他 Chromium 浏览器都不会被误判为 Edge。
2. FFmpeg 的 `ffprobe` 可从 `PATH` 直接运行；真实 WebM packet、末 PTS 和容器 duration 断言依赖它。

可单独运行 `node scripts/check-preview-prerequisites.mjs` 诊断 runner。仓库不分发 Edge 或 FFmpeg，干净 runner 必须在执行生产 Preview 门禁前安装这两项系统依赖。

## 主流程验收

`e2e/export.spec.ts` 从空浏览器上下文执行以下流程：

```text
新建项目 -> 导入 GLB -> 新建机位 -> 录制机位轨道 -> 生成并采用三分镜
-> 绑定机位 -> 等待保存 -> 刷新并从最近项目恢复 -> 720p/24fps WebM 导出
```

同一文件还覆盖真实 WebM 播放/时长、14 帧/24fps 与 45 帧/30fps 产物探针、无 WebCodecs 时零 encoder/零下载、VP8 预检等待/不支持/异常/陈旧结果、长导出取消与队列上限、取消和会话失效后的 encoder 关闭、`configure()`/flush 失败与取消重试，以及返回编辑。测试收集 `pageerror` 与 error 级别控制台消息；主流程要求集合为空。

## 100 对象 / 100 万面性能基准

Q-003 尚未指定基准设备，因此当前只固定可重复的场景和测量方法，不声明设备级通过。发布负责人确认设备后，必须把设备型号、CPU、GPU、内存、操作系统、浏览器精确版本、电源模式和屏幕缩放写入验收记录。

基准项目配方：

1. 新建 16:9 项目，创建 100 个可见模型对象；每个对象使用确定性的 10,000 三角形网格，总计 1,000,000 三角形。
2. 添加 2 台摄像机、3 个连续分镜和一条含至少 120 个关键帧的摄像机轨道。
3. 冷启动浏览器，关闭扩展和其他标签页，以生产构建运行；保留默认 DPR，不降低画质。
4. 预热 10 秒，再用浏览器 Performance 面板记录 30 秒导演视图交互、30 秒时间线播放和一次 3 秒 720p/24fps 导出。
5. 记录首屏可交互时间、播放帧时间 p50/p95、低于 30fps 的帧占比、JS heap 峰值、导出墙钟时间、生成文件时长以及控制台/WebGL 错误。
6. 重启浏览器重复 3 次，报告中位数和最差值；不得只报告最好一次。

Q-003 确认前，性能项状态必须保持“待设备决策”，不能用开发机结果替代发布签署。

## 安全与隐私

- JSON 清单和默认工程包不得包含 API key、Authorization、会话令牌或插件私有数据。
- WebM/PNG 在浏览器本地生成；核心导出路径不发起网络请求。
- 不支持编码时不得构造 `VideoEncoder` 或创建损坏下载。
- 捕获、编码或插件导出失败不得修改项目；返回编辑后撤销、对象编辑和保存仍可用。
- 插件与宿主当前同进程运行，属于可信代码边界。处理不可信插件前必须增加 Worker/iframe 隔离；当前错误边界不是安全沙箱。
- 嵌入宿主卸载前必须等待 `handle.close()` 成功，避免丢失未冲刷数据或泄漏 WebGL/插件资源。

## 键盘与可访问性

人工验收至少覆盖：

- 仅键盘从工具栏进入导出工作台，关闭后焦点返回“导出”按钮。
- 导出范围、分辨率、帧率、导出/取消/清单和逐镜 PNG 均有可读名称与可见焦点。
- 运行中会禁用会改变计划的控件；进度通过原生 `progress` 和状态区域暴露。
- VP8 预检中、成功和取消使用状态区域，能力检查失败与其他错误使用 `role="alert"`；不只依赖颜色表达结果。
- 375 x 667、1280 x 800 和 1440 x 900 下无横向页面溢出、文字遮挡或不可达操作。
- 在 Chrome DevTools 检查正文、按钮、焦点环和错误文本对比度；正文/控件至少 4.5:1，大字号至少 3:1，非文本控件至少 3:1。

## 发布清单

### 自动化门禁

- [ ] `npm ci`
- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run test`
- [ ] `npm run build`
- [ ] `npm run e2e`
- [ ] `npm run e2e:preview`（前置检查通过后，在系统 Edge 上运行生产构建用例）
- [ ] `npm run smoke:pack`
- [ ] `npm run licenses:generate` 后工作区无意外差异，且无 `UNKNOWN` 许可证

### 人工门禁

- [ ] Chrome/Edge 当前和前一稳定版按兼容矩阵签署
- [ ] Safari 当前稳定版签署 WebM 或明确降级路径
- [ ] 桌面和移动关键视口完成键盘、焦点、名称、对比度和布局检查
- [ ] Q-003 基准设备已确认并完成三轮性能测量
- [ ] Q-004 已确认：接受 WebM 默认策略，或另行交付经过许可审查的 MP4 exporter
- [ ] 发布包、插件开发文档、嵌入示例和第三方 NOTICE 由发布负责人复核
- [ ] 用前一稳定构建打开同一 `.lumora` 工程包，确认回滚可行；记录构建标识和恢复步骤

### 回滚

保留前一稳定版本的包制品和对应锁文件。发布前导出一份不含私密插件数据的 `.lumora` 工程包作为恢复夹具。若新版本发生编码、持久化或插件兼容回归，停止分发新制品，恢复前一稳定制品，并用恢复夹具验证打开、编辑和重新导出；不要回滚或覆盖用户浏览器中的项目数据库。
