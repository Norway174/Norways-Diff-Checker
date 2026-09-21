function externalTypes(input) {
  const specific = input.types.filter(type => type !== 'text');
  return specific.length ? specific : ['text'];
}

function selectedTabAccepts(windowSummary, input) {
  const tab = windowSummary.activeTab;
  return Boolean(tab && Boolean(tab.left) !== Boolean(tab.right) && externalTypes(input).includes(tab.type));
}

function selectExternalWindow(windowSummaries, input) {
  return windowSummaries.find(summary => selectedTabAccepts(summary, input)) || null;
}

function createOpenPathBatcher(onBatch, delay = 150) {
  let queued = [];
  let timer = null;
  let idleWaiters = [];
  const flush = () => {
    timer = null;
    const batch = queued;
    queued = [];
    if (batch.length) {
      const paths = [...new Set(batch.flatMap(request => request.paths))];
      const mode = batch.some(request => request.mode === 'new') ? 'new' : 'reuse';
      onBatch(paths, mode);
    }
    const waiters = idleWaiters;
    idleWaiters = [];
    waiters.forEach(resolve => resolve());
  };
  return {
    add(paths, mode = 'reuse') {
      if (!paths.length) return;
      queued.push({ paths, mode });
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, delay);
    },
    whenIdle() {
      return timer ? new Promise(resolve => idleWaiters.push(resolve)) : Promise.resolve();
    }
  };
}

module.exports = { createOpenPathBatcher, externalTypes, selectedTabAccepts, selectExternalWindow };