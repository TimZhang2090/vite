调试步骤：

0. 根目录，重新安装 pnpm i

1. cd ./packages/vite
2. 运行 pnpm run dev, 监听模式编译 vite 源码
   pnpm run --filter vite dev

3. 新建一个 JavaScript Debug Terminal 控制台
4. cd ./playground/alias 进入一个调试示例
5. 运行 pnpm run dev
   pnpm run --filter @vitejs/test-alias dev
