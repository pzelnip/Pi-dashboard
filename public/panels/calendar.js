// Calendar view: today's events, rendered inside the weather panel. Shares
// the panel header's "X ago" label, which is why refreshCalendar calls
// setUpdated("weather").

import { escapeHtml, fetchJson, setUpdated } from "../util/dom.js";
import { formatTime } from "../util/time.js";

function renderCalendar(data) {
  const el = document.querySelector("#weather .view-calendar");
  el.classList.remove("error");

  if (data.error) {
    el.innerHTML = `<p class="cal-empty">⚠ ${escapeHtml(data.error)}</p>`;
    return;
  }
  if (!data.events || !data.events.length) {
    el.innerHTML = '<p class="cal-empty">No events today</p>';
    return;
  }

  const isDateOnly = ev => typeof ev.start === "string" && ev.start.length === 10;
  const timeLabel = ev => (ev.allDay || isDateOnly(ev)) ? "All day" : formatTime(ev.start);

  el.innerHTML = data.events.map(ev => `
    <div class="cal-event ${ev.allDay ? "cal-allday" : ""}">
      <span class="cal-time">${escapeHtml(timeLabel(ev))}</span>
      <span class="cal-title">${escapeHtml(ev.summary)}</span>
    </div>
  `).join("");
}

export async function refreshCalendar() {
  try {
    const data = await fetchJson("/api/calendar");
    renderCalendar(data);
    setUpdated("weather");
  } catch (e) {
    renderCalendar({ error: e.message });
  }
}
