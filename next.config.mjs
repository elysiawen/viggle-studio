/** @type {import('next').NextConfig} */
const nextConfig = {
  // httpcloak 依赖 koffi 原生 FFI，Prisma 依赖查询引擎二进制。
  // 两者必须作为外部包由 Node 运行时直接加载，不能被打包进 Route Handler。
  serverExternalPackages: ["httpcloak", "@prisma/client", "prisma", ".prisma/client"],
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
