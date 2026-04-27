/**
 * Perplexity content script — injected into www.perplexity.ai pages.
 * Patches window.fetch (in MAIN world) to intercept outgoing
 * /rest/sse/perplexity_ask requests and extract the model_preference
 * + mode from the payload, then relays them to the background worker
 * via window.postMessage -> content-script bridge.
 */

function injectFetchPatch() {
  const script = document.createElement('script');
  script.textContent = `(function () {
    const _fetch = window.fetch;
    window.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url && url.includes('/rest/sse/perplexity_ask') && init && init.body) {
        try {
          const body = JSON.parse(init.body);
          const params = body.params || body;
          const modelPref = params.model_preference ?? null;
          const mode = params.mode ?? null;
          window.postMessage({
            __perplexityGateway: true,
            model_preference: modelPref,
            mode: mode,
          }, '*');
        } catch (_) {}
      }
      return _fetch.apply(this, arguments);
    };
  })();`;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

injectFetchPatch();

window.addEventListener('message', (event) => {
  if (!event.data?.__perplexityGateway) return;
  chrome.runtime.sendMessage({
    type: 'PERPLEXITY_MODEL_DETECTED',
    model_preference: event.data.model_preference,
    mode: event.data.mode,
  });
});
