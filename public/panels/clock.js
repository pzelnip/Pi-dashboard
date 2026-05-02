// Clock view: live wall clock + ordinal-suffixed date. Built manually in
// en-US (rather than via toLocaleDateString without a locale) so the kiosk's
// system locale doesn't render 24-hour time.

import { formatTime, ordinalSuffix } from "../util/time.js";

export function renderClock() {
  const now = new Date();
  const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
  const month = now.toLocaleDateString("en-US", { month: "long" });
  const day = now.getDate();
  const year = now.getFullYear();
  const date = `${weekday}, ${month} ${day}${ordinalSuffix(day)}, ${year}`;
  const timeEl = document.querySelector("#weather .clock-time");
  const dateEl = document.querySelector("#weather .clock-date");
  if (timeEl) timeEl.textContent = formatTime(now);
  if (dateEl) dateEl.textContent = date;
}
