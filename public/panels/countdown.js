// Countdown view: shows days until the soonest configured upcoming date,
// or falls back to the most-recent past date if nothing upcoming.

let countdowns = [];

export function setCountdowns(list) {
  countdowns = Array.isArray(list) ? list : [];
}

export function hasCountdowns() {
  return countdowns.length > 0;
}

function pickCountdown() {
  if (!countdowns.length) return null;
  const now = new Date();
  const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  // Compare midnight-anchored dates to avoid DST / hour-of-day drift.
  const annotated = countdowns.map(c => {
    const [y, m, d] = c.date.split("-").map(Number);
    const days = Math.round((Date.UTC(y, m - 1, d) - todayUtc) / 86400000);
    return { ...c, days };
  });
  const upcoming = annotated.filter(c => c.days >= 0).sort((a, b) => a.days - b.days);
  if (upcoming.length) return upcoming[0];
  return annotated.sort((a, b) => b.days - a.days)[0];
}

export function renderCountdown() {
  const numEl = document.querySelector("#weather .countdown-number");
  const labelEl = document.querySelector("#weather .countdown-label");
  if (!numEl || !labelEl) return;

  const c = pickCountdown();
  if (!c) {
    numEl.textContent = "";
    labelEl.textContent = "No countdowns configured";
    return;
  }

  if (c.days === 0) {
    numEl.textContent = "Today";
    labelEl.textContent = `is ${c.title}`;
  } else if (c.days > 0) {
    numEl.textContent = `${c.days} ${c.days === 1 ? "day" : "days"}`;
    labelEl.textContent = `until ${c.title}`;
  } else {
    numEl.textContent = c.title;
    labelEl.textContent = "is past, what's next?";
  }
}
