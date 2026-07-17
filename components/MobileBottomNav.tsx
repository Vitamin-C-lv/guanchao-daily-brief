import { Activity, Flame, Home, Landmark, Newspaper } from "lucide-react";
import Link from "next/link";

export type MobileNavView = "overview" | "fed" | "markets" | "briefs" | "hotspots";

const items = [
  { href: "/", label: "总览", icon: Home, view: "overview" },
  { href: "/fed", label: "美联储", icon: Landmark, view: "fed" },
  { href: "/markets", label: "市场", icon: Activity, view: "markets" },
  { href: "/briefs", label: "简报", icon: Newspaper, view: "briefs" },
  { href: "/hotspots", label: "热点", icon: Flame, view: "hotspots" },
] as const;

export default function MobileBottomNav({ active }: { active: MobileNavView }) {
  return (
    <nav className="mobile-bottom-nav" aria-label="手机导航">
      {items.map((item) => {
        const Icon = item.icon;
        const isActive = active === item.view;
        return (
          <Link key={item.href} href={item.href} aria-current={isActive ? "page" : undefined}>
            <Icon size={19} />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
