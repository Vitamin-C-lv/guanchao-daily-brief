import type { Metadata, Viewport } from "next";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";
import UpdateNotice from "@/components/UpdateNotice";
import "./globals.css";

export const metadata: Metadata = {
  title: "观潮 · 每日早报与每周情报",
  description: "每日与每周 AI 精选的美联储政策、A 股、港股、美股与财经热点。",
  manifest: "/manifest.webmanifest",
  icons: [{ rel: "icon", url: "/favicon.svg", type: "image/svg+xml" }],
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "观潮简报",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: "#f1edf5",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body><ServiceWorkerRegister />{children}<UpdateNotice /></body>
    </html>
  );
}
