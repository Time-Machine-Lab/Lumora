import { createRoot } from 'react-dom/client';
import App from './App';

// 注意：未启用 StrictMode —— 宿主运行时在 dev 双挂载下会被复用已销毁实例，
// 属于已知限制（见 README「已知限制」），生产模式无此问题。
createRoot(document.getElementById('root')!).render(<App />);
