"use client";

import { ShieldCheck } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { isDesktopNavigationActive, sidebarNavItems } from "@/lib/site-navigation";

export default function DesktopSidebar() {
  const pathname = usePathname();
  return (
    <aside className="sidebar" aria-label="主导航">
      <nav>
        {sidebarNavItems.map((item) => {
          const Icon = item.icon;
          const isActive = isDesktopNavigationActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-label={item.label}
              aria-current={isActive ? "page" : undefined}
              data-tooltip={item.label}
            >
              <Icon size={19} />
            </Link>
          );
        })}
      </nav>
      <div className="sidebar-foot"><ShieldCheck size={18} /><span>来源可追溯</span></div>
    </aside>
  );
}
