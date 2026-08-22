import '@testing-library/jest-dom/vitest';
// jsdom 不提供 IndexedDB：测试环境注入 fake-indexeddb 以便 ProjectStore 单测
import 'fake-indexeddb/auto';
