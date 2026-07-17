"use client";

import { BellRing } from "lucide-react";
import { useState } from "react";

export default function NoticePreferences() {
  const [restored, setRestored] = useState(false);
  const restore = () => {
    try {
      localStorage.removeItem("guanchao:notice:daily:disabled");
      localStorage.removeItem("guanchao:notice:weekly:disabled");
    } catch {
      // Storage may be unavailable in strict privacy mode.
    }
    setRestored(true);
  };
  return <button className="notice-preferences" type="button" onClick={restore}><BellRing size={14} />{restored ? "提醒已恢复" : "恢复更新提醒"}</button>;
}
