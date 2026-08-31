/**
 * WebSense MCP — Session Manager
 * Tracks exploration history, builds navigation graph, manages diffs.
 */
export class SessionManager {
  constructor() {
    this.pages = new Map();
    this.history = [];
    this.currentUrl = null;
    this.stepCounter = 0;
    this.lastSnapshot = null;
    this.task = null; // P2 task-stack (2026-08-31): goal + steps + progress
  }

  // ═══ P2 TASK-STACK (2026-08-31): a per-session state machine so a
  // multi-step journey (login → verify → test → submit) keeps its goal,
  // pending steps, and next-action in ONE place instead of living only in the
  // agent's context. Pure server-side — no extension changes. ═══
  beginTask(goal, steps) {
    this.task = {
      goal: String(goal || '').trim(),
      steps: (Array.isArray(steps) ? steps : []).map((s) => ({
        label: String(s.label || s || ''),
        done: false,
        skipped: false,
      })),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      currentStep: 0,
      completedAt: null,
    };
    this.advanceStep();
    return this.task;
  }

  completeStep(label) {
    if (!this.task) return null;
    // Mark the FIRST not-done step matching label (or the current step if no label)
    let found = false;
    for (const s of this.task.steps) {
      if (!s.done && !s.skipped && (!label || s.label.toLowerCase() === String(label).toLowerCase())) {
        s.done = true;
        found = true;
        break;
      }
    }
    if (!found && label) {
      // label doesn't match a pending step — treat as an ad-hoc completion note
      this.task.steps.push({ label: String(label), done: true, skipped: false });
      found = true;
    }
    this.task.updatedAt = Date.now();
    this.advanceStep();
    if (this.task.steps.length && this.task.steps.every((s) => s.done || s.skipped)) {
      this.task.completedAt = Date.now();
    }
    return this.task;
  }

  skipStep(label) {
    if (!this.task) return null;
    for (const s of this.task.steps) {
      if (!s.done && !s.skipped && (!label || s.label.toLowerCase() === String(label).toLowerCase())) {
        s.skipped = true;
        break;
      }
    }
    this.task.updatedAt = Date.now();
    this.advanceStep();
    return this.task;
  }

  // Move currentStep to the first not-done, not-skipped step.
  advanceStep() {
    if (!this.task) return;
    const idx = this.task.steps.findIndex((s) => !s.done && !s.skipped);
    this.task.currentStep = idx === -1 ? this.task.steps.length : idx;
  }

  getTask() {
    if (!this.task) return null;
    const pending = this.task.steps.filter((s) => !s.done && !s.skipped);
    const next = pending.length ? pending[0] : null;
    return {
      goal: this.task.goal,
      steps: this.task.steps,
      progress: {
        total: this.task.steps.length,
        done: this.task.steps.filter((s) => s.done).length,
        skipped: this.task.steps.filter((s) => s.skipped).length,
        pending: pending.length,
      },
      currentStep: this.task.currentStep,
      nextAction: next ? next.label : null,
      completed: !!this.task.completedAt,
      completedAt: this.task.completedAt,
      createdAt: this.task.createdAt,
      updatedAt: this.task.updatedAt,
    };
  }

  recordAction(action, result) {
    const entry = { step: this.stepCounter++, ...action, result: result || null, timestamp: Date.now() };
    this.history.push(entry);
    return entry;
  }

  recordPage(url, pas) {
    const pageData = {
      title: pas?.meta?.title || '',
      pageType: pas?.meta?.pageType || 'unknown',
      firstVisited: this.stepCounter,
      lastVisited: this.stepCounter,
      visitCount: 1,
      outgoingActions: [],
      formCount: pas?.forms?.length || 0,
      elementCount: pas?.elementCount || 0,
      notes: '',
    };
    if (!this.pages.has(url)) {
      this.pages.set(url, pageData);
    } else {
      const existing = this.pages.get(url);
      existing.lastVisited = this.stepCounter;
      existing.visitCount++;
      existing.title = pageData.title;
    }
    this.currentUrl = url;
  }

  recordNavigation(fromUrl, toUrl, actionRef, actionLabel, actionType) {
    if (!this.pages.has(fromUrl)) return;
    const page = this.pages.get(fromUrl);
    const exists = page.outgoingActions.find((a) => a.ref === actionRef && a.leadsTo === toUrl);
    if (!exists) {
      page.outgoingActions.push({ ref: actionRef, label: actionLabel, leadsTo: toUrl, actionType });
    }
  }

  getExplorationMap() {
    return {
      pages: Object.fromEntries(this.pages),
      currentPage: this.currentUrl,
      history: this.history.slice(-50), // Last 50 actions
      totalSteps: this.stepCounter,
    };
  }

  setLastSnapshot(sag) {
    this.lastSnapshot = sag;
  }

  getLastSnapshot() {
    return this.lastSnapshot;
  }

  diffSnapshots(prev, curr) {
    if (!prev) return null; // First snapshot — no diff
    const changes = {
      urlChanged: prev.meta?.url !== curr.meta?.url,
      newElements: [],
      removedElements: [],
      changedElements: [],
      newForms: [],
      removedForms: [],
      dialogChanged: JSON.stringify(prev.dialogs) !== JSON.stringify(curr.dialogs),
      captchaChanged: prev.captcha !== curr.captcha,
      loadingChanged: prev.loading !== curr.loading,
    };

    const prevActions = new Map((prev.actions || []).map((a) => [a.ref, a]));
    const currActions = new Map((curr.actions || []).map((a) => [a.ref, a]));

    for (const [ref, action] of currActions) {
      if (!prevActions.has(ref)) changes.newElements.push(action);
      else {
        const prevAction = prevActions.get(ref);
        const prevState = JSON.stringify({ d: prevAction.disabled, c: prevAction.checked, v: prevAction.value, e: prevAction.expanded });
        const currState = JSON.stringify({ d: action.disabled, c: action.checked, v: action.value, e: action.expanded });
        if (prevState !== currState) {
          changes.changedElements.push({ ref, changes: { from: prevAction, to: action } });
        }
      }
    }
    for (const [ref] of prevActions) {
      if (!currActions.has(ref)) changes.removedElements.push(ref);
    }

    return changes;
  }

  reset() {
    this.pages.clear();
    this.history = [];
    this.currentUrl = null;
    this.stepCounter = 0;
    this.lastSnapshot = null;
    this.task = null; // P2: a reset clears the task state machine too
  }
}
