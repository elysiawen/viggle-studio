/** @type {import('next').NextConfig} */
const nextConfig = {
  // httpcloak 依赖 koffi 原生 FFI，Prisma 依赖查询引擎二进制，
  // ffmpeg/ffprobe 是随包安装的可执行文件：都必须由 Node 运行时直接加载，
  // 不能被打包进 Route Handler。
  serverExternalPackages: [
    "httpcloak",
    "@prisma/client",
    "prisma",
    ".prisma/client",
    "sharp",
  ],
  // standalone 产物默认只追踪被 import 的 JS，需显式带上原生依赖。
  outputFileTracingIncludes: {
    "/**/*": ["./node_modules/sharp/**", "./node_modules/@img/**"],
  },
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
