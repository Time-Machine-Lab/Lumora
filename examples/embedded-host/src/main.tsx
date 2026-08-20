import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

// StrictMode 已启用：宿主运行时兼容 effect 卸载重放（启动只执行一次，
// 运行时在真实卸载时释放），开发环境下可提前暴露生命周期类问题。
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
