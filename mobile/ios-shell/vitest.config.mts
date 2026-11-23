import { defineConfig } from "vitest/config"

// 壳自己的前端测试（新窗口脚本，以后还有启动页）。根目录的 vitest 只收 src/ 下的测试，
// 这里单独跑：在仓库根目录 `pnpm exec vitest run --root mobile/ios-shell`。
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "launcher/**/*.test.ts"],
  },
})
