pnpm run --filter vite dev
pnpm run --filter @vitejs/test-alias dev

调试步骤：

0. 根目录，重新安装 pnpm i

1. cd ./packages/vite
2. 运行 pnpm run dev, 监听模式编译 vite 源码
   pnpm run --filter vite dev

3. 新建一个 JavaScript Debug Terminal 控制台
4. cd ./playground/alias 进入一个调试示例
5. 运行 pnpm run dev
   pnpm run --filter @vitejs/test-resolve-config dev

集成测试
测试某个 playground 下的测试用例
pnpm test-serve resolve-config
pnpm test-build resolve-config
会运行：
`VITE_TEST_BUILD=1 vitest run -c vitest.config.e2e.ts "resolve-config"`

单元测试
pnpm run test-unit
runs unit tests under each package.
pnpm run test-unit [match]
runs tests in specific packages that match the given filter.
