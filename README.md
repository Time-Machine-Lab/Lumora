# Lumora

可嵌入的 3D 资产创作 Web 应用与插件平台（MVP-1 基线）。

- **包边界**：`@lumora/core`（框架无关的插件运行时核心）、`@lumora/studio`（React 壳层 UI）、`@lumora/plugin-sdk`（插件作者公共 API）
- **插件协议**：`lumora.plugin.json`（Manifest v1）+ `activate/deactivate` 生命周期 + 六类贡献项
- **嵌入方式**：任意 React 应用以组件形式嵌入 `LumoraStudio`，监听 typed 事件，卸载即释放全部资源

## 快速开始

```bash
npm install
npm run build        # 构建全部包（core → plugin-sdk → studio → mock-plugin）
npm run dev          # 启动示例嵌入宿主（http://localhost:5173）
```

基线检查：

```bash
npm run lint         # ESLint
npm run typecheck    # tsc 全仓
npm run test         # vitest 单元测试
npm run e2e:install  # 首次安装 Playwright Chromium
npm run e2e          # Playwright 端到端（自动起 dev server @5199）
npm run smoke:pack   # 打包全部包，在临时工程以 tarball 安装并构建消费端（含 style.css 导入与 React 19 peer 边界）
```

## 仓库结构

```
packages/core/         插件运行时：Manifest 校验、引擎兼容、PluginHost 状态机、
                       CommandRegistry、ContributionRegistry、事件总线、服务门面
packages/plugin-sdk/   插件作者 API：definePlugin / defineManifest / 贡献项类型
packages/studio/       React 壳层：LumoraStudio 组件、工具栏、面板宿主、
                       命令面板、插件管理、Three.js 场景视图
examples/mock-plugin/  示例插件：六类贡献项全演示（lumora.plugin.json + 源码 + 测试）
examples/embedded-host/ 空白 React/Vite 宿主：嵌入 LumoraStudio、typed 事件日志、
                       挂载/卸载释放演示、非法/崩溃插件演示
e2e/                   Playwright 基线：壳层渲染、事件、生命周期、错误隔离
```

## 嵌入指南

```tsx
import { useRef } from 'react';
import { LumoraStudio } from '@lumora/studio';
import '@lumora/studio/style.css'; // 壳层样式（构建产物为 dist/style.css）
import type { LumoraStudioHandle } from '@lumora/studio';
import type { PluginDescriptor } from '@lumora/core';

const plugins: PluginDescriptor[] = [
  {
    manifest: { /* lumora.plugin.json 内容 */ },
    entry: () => import('my-plugin'),
  },
];

function Host() {
  const handle = useRef<LumoraStudioHandle>(null);
  return (
    <LumoraStudio
      ref={handle}
      plugins={plugins}
      hostVersion="0.1.0"
      initialProject={/* Project | undefined */}
    />
  );
}
```

- **typed 事件**：`handle.current.runtime.events.on('project:opened' | 'plugin:state-changed' | 'command:executed' | ...)`；自定义事件经 `onAny` 透传。
- **打开/关闭项目**：`handle.current.runtime.openProject(project)` / `closeProject()`。
- **卸载屏障（可等待）**：宿主卸载组件前必须先 `await handle.current.close()` —— 冲刷未保存变更后停用全部插件、移除全部订阅、销毁事件总线与 WebGL 场景（幂等；失败可重试）。返回 `{ ok: false }` 表示释放被拒绝（冲刷失败 / 存在未解决的恢复 fork），此时运行时未 teardown、**组件必须保持挂载**：先解决未保存内容（重试保存 / 另存副本 / 显式丢弃恢复快照）再重试 `close()`，成功后才能真正卸载 UI。绝不「不等待直接卸载」或「假装已卸载」丢弃内容。
- **场景槽位**：传入 `scene={(project) => ...}` 可替换内置 Three.js 场景视图。

## 插件开发指南

1. 在插件目录写 `lumora.plugin.json`（Manifest v1）：

```json
{
  "schemaVersion": "1",
  "id": "com.example.my-plugin",
  "name": "我的插件",
  "version": "0.1.0",
  "entry": "./dist/index.js",
  "engine": { "lumora": ">=0.1.0" },
  "contributes": ["panel", "command", "toolbar"]
}
```

2. 入口模块导出插件定义（`default` 或具名 `activate/deactivate` 均可）：

```ts
import { definePlugin } from '@lumora/plugin-sdk';

export default definePlugin({
  activate(context) {
    // context: { pluginId, manifest, hostVersion, events, commands, services, contribute, getProject, log }
    return context.contribute({
      panels: [{ kind: 'panel', id: '...', title: '...', component: MyPanel }],
      commands: [{ kind: 'command', command: { id: '...', title: '...', execute() { /* ... */ } } }],
      toolbars: [{ kind: 'toolbar', id: '...', label: '...', commandId: '...' }],
      assetLoaders: [{ kind: 'assetLoader', id: '...', extensions: ['.myext'], load(uri) { /* ... */ } }],
      aiProviders: [{ kind: 'aiProvider', id: '...', models: ['m1'], chat(req) { /* AsyncIterable<string> */ } }],
      exporters: [{ kind: 'exporter', id: '...', formats: ['json'], export(project) { /* ... */ } }],
    });
  },
  deactivate() { /* 宿主已自动回收贡献项/命令/订阅，这里做自身清理 */ },
});
```

### AI 分镜供应商

`aiProvider` 可在聊天能力之外声明 `ai.storyboard.generate`。宿主将创意简报提交为可取消任务，严格校验供应商响应，再把结构化草案交给用户编辑和采用；校验失败、超时、限流与取消都不会写入项目，也不会自动重试。费用提示必须明确区分已知和未知，供应商错误不得包含凭据或原始敏感响应。

```ts
import { AI_STORYBOARD_GENERATE_CAPABILITY, definePlugin } from '@lumora/plugin-sdk';

export default definePlugin({
  activate(context) {
    return context.contribute({
      aiProviders: [{
        kind: 'aiProvider',
        id: 'com.example.storyboard',
        name: 'Example Storyboard',
        models: [],
        async *chat() {},
        storyboard: {
          capability: AI_STORYBOARD_GENERATE_CAPABILITY,
          models: [{
            id: 'storyboard-v1',
            name: 'Storyboard v1',
            cost: { kind: 'unknown', note: '由供应商账单确定' },
          }],
          async generate(request) {
            // 返回 { title, summary, shots[] }；request.signal 用于取消。
            return callProvider(request);
          },
        },
      }],
    });
  },
});
```

`examples/mock-plugin` 提供完全离线、确定性的 `Success`、`Timeout`、`Rate limit`、`Invalid schema` 与 `Slow / cancellable` 模型，可在 Studio 的「AI 分镜」工作台直接验证成功、错误和取消路径。生产供应商、模型、区域与凭据接入仍需单独决策；当前实现不硬编码真实厂商，也不包含生产密钥。SDK 同时预留可选的 `ai.image.reference.generate` 能力接口，但 Mock 插件未实现参考图供应商。

**Q-001（明确限制）**：首个正式一方 AI Provider、生产模型/区域以及凭据存储与注入策略仍待产品和架构确认；此决策不阻塞当前 Provider 中立接口与离线 Mock 闭环集成。

### 生命周期与错误隔离

- 状态机：`registered → loading → activating → active`，任一步失败进入 `failed` 并记录明确原因；`active` 可 `deactivate`/`disable` 后 `enable` 重新激活。
- **校验先于加载**：Manifest 非法或引擎不兼容的插件不会加载入口模块（`entry` 不会被调用）。
- **三层错误隔离**：激活异常（激活 try/catch）、命令异常（`execute` 返回 `CommandResult` 不抛出）、面板渲染异常（`PanelErrorBoundary`，可经边界直接禁用插件）。
- **资源代管**：`contribute()` 的贡献项、`context.events` 的订阅全部归入宿主代管集合，停用/卸载时统一释放；插件侧 `Disposable` 亦可提前释放。

## 架构决策

- `core` 不依赖 React（面板组件类型为 `ComponentType`，`react` 作为 peer dep），便于未来非 React 宿主复用运行时。
- `Manifest` 使用 zod 严格模式校验，未知字段直接拒绝；`id` 要求小写反向域名风格。
- 命令注册全局唯一；贡献项注册两阶段原子提交（整批校验 + 逆序回滚），失败不留下半注册状态。
- 命令上下文注入所属插件 `pluginId`，服务经惰性提供者解析（宿主构造完成后才冻结服务快照）。
- 插件激活为事务式：本次激活产生的资源暂存，成功后并入代管集合；失败或被并发停用取代时整体回滚，`failed` 插件可停用清理并可重新启用重试。
- 插件事件订阅经 `TrackedEventBridge` 归入插件代管集合，停用时自动移除，宿主总线不泄漏。
- vitest 通过 alias 直连各包源码；tsconfig 以 `paths` 做包间类型解析，构建时由各包独立打包。

## 不在本期范围

- 应用内 npm 包下载 / 市场（marketplace）/ 支付 / 自动更新 —— 本期插件通过宿主显式传入 `PluginDescriptor` 加载。
- **Worker/iframe 沙箱**：本期插件与宿主同进程运行，错误隔离靠状态机与边界组件实现；插件代码可信度要求高。已记录为架构演进项：未来将插件入口迁移到 Worker/iframe 沙箱以隔离任意代码执行。

## 已知限制

- 宿主 peer 依赖声明为 **React 19**（`@lumora/studio` / `@lumora/core` / `@lumora/plugin-sdk` 均为 `^19.0.0`），这是构建与 E2E 实际测试的版本边界；React 18 宿主不保证兼容。
- Playwright 断言使用真实 WebGL 渲染（headless 下由 Chromium SwiftShader 提供），场景内容以容器存在性验证为主。
