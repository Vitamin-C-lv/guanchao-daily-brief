import { Activity, Flame, Home, Link as LinkIcon, Newspaper, Target } from "lucide-react";

export type DesktopNavigationView = "overview" | "predictions" | "markets" | "briefs" | "hotspots" | "sources";

export const desktopNavItems = [
  { href: "/", label: "总览", icon: Home, view: "overview" },
  { href: "/predictions", label: "预测排行", icon: Target, view: "predictions" },
  { href: "/markets", label: "三地市场", icon: Activity, view: "markets" },
  { href: "/briefs", label: "简报", icon: Newspaper, view: "briefs" },
  { href: "/hotspots", label: "热点", icon: Flame, view: "hotspots" },
] as const;

export const sidebarNavItems = [
  ...desktopNavItems,
  { href: "/#sources", label: "来源", icon: LinkIcon, view: "sources" },
] as const;

export function normalizePathname(pathname: string) {
  return pathname === "/" ? pathname : pathname.replace(/\/+$/, "");
}

export function isDesktopNavigationActive(pathname: string, href: string) {
  const normalizedPathname = normalizePathname(pathname);
  if (href === "/") return normalizedPathname === "/";
  if (href === "/#sources") return false;
  return normalizedPathname === href || normalizedPathname.startsWith(`${href}/`);
}
