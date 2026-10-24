// Self-contained Conversation Minimap widget inside Shadow DOM.
module.exports = function installAgMinimapWidget() {
  if (window.__agMinimapInstalled) return;
  if (!document.documentElement) {
    document.addEventListener('DOMContentLoaded', installAgMinimapWidget, { once: true });
    return;
  }
  window.__agMinimapInstalled = true;

  const HOST_ID = 'ag-minimap-host';
  const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  let hostEl = null;
  let shadow = null;
  let disposed = false;
  let pinned = false;
  let drawerOpen = false;
  let hoverOpenTimer = null;
  let hoverCloseTimer = null;

  let currentCid = null;
  let turnsList = []; // [{ turnIndex, startStepIndex, timestampMs, prompt, loadedInDom }]
  let activeStepIndex = null;
  let jumpingStepIndex = null;
  const promptCache = new Map(); // `${cid}:${stepIndex}` -> { prompt, timestampMs }
  const pendingFetches = new Set();

  function cleanPromptText(raw) {
    if (!raw || typeof raw !== 'string') return '';
    let s = raw
      .replace(/<USER_REQUEST>\s*/gi, '')
      .replace(/\s*<\/USER_REQUEST>[\s\S]*$/gi, '')
      .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
      .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
      .trim();
    return s.replace(/\s+/g, ' ');
  }

  function formatTime(ms) {
    if (!ms || !Number.isFinite(Number(ms))) return '';
    const d = new Date(Number(ms));
    if (Number.isNaN(d.getTime())) return '';
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    ) {
      return hm;
    }
    return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${hm}`;
  }

  function findFiberKey(el) {
    if (!el) return null;
    for (const k of Object.keys(el)) {
      if (k.startsWith('__reactFiber$')) return k;
    }
    return null;
  }

  function getViewport() {
    const vps = [...document.querySelectorAll('[data-testid="autoscroll-viewport"]')];
    return vps.find(el => {
      const r = el.getBoundingClientRect();
      return r.width > 120 && r.height > 120 && getComputedStyle(el).visibility !== 'hidden';
    }) || null;
  }

  function getReactControllers(vp) {
    if (!vp) return null;
    const list = vp.querySelector('.flex-col.gap-y-3') || vp;
    const fk = findFiberKey(list) || findFiberKey(vp);
    if (!fk) return null;
    let cur = list[fk] || vp[fk];
    let z6b = null;
    let c7b = null;
    for (let i = 0; i < 30 && cur; i++, cur = cur.return) {
      const p = cur.memoizedProps;
      if (p) {
        if (!z6b && p.paginationRef && p.trajectorySlice) z6b = cur;
        if (!c7b && p.fetchTurns && Array.isArray(p.turns)) c7b = cur;
      }
    }
    return { fk, z6b, c7b };
  }

  function getDomUserStepMap(vp, fk) {
    const map = new Map(); // stepIndex -> { el, prompt, timestampMs }
    if (!vp) return map;
    const steps = vp.querySelectorAll('[data-testid="user-input-step"]');
    for (const el of steps) {
      const key = fk || findFiberKey(el);
      let stepIndex = null;
      let prompt = '';
      let timestampMs = null;
      if (key && el[key]) {
        let f = el[key];
        for (let i = 0; i < 6 && f; i++, f = f.return) {
          const mp = f.memoizedProps;
          if (mp?.metadata?.sourceTrajectoryStepInfo?.stepIndex !== undefined) {
            stepIndex = Number(mp.metadata.sourceTrajectoryStepInfo.stepIndex);
            const sec = mp.metadata?.createdAt?.seconds;
            if (sec !== undefined) timestampMs = Number(sec) * 1000;
            if (mp.step?.userResponse) {
              prompt = cleanPromptText(mp.step.userResponse);
            } else if (Array.isArray(mp.step?.items)) {
              prompt = cleanPromptText(
                mp.step.items
                  .map(it => (it?.chunk?.case === 'text' ? it.chunk.value : ''))
                  .join(' ')
              );
            }
            break;
          }
        }
      }
      if (!prompt) {
        const bubble = el.querySelector('[data-testid="user-message-bubble"]');
        if (bubble) {
          const lines = (bubble.innerText || '').trim().split(/\r?\n/);
          if (lines.length > 1 && /^\d{1,2}:\d{2}$/.test(lines.at(-1).trim())) lines.pop();
          prompt = cleanPromptText(lines.join(' '));
        }
      }
      if (stepIndex !== null && Number.isFinite(stepIndex)) {
        const sectionEl =
          el.closest('.scroll-mt-4')?.parentElement ||
          el.closest('.scroll-mt-4') ||
          el.closest('.flex.items-start') ||
          el;
        map.set(stepIndex, { el, sectionEl, prompt, timestampMs });
      }
    }
    return map;
  }

  function detectConversationId(c7b) {
    const m = location.pathname.match(/\/c\/([0-9a-f-]{36})/i);
    if (m && GUID.test(m[1])) return m[1];
    if (c7b?.memoizedProps?.conversationId && GUID.test(c7b.memoizedProps.conversationId)) {
      return c7b.memoizedProps.conversationId;
    }
    return null;
  }

  function isControllerMatchingCid(ctrls, cid) {
    if (!cid || !ctrls) return false;
    const c7bCid = ctrls.c7b?.memoizedProps?.conversationId;
    const sliceCid =
      ctrls.z6b?.memoizedProps?.trajectorySlice?.conversationId ||
      ctrls.c7b?.memoizedProps?.trajectorySlice?.conversationId;
    if (c7bCid && c7bCid !== cid) return false;
    if (sliceCid && sliceCid !== cid) return false;
    return Boolean(c7bCid === cid || sliceCid === cid);
  }

  let searchQuery = '';

  async function fetchMissingPrompts(cid, c7b, missingIndices) {
    if (!cid || !missingIndices.length) return;
    if (c7b?.memoizedProps?.conversationId && c7b.memoizedProps.conversationId !== cid) return;
    const batchSlice = missingIndices.slice(0, 40);
    const batchKey = `${cid}:${batchSlice.join(',')}`;
    if (pendingFetches.has(batchKey)) return;
    pendingFetches.add(batchKey);
    try {
      const fetchFn = c7b?.memoizedProps?.fetchTurns;
      // For very large histories (> 50 missing turns), reading transcript.jsonl once via host is faster than many RPCs
      if (missingIndices.length > 50 && window.agMinimapHost?.getTranscriptTurns) {
        const res = await window.agMinimapHost.getTranscriptTurns({ conversationId: cid });
        for (const item of res?.turns || []) {
          promptCache.set(`${cid}:${item.startStepIndex}`, {
            prompt: cleanPromptText(item.prompt),
            timestampMs: item.timestampMs || null,
          });
        }
      } else if (typeof fetchFn === 'function') {
        const res = await fetchFn({
          conversationId: cid,
          stepIndices: batchSlice,
        });
        const fetched = res?.turns || [];
        for (const item of fetched) {
          const idx = Number(item.startStepIndex);
          const stepVal = item.firstStep?.step?.value;
          let text = stepVal?.userResponse || '';
          if (!text && Array.isArray(stepVal?.items)) {
            text = stepVal.items
              .map(it => (it?.chunk?.case === 'text' ? it.chunk.value : ''))
              .join(' ');
          }
          const cleaned = cleanPromptText(text);
          const sec = item.firstStep?.metadata?.createdAt?.seconds;
          const ts = sec !== undefined ? Number(sec) * 1000 : null;
          if (cleaned) {
            promptCache.set(`${cid}:${idx}`, { prompt: cleaned, timestampMs: ts });
          }
        }
      } else if (window.agMinimapHost?.getTranscriptTurns) {
        const res = await window.agMinimapHost.getTranscriptTurns({ conversationId: cid });
        for (const item of res?.turns || []) {
          promptCache.set(`${cid}:${item.startStepIndex}`, {
            prompt: cleanPromptText(item.prompt),
            timestampMs: item.timestampMs || null,
          });
        }
      }
    } catch {} finally {
      pendingFetches.delete(batchKey);
      refreshTurnsState();
    }
  }

  function updateActiveStepFromScroll(vp, domMap) {
    if (!vp || !turnsList.length || !domMap || domMap.size === 0) return;
    if (Date.now() < suppressScrollSyncUntil) return;
    const vpRect = vp.getBoundingClientRect();
    const sorted = [...domMap.entries()].sort((a, b) => a[0] - b[0]);

    // Check if scrolled to the very bottom of the viewport
    const distFromBottom = vp.scrollHeight - (vp.scrollTop + vp.clientHeight);
    const isAtBottom = vp.scrollTop > 4 && distFromBottom <= 28;

    let candidate = null;

    if (isAtBottom) {
      // When scrolled to the very bottom, if multiple questions are visible on screen, pick the last one
      for (const [stepIdx, info] of sorted) {
        const elRect = info.el.getBoundingClientRect();
        const secRect = (info.sectionEl || info.el).getBoundingClientRect();
        const isVisible =
          secRect.bottom > vpRect.top + 20 &&
          elRect.bottom > vpRect.top + 8 &&
          elRect.top < vpRect.bottom - 8;
        if (isVisible) {
          candidate = stepIdx;
        }
      }
    }

    if (candidate === null) {
      // Standard rule: align with the topmost visible question/turn on screen
      for (const [stepIdx, info] of sorted) {
        const secRect = (info.sectionEl || info.el).getBoundingClientRect();
        if (secRect.bottom > vpRect.top + 52 && secRect.top < vpRect.bottom - 16) {
          candidate = stepIdx;
          break;
        }
      }
    }

    if (candidate === null) {
      // Fallback if all mounted sections are above or below
      const firstIdx = sorted[0][0];
      const lastIdx = sorted[sorted.length - 1][0];
      const firstRect = (sorted[0][1].sectionEl || sorted[0][1].el).getBoundingClientRect();
      candidate = firstRect.top > vpRect.top ? firstIdx : lastIdx;
    }

    if (candidate !== null && candidate !== activeStepIndex) {
      activeStepIndex = candidate;
      updateMinimapActiveDom(true);
      syncWithHost();
    }
  }

  function highlightTurnArrival(el, sectionEl) {
    if (!el) return;
    const bubble = el.querySelector('[data-testid="user-message-bubble"]') || el;
    try {
      bubble.animate(
        [
          {
            boxShadow: '0 0 0 0px rgba(122, 154, 255, 0), 0 0 0px rgba(122, 154, 255, 0)',
            transform: 'translateY(4px) scale(0.995)',
          },
          {
            boxShadow: '0 0 0 2.5px rgba(122, 154, 255, 0.9), 0 8px 26px rgba(122, 154, 255, 0.35)',
            transform: 'translateY(0px) scale(1.012)',
            offset: 0.28,
          },
          {
            boxShadow: '0 0 0 1.5px rgba(122, 154, 255, 0.45), 0 4px 14px rgba(122, 154, 255, 0.16)',
            transform: 'translateY(0px) scale(1)',
            offset: 0.65,
          },
          {
            boxShadow: '0 0 0 0px rgba(122, 154, 255, 0), 0 0 0px rgba(122, 154, 255, 0)',
            transform: 'translateY(0px) scale(1)',
          },
        ],
        { duration: 1150, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }
      );
    } catch {}

    if (sectionEl && sectionEl !== bubble) {
      try {
        sectionEl.animate(
          [
            {
              backgroundColor: 'rgba(122, 154, 255, 0)',
              boxShadow: 'inset 3px 0 0 0 rgba(122, 154, 255, 0)',
              borderRadius: '10px',
            },
            {
              backgroundColor: 'rgba(122, 154, 255, 0.07)',
              boxShadow: 'inset 3px 0 0 0 rgba(122, 154, 255, 0.85)',
              borderRadius: '10px',
              offset: 0.22,
            },
            {
              backgroundColor: 'rgba(122, 154, 255, 0.03)',
              boxShadow: 'inset 3px 0 0 0 rgba(122, 154, 255, 0.4)',
              borderRadius: '10px',
              offset: 0.7,
            },
            {
              backgroundColor: 'rgba(122, 154, 255, 0)',
              boxShadow: 'inset 3px 0 0 0 rgba(122, 154, 255, 0)',
              borderRadius: '10px',
            },
          ],
          { duration: 1250, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
        );
      } catch {}
    }
  }

  let suppressScrollSyncUntil = 0;
  let activeJumpAnimRaf = 0;

  function getTurnStepBounds(targetIdx, ctrls) {
    const rawTurns = ctrls?.c7b?.memoizedProps?.turns;
    const slice =
      ctrls?.z6b?.memoizedProps?.trajectorySlice ||
      ctrls?.c7b?.memoizedProps?.trajectorySlice;
    const totalSteps = Number(slice?.totalStepsLength || 0);
    let turnEndExclusive = targetIdx + 1;
    let isLastTurn = false;
    if (Array.isArray(rawTurns) && rawTurns.length > 0) {
      const idx = rawTurns.findIndex(t => Number(t.startStepIndex) === targetIdx);
      if (idx >= 0) {
        isLastTurn = idx === rawTurns.length - 1;
        turnEndExclusive =
          idx + 1 < rawTurns.length
            ? Number(rawTurns[idx + 1].startStepIndex)
            : Math.max(totalSteps, targetIdx + 1);
      }
    }
    const rawStart = Number(slice?.stepsSlice?.startIndex ?? 0);
    const sliceStart = rawStart < 0 ? Math.max(0, totalSteps + rawStart) : rawStart;
    const rawEnd = slice?.stepsSlice?.endIndexExclusive;
    const sliceEndExclusive =
      rawEnd === undefined || rawEnd === null
        ? totalSteps
        : Number(rawEnd) < 0
          ? Math.max(0, totalSteps + Number(rawEnd))
          : Number(rawEnd);
    const isFullTurnInSlice =
      totalSteps === 0 || (targetIdx >= sliceStart && turnEndExclusive <= sliceEndExclusive);
    return {
      turnStart: targetIdx,
      turnEndExclusive,
      totalSteps,
      sliceStart,
      sliceEndExclusive,
      isFullTurnInSlice,
      isLastTurn,
    };
  }

  function requestFullTurnSlice(targetIdx, ctrls) {
    const bounds = getTurnStepBounds(targetIdx, ctrls);
    const reqSliceFn = ctrls?.z6b?.memoizedState?.next?.memoizedState?.[0];
    const navFn =
      ctrls?.c7b?.memoizedProps?.navigateTo ||
      ctrls?.z6b?.memoizedProps?.paginationRef?.current?.navigateTo;

    // Prefer expanding the slice without ever shrinking it, loading the full conversation when <= 600 steps
    if (typeof reqSliceFn === 'function') {
      const startIndex =
        bounds.totalSteps > 0 && bounds.totalSteps <= 600
          ? 0
          : Math.max(0, Math.min(bounds.sliceStart, targetIdx - 100));
      const rawEnd =
        bounds.totalSteps > 0 && bounds.totalSteps <= 600
          ? bounds.totalSteps
          : Math.max(bounds.sliceEndExclusive, targetIdx + 200, bounds.turnEndExclusive + 30);
      const endIndexExclusive =
        bounds.totalSteps > 0 && rawEnd >= bounds.totalSteps ? undefined : rawEnd;
      try {
        void reqSliceFn({ startIndex, endIndexExclusive });
        return true;
      } catch {}
    }

    if (typeof navFn === 'function') {
      try {
        navFn(targetIdx);
        return true;
      } catch {}
    }
    return false;
  }

  function scrollToTurnSection(vp, info, c7b, fromPagination = false) {
    if (!vp || !info?.el) return;
    const sectionEl =
      info.sectionEl ||
      info.el.closest('.scroll-mt-4')?.parentElement ||
      info.el.closest('.scroll-mt-4') ||
      info.el.closest('.flex.items-start') ||
      info.el;
    try {
      c7b?.memoizedProps?.autoScrollRef?.current?.stopAutoScroll?.();
    } catch {}

    if (activeJumpAnimRaf) {
      cancelAnimationFrame(activeJumpAnimRaf);
      activeJumpAnimRaf = 0;
    }

    const computeTargetTop = () => {
      const vpRect = vp.getBoundingClientRect();
      const secRect = sectionEl.getBoundingClientRect();
      return Math.max(0, secRect.top - vpRect.top + vp.scrollTop - 16);
    };

    const initialTargetTop = computeTargetTop();
    const rawDelta = initialTargetTop - vp.scrollTop;
    const maxGlideDistance = 680;

    // If jumping a long distance or across pagination slices, pre-stage within 680px then glide smoothly
    let startScrollTop = vp.scrollTop;
    if (fromPagination || Math.abs(rawDelta) > maxGlideDistance) {
      const sign = rawDelta >= 0 ? 1 : -1;
      startScrollTop = Math.max(0, initialTargetTop - sign * Math.min(Math.abs(rawDelta), maxGlideDistance));
      vp.scrollTop = startScrollTop;
    }

    const durationMs = 340;
    const startTime = performance.now();
    suppressScrollSyncUntil = Date.now() + durationMs + 220;

    const stepFrame = now => {
      if (disposed || !vp.isConnected || !sectionEl.isConnected) {
        activeJumpAnimRaf = 0;
        return;
      }
      try {
        c7b?.memoizedProps?.autoScrollRef?.current?.stopAutoScroll?.();
      } catch {}
      const t = Math.min(1, Math.max(0, (now - startTime) / durationMs));
      // Ease-out-quart curve for crisp start and silky deceleration
      const eased = 1 - Math.pow(1 - t, 4);
      const currentTargetTop = computeTargetTop();
      const nextTop = startScrollTop + (currentTargetTop - startScrollTop) * eased;
      vp.scrollTop = nextTop;

      if (t < 1) {
        activeJumpAnimRaf = requestAnimationFrame(stepFrame);
      } else {
        activeJumpAnimRaf = 0;
        vp.scrollTop = computeTargetTop();
      }
    };

    activeJumpAnimRaf = requestAnimationFrame(stepFrame);
    highlightTurnArrival(info.el, sectionEl);
    updateMinimapActiveDom(true, true);
  }

  function jumpToStep(stepIndex) {
    const targetIdx = Number(stepIndex);
    if (!Number.isFinite(targetIdx)) return false;
    const vp = getViewport();
    if (!vp) return false;
    const ctrls = getReactControllers(vp);
    const domMap = getDomUserStepMap(vp, ctrls?.fk);
    const bounds = getTurnStepBounds(targetIdx, ctrls);

    activeStepIndex = targetIdx;
    const existing = domMap.get(targetIdx);
    if (existing?.el && bounds.isFullTurnInSlice) {
      jumpingStepIndex = null;
      scrollToTurnSection(vp, existing, ctrls?.c7b, false);
      renderMinimap();
      syncWithHost();
      return true;
    }

    // Target turn (or part of its answer) is in an unloaded pagination slice
    jumpingStepIndex = targetIdx;
    renderMinimap();
    try {
      ctrls?.c7b?.memoizedProps?.autoScrollRef?.current?.stopAutoScroll?.();
    } catch {}
    if (!requestFullTurnSlice(targetIdx, ctrls)) {
      if (existing?.el) {
        jumpingStepIndex = null;
        scrollToTurnSection(vp, existing, ctrls?.c7b, false);
        renderMinimap();
        syncWithHost();
        return true;
      }
      jumpingStepIndex = null;
      renderMinimap();
      return false;
    }

    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      const curVp = getViewport();
      const curCtrls = getReactControllers(curVp);
      const curDom = getDomUserStepMap(curVp, curCtrls?.fk);
      const curBounds = getTurnStepBounds(targetIdx, curCtrls);
      const found = curDom.get(targetIdx);
      if (found?.el && (curBounds.isFullTurnInSlice || attempts >= 15)) {
        clearInterval(poll);
        jumpingStepIndex = null;
        scrollToTurnSection(curVp, found, curCtrls?.c7b, true);
        renderMinimap();
        syncWithHost();
      } else if (attempts >= 65) {
        clearInterval(poll);
        jumpingStepIndex = null;
        renderMinimap();
      }
    }, 60);
    return true;
  }

  function syncWithHost() {
    if (!window.agMinimapHost?.syncState || !currentCid) return;
    void window.agMinimapHost.syncState({
      conversationId: currentCid,
      activeStepIndex,
      turns: turnsList,
    });
  }

  function refreshTurnsState() {
    if (disposed) return;
    const vp = getViewport();
    if (!vp) {
      if (hostEl) hostEl.hidden = true;
      return;
    }
    const ctrls = getReactControllers(vp);
    const cid = detectConversationId(ctrls?.c7b);
    if (!cid) {
      if (hostEl) hostEl.hidden = true;
      return;
    }
    if (cid !== currentCid) {
      currentCid = cid;
      turnsList = [];
      activeStepIndex = null;
      jumpingStepIndex = null;
      lastStructureSignature = '';
    }
    // Prevent cross-conversation pollution while React is switching views
    if (!isControllerMatchingCid(ctrls, cid)) {
      return;
    }

    const domMap = getDomUserStepMap(vp, ctrls?.fk);
    for (const [stepIdx, info] of domMap.entries()) {
      if (info.prompt) {
        const prev = promptCache.get(`${cid}:${stepIdx}`);
        promptCache.set(`${cid}:${stepIdx}`, {
          prompt: info.prompt,
          timestampMs: info.timestampMs || prev?.timestampMs || null,
        });
      }
    }

    const rawTurns = ctrls?.c7b?.memoizedProps?.turns;
    const missing = [];
    const nextTurns = [];

    if (Array.isArray(rawTurns) && rawTurns.length > 0) {
      rawTurns.forEach((t, idx) => {
        const stepIdx = Number(t.startStepIndex);
        const cached = promptCache.get(`${cid}:${stepIdx}`);
        const domInfo = domMap.get(stepIdx);
        const prompt = domInfo?.prompt || cached?.prompt || '';
        const timestampMs = Number(t.startTimeMs) || domInfo?.timestampMs || cached?.timestampMs || null;
        if (!prompt) missing.push(stepIdx);
        nextTurns.push({
          turnIndex: idx + 1,
          startStepIndex: stepIdx,
          timestampMs,
          prompt: prompt || `第 ${idx + 1} 轮提问...`,
          loadedInDom: domMap.has(stepIdx) && getTurnStepBounds(stepIdx, ctrls).isFullTurnInSlice,
        });
      });
    } else if (domMap.size > 0) {
      const sorted = [...domMap.entries()].sort((a, b) => a[0] - b[0]);
      sorted.forEach(([stepIdx, info], idx) => {
        nextTurns.push({
          turnIndex: idx + 1,
          startStepIndex: stepIdx,
          timestampMs: info.timestampMs,
          prompt: info.prompt || `第 ${idx + 1} 轮提问`,
          loadedInDom: true,
        });
      });
    }

    turnsList = nextTurns;
    if (missing.length > 0) {
      void fetchMissingPrompts(cid, ctrls?.c7b, missing);
    }

    updateActiveStepFromScroll(vp, domMap);
    positionHost(vp);
    renderMinimap();
    syncWithHost();
  }

  function isLightMode() {
    try {
      const bg = getComputedStyle(document.body || document.documentElement).backgroundColor;
      const m = bg.match(/\d+/g);
      if (m && m.length >= 3) {
        const lum = (0.299 * Number(m[0]) + 0.587 * Number(m[1]) + 0.114 * Number(m[2])) / 255;
        return lum > 0.62;
      }
    } catch {}
    return false;
  }

  function ensureDom() {
    if (hostEl && hostEl.isConnected) return;
    hostEl = document.createElement('div');
    hostEl.id = HOST_ID;
    hostEl.style.cssText = 'position:fixed;z-index:2147483640;pointer-events:none;';
    shadow = hostEl.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
          color: var(--mm-fg, #e6edf3);
        }
        .wrapper {
          --mm-bg: rgba(22, 25, 34, 0.90);
          --mm-card-bg: rgba(24, 27, 38, 0.96);
          --mm-border: rgba(255, 255, 255, 0.10);
          --mm-fg: #e8ecf4;
          --mm-muted: #8b95a7;
          --mm-accent: #7a9aff;
          --mm-accent-soft: rgba(122, 154, 255, 0.16);
          --mm-hover: rgba(255, 255, 255, 0.06);
          --mm-tick: rgba(255, 255, 255, 0.28);
          --mm-tick-loaded: rgba(255, 255, 255, 0.50);
          --mm-shadow: 0 12px 32px rgba(0, 0, 0, 0.42);
          position: relative;
          display: flex;
          align-items: center;
          justify-content: flex-end;
          height: 100%;
          pointer-events: none;
        }
        .wrapper[data-theme="light"] {
          --mm-bg: rgba(255, 255, 255, 0.88);
          --mm-card-bg: rgba(252, 253, 255, 0.97);
          --mm-border: rgba(15, 23, 42, 0.10);
          --mm-fg: #1e293b;
          --mm-muted: #64748b;
          --mm-accent: #4f6ef7;
          --mm-accent-soft: rgba(79, 110, 247, 0.12);
          --mm-hover: rgba(15, 23, 42, 0.05);
          --mm-tick: rgba(15, 23, 42, 0.24);
          --mm-tick-loaded: rgba(15, 23, 42, 0.48);
          --mm-shadow: 0 12px 28px rgba(15, 23, 42, 0.14);
        }
        .rail {
          pointer-events: auto;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 5px;
          padding: 8px 5px;
          background: transparent;
          border: none;
          backdrop-filter: none;
          box-shadow: none;
          cursor: pointer;
          max-height: 100%;
          box-sizing: border-box;
        }
        .rail-count {
          font-size: 10px;
          font-weight: 700;
          color: var(--mm-accent);
          line-height: 1;
          padding: 2px 3px;
          letter-spacing: -0.02em;
          font-variant-numeric: tabular-nums;
          user-select: none;
        }
        .rail-ticks {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
          overflow-y: auto;
          scrollbar-width: none;
          max-height: 52vh;
          padding: 2px 0;
        }
        .rail-ticks[data-density="compact"] {
          gap: 2.5px;
        }
        .rail-ticks[data-density="ultra"] {
          gap: 1.5px;
        }
        .rail-ticks::-webkit-scrollbar { display: none; }
        .tick {
          width: 10px;
          height: 3px;
          border-radius: 99px;
          background: var(--mm-tick);
          transition: all 0.18s ease;
          flex-shrink: 0;
        }
        .rail-ticks[data-density="compact"] .tick {
          height: 2.5px;
        }
        .rail-ticks[data-density="ultra"] .tick {
          height: 2px;
        }
        .tick[data-loaded="true"] {
          background: var(--mm-tick-loaded);
        }
        .tick:hover {
          width: 14px;
          background: var(--mm-accent);
        }
        .tick[data-active="true"] {
          width: 16px;
          height: 4px;
          background: var(--mm-accent);
          box-shadow: 0 0 8px var(--mm-accent);
        }
        .drawer {
          pointer-events: none;
          position: absolute;
          right: 34px;
          width: 300px;
          max-height: min(520px, 76vh);
          display: flex;
          flex-direction: column;
          background: var(--mm-card-bg);
          border: 1px solid var(--mm-border);
          border-radius: 12px;
          box-shadow: var(--mm-shadow);
          backdrop-filter: blur(16px);
          opacity: 0;
          transform: translateX(8px) scale(0.98);
          transition: opacity 0.16s ease, transform 0.16s cubic-bezier(0.22, 1, 0.36, 1);
          overflow: hidden;
        }
        .wrapper[data-open="true"] .drawer {
          pointer-events: auto;
          opacity: 1;
          transform: translateX(0) scale(1);
        }
        .drawer-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 12px;
          border-bottom: 1px solid var(--mm-border);
          gap: 8px;
        }
        .drawer-title {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          font-weight: 600;
          color: var(--mm-fg);
        }
        .drawer-badge {
          font-size: 10px;
          font-weight: 500;
          padding: 1px 6px;
          border-radius: 99px;
          background: var(--mm-accent-soft);
          color: var(--mm-accent);
        }
        .drawer-actions {
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .icon-btn {
          all: unset;
          cursor: pointer;
          font-size: 11px;
          color: var(--mm-muted);
          padding: 3px 6px;
          border-radius: 6px;
          transition: background 0.14s, color 0.14s;
          user-select: none;
        }
        .icon-btn:hover {
          background: var(--mm-hover);
          color: var(--mm-fg);
        }
        .icon-btn[data-active="true"] {
          background: var(--mm-accent-soft);
          color: var(--mm-accent);
          font-weight: 600;
        }
        .drawer-search {
          padding: 6px 10px;
          border-bottom: 1px solid var(--mm-border);
        }
        .search-input {
          all: unset;
          width: 100%;
          box-sizing: border-box;
          font-size: 11px;
          padding: 5px 8px;
          border-radius: 6px;
          background: var(--mm-hover);
          border: 1px solid var(--mm-border);
          color: var(--mm-fg);
          transition: border-color 0.14s ease;
        }
        .search-input:focus {
          border-color: var(--mm-accent);
        }
        .search-input::placeholder {
          color: var(--mm-muted);
        }
        .turn-list {
          display: flex;
          flex-direction: column;
          overflow-y: auto;
          padding: 6px;
          gap: 3px;
          max-height: 410px;
          scrollbar-width: thin;
        }
        .turn-item[hidden] {
          display: none !important;
        }
        .turn-item {
          all: unset;
          cursor: pointer;
          display: flex;
          flex-direction: column;
          gap: 3px;
          padding: 7px 9px;
          border-radius: 8px;
          border: 1px solid transparent;
          transition: background 0.14s ease, border-color 0.14s ease;
          box-sizing: border-box;
        }
        .turn-item:hover {
          background: var(--mm-hover);
        }
        .turn-item[data-active="true"] {
          background: var(--mm-accent-soft);
          border-color: rgba(122, 154, 255, 0.32);
        }
        .turn-meta {
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-size: 11px;
          line-height: 1.2;
        }
        .turn-num {
          font-weight: 600;
          color: var(--mm-accent);
          font-variant-numeric: tabular-nums;
        }
        .turn-time {
          color: var(--mm-muted);
          font-size: 10px;
          font-variant-numeric: tabular-nums;
        }
        .turn-prompt {
          font-size: 12px;
          line-height: 1.4;
          color: var(--mm-fg);
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
          word-break: break-word;
        }
      </style>
      <div class="wrapper" id="mm-wrapper" data-open="false" data-theme="dark">
        <div class="drawer" id="mm-drawer">
          <div class="drawer-header">
            <div class="drawer-title">
              <span>Antigravity MiniMap</span>
              <span class="drawer-badge" id="mm-total-badge">0 轮</span>
            </div>
            <div class="drawer-actions">
              <button class="icon-btn" id="mm-btn-first" title="跳到第一轮提问">首轮</button>
              <button class="icon-btn" id="mm-btn-last" title="跳到最新一轮提问">最新</button>
              <button class="icon-btn" id="mm-btn-pin" title="固定/取消固定小地图面板">固定</button>
            </div>
          </div>
          <div class="drawer-search">
            <input class="search-input" id="mm-search-input" type="text" placeholder="搜索提问关键字，或输入 #轮次 回车跳转..." />
          </div>
          <div class="turn-list" id="mm-turn-list"></div>
        </div>
        <div class="rail" id="mm-rail" title="悬停展开对话小地图">
          <div class="rail-count" id="mm-rail-count">0</div>
          <div class="rail-ticks" id="mm-rail-ticks"></div>
        </div>
      </div>
    `;
    document.body.appendChild(hostEl);

    const wrapper = shadow.getElementById('mm-wrapper');
    const rail = shadow.getElementById('mm-rail');
    const drawer = shadow.getElementById('mm-drawer');
    const pinBtn = shadow.getElementById('mm-btn-pin');
    const firstBtn = shadow.getElementById('mm-btn-first');
    const lastBtn = shadow.getElementById('mm-btn-last');

    const openDrawer = () => {
      clearTimeout(hoverCloseTimer);
      if (drawerOpen) return;
      hoverOpenTimer = setTimeout(() => {
        drawerOpen = true;
        wrapper.setAttribute('data-open', 'true');
        scrollActiveTurnIntoDrawerView();
      }, 100);
    };

    const closeDrawer = () => {
      clearTimeout(hoverOpenTimer);
      if (pinned) return;
      hoverCloseTimer = setTimeout(() => {
        drawerOpen = false;
        wrapper.setAttribute('data-open', 'false');
      }, 220);
    };

    rail.addEventListener('mouseenter', openDrawer);
    rail.addEventListener('mouseleave', closeDrawer);
    drawer.addEventListener('mouseenter', () => {
      clearTimeout(hoverCloseTimer);
    });
    drawer.addEventListener('mouseleave', closeDrawer);

    pinBtn.addEventListener('click', e => {
      e.stopPropagation();
      pinned = !pinned;
      pinBtn.setAttribute('data-active', String(pinned));
      drawerOpen = true;
      wrapper.setAttribute('data-open', 'true');
    });

    firstBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (turnsList.length > 0) jumpToStep(turnsList[0].startStepIndex);
    });

    lastBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (turnsList.length > 0) jumpToStep(turnsList.at(-1).startStepIndex);
    });

    const searchInput = shadow.getElementById('mm-search-input');
    searchInput.addEventListener('input', e => {
      searchQuery = String(e.target.value || '').trim().toLowerCase();
      applySearchFilter();
    });
    searchInput.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const m = searchQuery.match(/^#?(\d+)$/);
        if (m) {
          const targetNum = Number(m[1]);
          const found = turnsList.find(t => t.turnIndex === targetNum);
          if (found) {
            jumpToStep(found.startStepIndex);
            return;
          }
        }
        const firstVisible = shadow.querySelector('#mm-turn-list .turn-item:not([hidden])');
        if (firstVisible) {
          jumpToStep(Number(firstVisible.dataset.stepIndex));
        }
      }
    });
  }

  function applySearchFilter() {
    if (!shadow) return;
    const q = searchQuery;
    const items = shadow.querySelectorAll('#mm-turn-list .turn-item');
    for (const item of items) {
      if (!q) {
        item.hidden = false;
        continue;
      }
      const tIdx = item.dataset.turnIndex || '';
      const text = (item.title || '').toLowerCase();
      const numMatch = q.startsWith('#') ? `#${tIdx}`.startsWith(q) : (`#${tIdx}`.includes(q) || text.includes(q));
      item.hidden = !numMatch;
    }
  }

  function scrollActiveTurnIntoDrawerView(smooth = false) {
    if (!shadow) return;
    const behavior = smooth ? 'smooth' : 'auto';
    const activeTick = shadow.querySelector('.tick[data-active="true"]');
    if (activeTick) {
      activeTick.scrollIntoView({ block: 'nearest', behavior });
    }
    const activeEl = shadow.querySelector('.turn-item[data-active="true"]');
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest', behavior });
    }
  }

  function positionHost(vp) {
    ensureDom();
    if (!vp || turnsList.length === 0) {
      hostEl.hidden = true;
      return;
    }
    const r = vp.getBoundingClientRect();
    if (r.width < 260 || r.height < 160) {
      hostEl.hidden = true;
      return;
    }
    hostEl.hidden = false;
    const top = Math.round(r.top + 16);
    const height = Math.round(r.height - 32);
    const right = Math.max(8, Math.round(window.innerWidth - r.right + 12));
    hostEl.style.top = `${top}px`;
    hostEl.style.height = `${height}px`;
    hostEl.style.right = `${right}px`;
  }

  let lastStructureSignature = '';

  function updateMinimapActiveDom(autoScrollList = false, smoothScroll = false) {
    if (!shadow) return;
    const activeTurn = turnsList.find(t => t.startStepIndex === activeStepIndex) || turnsList.at(-1);
    const activeTurnIdx = activeTurn ? activeTurn.turnIndex : 0;
    const activeStep = activeTurn ? activeTurn.startStepIndex : null;

    const railCount = shadow.getElementById('mm-rail-count');
    if (railCount) {
      railCount.textContent = turnsList.length ? `${activeTurnIdx}/${turnsList.length}` : '0';
    }

    const ticks = shadow.querySelectorAll('#mm-rail-ticks .tick');
    for (const tick of ticks) {
      const sIdx = Number(tick.dataset.stepIndex);
      tick.setAttribute('data-active', String(sIdx === activeStep));
    }

    const items = shadow.querySelectorAll('#mm-turn-list .turn-item');
    for (const item of items) {
      const sIdx = Number(item.dataset.stepIndex);
      const tIdx = Number(item.dataset.turnIndex);
      item.setAttribute('data-active', String(sIdx === activeStep));
      const numSpan = item.querySelector('.turn-num');
      if (numSpan) {
        numSpan.textContent = sIdx === jumpingStepIndex ? `#${tIdx} · 定位中...` : `#${tIdx}`;
      }
    }

    if (autoScrollList) {
      scrollActiveTurnIntoDrawerView(smoothScroll);
    }
  }

  function renderMinimap() {
    ensureDom();
    const wrapper = shadow.getElementById('mm-wrapper');
    const theme = isLightMode() ? 'light' : 'dark';
    if (wrapper.getAttribute('data-theme') !== theme) {
      wrapper.setAttribute('data-theme', theme);
    }

    const structureSig = JSON.stringify({
      cid: currentCid,
      turns: turnsList.map(t => [t.startStepIndex, t.prompt, t.loadedInDom, t.timestampMs]),
    });

    if (structureSig !== lastStructureSignature) {
      lastStructureSignature = structureSig;

      const totalBadge = shadow.getElementById('mm-total-badge');
      const ticksContainer = shadow.getElementById('mm-rail-ticks');
      const listContainer = shadow.getElementById('mm-turn-list');

      const prevTicksScroll = ticksContainer.scrollTop;
      const prevListScroll = listContainer.scrollTop;

      totalBadge.textContent = `共 ${turnsList.length} 轮`;
      const density = turnsList.length > 75 ? 'ultra' : turnsList.length > 35 ? 'compact' : 'normal';
      ticksContainer.setAttribute('data-density', density);
      ticksContainer.replaceChildren();
      listContainer.replaceChildren();

      for (const t of turnsList) {
        const tick = document.createElement('div');
        tick.className = 'tick';
        tick.dataset.stepIndex = String(t.startStepIndex);
        tick.dataset.turnIndex = String(t.turnIndex);
        tick.setAttribute('data-loaded', String(Boolean(t.loadedInDom)));
        tick.title = `#${t.turnIndex} ${t.prompt}`;
        tick.addEventListener('click', e => {
          e.stopPropagation();
          jumpToStep(t.startStepIndex);
        });
        ticksContainer.appendChild(tick);

        const item = document.createElement('button');
        item.className = 'turn-item';
        item.dataset.stepIndex = String(t.startStepIndex);
        item.dataset.turnIndex = String(t.turnIndex);
        item.title = t.prompt;

        const meta = document.createElement('div');
        meta.className = 'turn-meta';

        const numSpan = document.createElement('span');
        numSpan.className = 'turn-num';
        numSpan.textContent = `#${t.turnIndex}`;

        const timeSpan = document.createElement('span');
        timeSpan.className = 'turn-time';
        timeSpan.textContent = formatTime(t.timestampMs);

        meta.append(numSpan, timeSpan);

        const promptDiv = document.createElement('div');
        promptDiv.className = 'turn-prompt';
        promptDiv.textContent = t.prompt;

        item.append(meta, promptDiv);
        item.addEventListener('click', e => {
          e.stopPropagation();
          jumpToStep(t.startStepIndex);
        });
        listContainer.appendChild(item);
      }

      ticksContainer.scrollTop = prevTicksScroll;
      listContainer.scrollTop = prevListScroll;
      applySearchFilter();
    }

    updateMinimapActiveDom(false);
  }

  let scrollListenerVp = null;
  let scrollRaf = 0;
  let lastDomMapCount = -1;
  const onViewportScroll = () => {
    if (disposed || scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      const vp = getViewport();
      if (!vp) return;
      const ctrls = getReactControllers(vp);
      const cid = detectConversationId(ctrls?.c7b);
      if (!cid || !isControllerMatchingCid(ctrls, cid)) return;
      const domMap = getDomUserStepMap(vp, ctrls?.fk);
      if (domMap.size !== lastDomMapCount) {
        lastDomMapCount = domMap.size;
        refreshTurnsState();
      } else {
        updateActiveStepFromScroll(vp, domMap);
      }
    });
  };

  const onDocumentScrollCapture = e => {
    if (disposed) return;
    const vp = getViewport();
    if (!vp) return;
    if (e.target === vp || vp.contains(e.target)) {
      onViewportScroll();
    }
  };
  document.addEventListener('scroll', onDocumentScrollCapture, { capture: true, passive: true });

  const pollTimer = setInterval(() => {
    if (disposed) return;
    const vp = getViewport();
    if (vp !== scrollListenerVp) {
      scrollListenerVp?.removeEventListener('scroll', onViewportScroll);
      scrollListenerVp = vp;
      scrollListenerVp?.addEventListener('scroll', onViewportScroll, { passive: true });
    }
    refreshTurnsState();
  }, 700);

  window.addEventListener('resize', () => {
    const vp = getViewport();
    if (vp) positionHost(vp);
  });

  window.__agMinimapJumpTo = (stepIndex, cid = null) => {
    if (cid && currentCid && cid !== currentCid) return false;
    return jumpToStep(stepIndex);
  };

  window.__agMinimapGetState = () => ({
    conversationId: currentCid,
    activeStepIndex,
    turns: turnsList,
  });

  window.__agMinimapDispose = () => {
    disposed = true;
    clearInterval(pollTimer);
    clearTimeout(hoverOpenTimer);
    clearTimeout(hoverCloseTimer);
    if (scrollRaf) cancelAnimationFrame(scrollRaf);
    if (activeJumpAnimRaf) cancelAnimationFrame(activeJumpAnimRaf);
    document.removeEventListener('scroll', onDocumentScrollCapture, { capture: true });
    scrollListenerVp?.removeEventListener('scroll', onViewportScroll);
    hostEl?.remove();
    delete window.__agMinimapInstalled;
    delete window.__agMinimapJumpTo;
    delete window.__agMinimapGetState;
    delete window.__agMinimapDispose;
  };

  refreshTurnsState();
};
