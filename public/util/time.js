// Time / date formatters.
//
// All formatters pin "en-US" + hour12: true. The Pi's system locale renders
// 24-hour by default, so calling toLocaleTimeString() with no args (or with
// []) produces "20:03" on the deployed device but "8:03 PM" on a Mac dev
// machine — silent regression. Always go through these helpers.

export const TIME_FMT = { hour: "numeric", minute: "2-digit", hour12: true };

export const formatTime = d => new Date(d).toLocaleTimeString("en-US", TIME_FMT);

export function ordinalSuffix(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return "th";
  switch (n % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}

export function formatAgo(ms) {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatUptime(ms) {
  // Live-counting friendly: rightmost unit always changes each second so
  // the user can see the panel is alive.
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600) % 24;
  const d = Math.floor(total / 86400);
  const pad = n => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${h}h ${pad(m)}m ${pad(s)}s`;
  if (h > 0) return `${h}h ${pad(m)}m ${pad(s)}s`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}
