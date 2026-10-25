// Rotator: the view rotation, dots and prev/next controls shared by every panel.

// ---------- Rotator ----------
// Owns the index, timer, dots/nav, and active-view CSS class for one rotating
// panel. Each panel calls createRotator once; setViews() can be called later
// to swap the active set (e.g. NHL switching between today-only and today/yesterday).
function createRotator({ dotsEl, navEl, viewsContainer, viewClassPrefix, titleEl, titles, views, getRotationMs, onShow, swipeEl }) {
  let currentViews = views.slice();
  let index = 0;
  let timer = null;

  const wrap = i => ((i % currentViews.length) + currentViews.length) % currentViews.length;

  // Touch swipe: left swipe -> next, right swipe -> previous. Mirrors the
  // .rot-nav button behavior so all controls share one code path via jumpTo.
  // Thresholds: X delta must exceed 40px and be at least 1.5x the Y delta
  // (axis-dominance check) to count as a horizontal swipe — otherwise it's
  // treated as a vertical scroll and ignored.
  if (swipeEl) {
    const SWIPE_MIN_X = 40;
    const SWIPE_AXIS_RATIO = 1.5;
    let touchStartX = null;
    let touchStartY = null;
    let touchActive = false;

    swipeEl.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) { touchActive = false; return; }
      const t = e.touches[0];
      touchStartX = t.clientX;
      touchStartY = t.clientY;
      touchActive = true;
    }, { passive: true });

    swipeEl.addEventListener("touchmove", (e) => {
      if (!touchActive || touchStartX == null) return;
      const t = e.touches[0];
      const dx = t.clientX - touchStartX;
      const dy = t.clientY - touchStartY;
      // Cancel the gesture once a clear vertical scroll dominates — keeps
      // page scrolling responsive and avoids a swipe firing after a scroll.
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > SWIPE_MIN_X) {
        touchActive = false;
      }
    }, { passive: true });

    swipeEl.addEventListener("touchend", (e) => {
      const wasActive = touchActive && touchStartX != null;
      const startX = touchStartX;
      const startY = touchStartY;
      touchActive = false;
      touchStartX = null;
      touchStartY = null;
      if (!wasActive) return;
      if (e.changedTouches.length === 0) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (Math.abs(dx) < SWIPE_MIN_X) return;
      if (Math.abs(dx) < Math.abs(dy) * SWIPE_AXIS_RATIO) return;
      if (currentViews.length < 2) return;
      // Left swipe (dx < 0) -> next; right swipe (dx > 0) -> previous.
      jumpTo(index + (dx < 0 ? 1 : -1));
    }, { passive: true });

    swipeEl.addEventListener("touchcancel", () => {
      touchActive = false;
      touchStartX = null;
      touchStartY = null;
    }, { passive: true });
  }

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
        const isActive = v.classList.contains(`${viewClassPrefix}${active}`);
        // Staggered-entrance effect: .fx-enter replays the CSS entrance on the
        // view's cards, then comes off so later re-renders don't replay it.
        if (fxOn.stagger && isActive && !v.classList.contains("active")) {
          v.classList.remove("fx-enter");
          void v.offsetWidth;
          v.classList.add("fx-enter");
          clearTimeout(v._fxEnterTimer);
          v._fxEnterTimer = setTimeout(() => v.classList.remove("fx-enter"), 1200);
        }
        v.classList.toggle("active", isActive);
      });
    }
    if (titleEl && titles) {
      titleEl.textContent = titles[active] ?? "";
    }
    if (dotsEl) {
      dotsEl.querySelectorAll(".rot-dot").forEach((btn, i) => {
        btn.classList.toggle("active", i === index);
      });
      // Rotation-progress effect: a bar under the dots fills over the rotation
      // period. Every caller of applyActiveView (re)starts the timer right
      // after, so restarting the bar here keeps the two in step.
      dotsEl.classList.remove("rot-run");
      if (fxOn.progress && currentViews.length > 1) {
        dotsEl.style.setProperty("--rot-period", `${getRotationMs()}ms`);
        void dotsEl.offsetWidth;
        dotsEl.classList.add("rot-run");
      }
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

  // An unchanged list keeps the controls, timer and progress bar running and
  // only re-marks the active view, in case its element was just re-created
  // (NHL re-paging replaces its page elements).
  function setViews(newViews) {
    if (sameList(newViews, currentViews)) {
      const active = currentViews[index];
      viewsContainer?.querySelectorAll(".view").forEach(v => {
        v.classList.toggle("active", v.classList.contains(`${viewClassPrefix}${active}`));
      });
      return;
    }
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
