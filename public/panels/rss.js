// RSS panel: rotates through configured feeds. Each rotation triggers a
// fresh fetch (the rotator's onShow hook fires refreshRSS). Cross-fades the
// panel body + header around the innerHTML rewrite.

import { createRotator } from "../rotator.js";
import { bodyEl, escapeHtml, fetchJson, safeUrl, setUpdated, showError } from "../util/dom.js";

let rssIndex = 0;
let rssTotal = 1;
let rssRotationMs = 30 * 1000;
let rssFadeTimer = null;
let rssRotator = null;

export function setRssRotationMs(ms) { rssRotationMs = ms; }

// Default RSS icon: orange square with two arcs + dot, standard recognizable mark.
window.DEFAULT_RSS_ICON = `
<svg class="feed-logo feed-logo-default" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect width="24" height="24" rx="4" fill="#f26522"/>
  <circle cx="6.5" cy="17.5" r="2" fill="#fff"/>
  <path d="M4 4a16 16 0 0 1 16 16h-3A13 13 0 0 0 4 7z" fill="#fff"/>
  <path d="M4 10a10 10 0 0 1 10 10h-3a7 7 0 0 0-7-7z" fill="#fff"/>
</svg>`.trim();

function renderRSS(payload) {
  rssTotal = payload.total || 1;
  rssIndex = payload.index;
  const feedImageUrl = safeUrl(payload.feedImage);
  const logo = feedImageUrl
    ? `<img class="feed-logo" src="${escapeHtml(feedImageUrl)}" alt="" onerror="this.outerHTML=window.DEFAULT_RSS_ICON">`
    : window.DEFAULT_RSS_ICON;

  const rssPanel = document.getElementById("rss");
  const titleEl = document.getElementById("rss-title");
  const el = bodyEl("rss");

  // RSS uses the rotator with a synthetic "view per feed" set so dots/nav match
  // the count of feeds. We don't actually flip CSS classes — the body content
  // is rewritten on each feed swap.
  rssRotator.setViews(Array.from({length: rssTotal}, (_, i) => String(i)));

  const writeContent = () => {
    titleEl.innerHTML = `${logo}<span>${escapeHtml(payload.name)}</span>`;
    el.classList.remove("error");
    if (!payload.items || !payload.items.length) {
      el.innerHTML = '<p style="color: var(--text-muted)">No items.</p>';
      return;
    }
    el.innerHTML = `<ul class="rss-list">${
      payload.items.map(i => {
        const itemLink = safeUrl(i.link);
        const itemImage = safeUrl(i.image);
        return `
        <li class="rss-item">
          <a href="${escapeHtml(itemLink)}" target="_blank" rel="noopener">
            ${itemImage
              ? `<img class="rss-thumb" src="${escapeHtml(itemImage)}" alt="" loading="lazy" onerror="this.remove()">`
              : ""}
            <span class="rss-title">${escapeHtml(i.title)}</span>
          </a>
        </li>
      `;
      }).join("")
    }</ul>`;
  };

  // Cross-fade: dim the panel body + header, swap content, fade back in.
  if (rssFadeTimer) clearTimeout(rssFadeTimer);
  rssPanel.classList.add("fading");
  rssFadeTimer = setTimeout(() => {
    writeContent();
    requestAnimationFrame(() => rssPanel.classList.remove("fading"));
    rssFadeTimer = null;
  }, 200);
}

export async function refreshRSS() {
  try {
    const data = await fetchJson(`/api/rss?feed=${rssIndex}`);
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
  // active is a stringified feed index; only fetch if it differs from current.
  const target = Number(active);
  if (target === rssIndex) return;
  rssIndex = target;
  refreshRSS();
}

export function initRssRotator() {
  rssRotator = createRotator({
    dotsEl: document.getElementById("rss-dots"),
    navEl: document.getElementById("rss-nav"),
    views: ["0"],  // renderRSS expands once we know the feed count
    getRotationMs: () => rssRotationMs,
    onShow: onRssViewShown,
  });
  rssRotator.start();
  return rssRotator;
}
