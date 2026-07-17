"use client";

import { ArrowRight, BellRing, CalendarDays, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { UpdateNoticeItem, UpdateNotices } from "@/lib/types";

const seenKey = (notice: UpdateNoticeItem) => `guanchao:notice:${notice.kind}:seen:${notice.noticeId}`;
const disabledKey = (kind: UpdateNoticeItem["kind"]) => `guanchao:notice:${kind}:disabled`;

function isCurrent(notice: UpdateNoticeItem, now: number) {
  if (!notice.expiresAt) return true;
  const expiresAt = Date.parse(notice.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

export default function UpdateNotice() {
  const [notice, setNotice] = useState<UpdateNoticeItem | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let controller: AbortController | null = null;
    let revealTimer: number | null = null;
    let disposed = false;

    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch(`/update-notices.json?t=${Date.now()}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) return;
        const data = await response.json() as UpdateNotices;
        const candidates = [data.weekly, data.daily].filter((item): item is UpdateNoticeItem => Boolean(item));
        const next = candidates.find((item) => {
          if (!isCurrent(item, Date.now())) return false;
          try {
            return localStorage.getItem(disabledKey(item.kind)) !== "1" && localStorage.getItem(seenKey(item)) !== "1";
          } catch {
            return true;
          }
        });
        if (next) {
          if (revealTimer !== null) window.clearTimeout(revealTimer);
          revealTimer = window.setTimeout(() => {
            if (!disposed) setNotice((current) => current ?? next);
          }, 450);
        }
      } catch {
        // Update notices are optional; the site remains usable offline.
      }
    };

    const loadWhenVisible = () => {
      if (document.visibilityState === "visible") load();
    };

    load();
    window.addEventListener("focus", load);
    window.addEventListener("pageshow", load);
    document.addEventListener("visibilitychange", loadWhenVisible);
    return () => {
      disposed = true;
      controller?.abort();
      if (revealTimer !== null) window.clearTimeout(revealTimer);
      window.removeEventListener("focus", load);
      window.removeEventListener("pageshow", load);
      document.removeEventListener("visibilitychange", loadWhenVisible);
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismissCurrent();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notice]);

  const remember = (key: string) => {
    try {
      localStorage.setItem(key, "1");
    } catch {
      // Some privacy modes block storage; closing still works for this visit.
    }
  };

  const dismissCurrent = () => {
    if (notice) remember(seenKey(notice));
    setNotice(null);
  };

  const disableKind = () => {
    if (!notice) return;
    remember(disabledKey(notice.kind));
    remember(seenKey(notice));
    setNotice(null);
  };

  if (!notice) return null;

  return (
    <div className="update-notice-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) dismissCurrent();
    }}>
      <section className={`update-notice update-notice-${notice.kind}`} role="dialog" aria-modal="true" aria-labelledby="update-notice-title" aria-describedby="update-notice-summary">
        <button ref={closeButtonRef} className="update-notice-close" type="button" onClick={dismissCurrent} aria-label="关闭本期提醒"><X size={17} /></button>
        <div className="update-notice-kicker">
          {notice.kind === "weekly" ? <CalendarDays size={15} /> : <BellRing size={15} />}
          {notice.kind === "weekly" ? "WEEKLY UPDATE" : "IMPORTANT DAILY UPDATE"}
        </div>
        <h2 id="update-notice-title">{notice.title}</h2>
        <p id="update-notice-summary">{notice.summary}</p>
        <ul>{notice.highlights.map((item) => <li key={item}>{item}</li>)}</ul>
        <div className="update-notice-actions">
          <Link href={notice.href} onClick={dismissCurrent}>{notice.ctaLabel}<ArrowRight size={14} /></Link>
          <button type="button" onClick={disableKind}>不再提醒此类更新</button>
        </div>
        <small>{notice.kind === "weekly" ? "关闭后本期不再弹出；未来新周报仍会提醒。" : "只在当天确有重大新闻时出现。"}</small>
      </section>
    </div>
  );
}
