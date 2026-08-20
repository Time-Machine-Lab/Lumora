// 仅测试使用：vitest 以 node 环境运行，node:fs 运行时可用。
// studio tsconfig 的 types 限定为 vite/client（不引入 @types/node），
// 这里给出测试所需的最小签名，供类型检查使用。
declare module 'node:fs' {
  export function readFileSync(path: string | URL): Uint8Array;
}
