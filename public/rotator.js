// Rotator: owns the index, timer, dots/nav, and active-view CSS class for one
// rotating panel. Each panel calls createRotator once; setViews() can be
// called later to swap the active set (e.g. NHL switching between today-only
// and today/yesterday).

export function createRotator({ dotsEl, navEl, viewsContainer, viewClassPrefix, titleEl, titles, views, getRotationMs, onShow }) {
  let currentViews = views.slice();
  let index = 0;
  let timer = null;

  const wrap = i => ((i % currentViews.length) + currentViews.length) % currentViews.length;

  function renderControls() {
    const count = currentViews.length;
    if (dotsEl) {
      dotsEl.innerHTML = count > 1
        ? Array.from({length: count}, (_, i) =>
            `<button class="rot-dot ${i === index ? 'active' : ''}" data-rot-index="${i}" aria-label="View ${i + 1}"></button>`
          ).join("")
        : "";
      dotsEl.querySelectorAll(".rot-dot").forEach(btn => {
        btn.addEventListener("click", () => jumpTo(Number(btn.dataset.rotIndex)));
      });
    }
    if (navEl) {
      navEl.innerHTML = count > 1
        ? `<button class="rot-nav" data-rot-step="-1" aria-label="Previous">‹</button>
           <button class="rot-nav" data-rot-step="1" aria-label="Next">›</button>`
        : "";
      navEl.querySelectorAll(".rot-nav").forEach(btn => {
        const step = Number(btn.dataset.rotStep);
        btn.addEventListener("click", () => jumpTo(index + step));
      });
    }
  }

  function applyActiveView() {
    const active = currentViews[index];
    if (viewsContainer) {
      viewsContainer.querySelectorAll(".view").forEach(v => {
        v.classList.toggle("active", v.classList.contains(`${viewClassPrefix}${active}`));
      });
    }
    if (titleEl && titles) {
      titleEl.textContent = titles[active] ?? "";
    }
    if (dotsEl) {
      dotsEl.querySelectorAll(".rot-dot").forEach((btn, i) => {
        btn.classList.toggle("active", i === index);
      });
    }
    if (onShow) onShow(active);
  }

  function showView(i) {
    index = wrap(i);
    applyActiveView();
  }

  function jumpTo(i) {
    if (wrap(i) === index) return;
    showView(i);
    startTimer();
  }

  function rotate() { showView(index + 1); }

  function startTimer() {
    stopTimer();
    if (currentViews.length > 1) {
      timer = setInterval(rotate, getRotationMs());
    }
  }

  function stopTimer() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function setViews(newViews) {
    const wasActive = currentViews[index];
    currentViews = newViews.slice();
    const reuseIdx = currentViews.indexOf(wasActive);
    index = reuseIdx >= 0 ? reuseIdx : 0;
    renderControls();
    applyActiveView();
    startTimer();
  }

  function start() {
    renderControls();
    applyActiveView();
    startTimer();
  }

  return { start, setViews, jumpTo, rotate, getIndex: () => index };
}
