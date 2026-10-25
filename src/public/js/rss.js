// News panel: RSS pages, fades and new-story highlights.

// ---------- RSS ----------

let rssPage = 0;
let rssTotalPages = 1;
let rssRotationMs = 30 * 1000;
// Cross-fade length between views, in ms (the RSS fade-out/in is half that
// each way). A visual-effects setting: see "Visual effects" below.
let fadeMs = 400;
let rssFadeTimer = null;
let rssRotator = null;

// Default RSS icon: orange square with two arcs + dot, standard recognizable mark.
window.DEFAULT_RSS_ICON = `
<svg class="feed-logo feed-logo-default" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect width="24" height="24" rx="4" fill="#f26522"/>
  <circle cx="6.5" cy="17.5" r="2" fill="#fff"/>
  <path d="M4 4a16 16 0 0 1 16 16h-3A13 13 0 0 0 4 7z" fill="#fff"/>
  <path d="M4 10a10 10 0 0 1 10 10h-3a7 7 0 0 0-7-7z" fill="#fff"/>
</svg>`.trim();

// Age-tint tier for an item background: fresh (<6h) → today (<24h) →
// aging (<72h) → old. Unknown age (no parseable date) gets no tint.
function rssAgeClass(ageHours) {
  if (ageHours == null) return "";
  if (ageHours < 6) return " rss-item-tinted rss-age-fresh";
  if (ageHours < 24) return " rss-item-tinted rss-age-today";
  if (ageHours < 72) return " rss-item-tinted rss-age-aging";
  return " rss-item-tinted rss-age-old";
}

// Compact "X ago" label for a story, from its age in hours (may be fractional
// for very recent items). Reuses formatAgo by converting hours → ms. Returns ""
// when the age is unknown so the meta slot is simply omitted.
function rssAgeLabel(ageHours) {
  if (ageHours == null || Number.isNaN(ageHours)) return "";
  return formatAgo(ageHours * 3600 * 1000);
}

function renderRSS(payload) {
  rssTotalPages = payload.totalPages || 1;
  rssPage = payload.page;

  const rssPanel = document.getElementById("rss");
  const titleEl = document.getElementById("rss-title");
  const el = bodyEl("rss");

  // RSS uses the rotator with a synthetic "view per page" set so dots/nav match
  // the count of pages. We don't actually flip CSS classes — the body content
  // is rewritten on each page swap.
  rssRotator.setViews(Array.from({length: rssTotalPages}, (_, i) => String(i)));

  const writeContent = () => {
    titleEl.innerHTML = `${window.DEFAULT_RSS_ICON}<span>News</span>`;
    el.classList.remove("error");
    if (!payload.items || !payload.items.length) {
      el.innerHTML = '<p style="color: var(--text-muted)">No items.</p>';
      return;
    }
    // New-story highlights: decided as the page is shown, so "new" means
    // "first time on this screen".
    const newStories = takeNewStories(payload.items.filter(i => !i.stale));
    if (newStories.size) {
      titleEl.classList.remove("fx-news-arrived");
      void titleEl.offsetWidth;
      titleEl.classList.add("fx-news-arrived");
    }
    el.innerHTML = `<ul class="rss-list">${
      payload.items.map(i => {
        const feedImageUrl = safeUrl(i.feedImage);
        const itemLogo = feedImageUrl
          ? `<img class="rss-item-feed-logo" src="${escapeHtml(feedImageUrl)}" alt="" onerror="this.remove()">`
          : "";
        // Stale feed (30+ days since newest article): a glaring warning
        // entry stands in for the feed's oldest story (already dropped
        // server-side), ahead of its remaining (still-rendered) items.
        if (i.stale) {
          return `
        <li class="rss-item rss-item-stale">
          <span class="rss-title">
            <span class="rss-item-source">${itemLogo}<span class="rss-item-feed-name">${escapeHtml(i.feedName || "")}</span> &mdash;</span>${escapeHtml(i.title)}
          </span>
        </li>
      `;
        }
        const itemLink = safeUrl(i.link);
        const itemImage = safeUrl(i.image);
        const tooltip = i.published ? `Published: ${escapeHtml(i.published)}` : "";
        // Meta line under the headline: "X ago" plus a ⚡ "hot" bolt for fresh stories
        // (< 6h). The age tint class on the <li> already conveys freshness in
        // colour; the explicit label + bolt make it read at a glance the way
        // the mockup's timestamps do.
        const ageLabel = rssAgeLabel(i.ageHours);
        const isFresh = i.ageHours != null && i.ageHours < 6;
        const meta = ageLabel
          ? `<span class="rss-item-meta">
              <span class="rss-age">${escapeHtml(ageLabel)}</span>
              ${isFresh ? `<span class="rss-bolt" aria-hidden="true">⚡</span>` : ""}
            </span>`
          : "";
        const isNew = newStories.has(storyKey(i));
        return `
        <li class="rss-item${i.aged ? " rss-item-aged" : rssAgeClass(i.ageHours)}${isNew ? " fx-new-story" : ""}">
          <a href="${escapeHtml(itemLink)}" target="_blank" rel="noopener"${tooltip ? ` title="${tooltip}"` : ""}>
            ${itemImage
              ? `<img class="rss-thumb" src="${escapeHtml(itemImage)}" alt="" loading="lazy" onerror="this.remove()">`
              : ""}
            <span class="rss-text">
              <span class="rss-title">
                <span class="rss-item-source">${itemLogo}<span class="rss-item-feed-name">${escapeHtml(i.feedName || "")}</span> &mdash;</span>${escapeHtml(i.title)}
              </span>
              ${meta}
            </span>
          </a>
        </li>
      `;
      }).join("")
    }</ul>`;
  };

  const rssFadeMs = Math.round(fadeMs / 2);
  if (rssFadeMs === 0) {
    writeContent();
    return;
  }

  // Cross-fade: dim the panel body + header, swap content, fade back in.
  if (rssFadeTimer) clearTimeout(rssFadeTimer);
  rssPanel.classList.add("fading");
  rssFadeTimer = setTimeout(() => {
    writeContent();
    requestAnimationFrame(() => rssPanel.classList.remove("fading"));
    rssFadeTimer = null;
  }, rssFadeMs);
}

async function refreshRSS() {
  try {
    const data = await fetchJson(`/api/rss?page=${rssPage}`);
    if (data.error) {
      showError("rss", data.error);
    } else {
      renderRSS(data);
    }
    setUpdated("rss");
  } catch (e) {
    showError("rss", e.message);
  }
}

function onRssViewShown(active) {
  // active is a stringified page index; only fetch if it differs from current.
  const target = Number(active);
  if (target === rssPage) return;
  rssPage = target;
  refreshRSS();
}
