(function () {
  var KEY = 'ptt_theme';
  function preferDark() {
    try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { return true; }
  }
  function apply(mode) {
    var m = mode || localStorage.getItem(KEY) || 'system';
    document.documentElement.dataset.theme = m;
    var dark = m === 'dark' || (m !== 'light' && preferDark());
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = dark ? '#0f172a' : '#f8fafc';
  }
  window.PttTheme = {
    get: function () { return localStorage.getItem(KEY) || 'system'; },
    set: function (mode) { localStorage.setItem(KEY, mode); apply(mode); },
    apply: apply
  };
  apply();
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { apply(); });
  } catch (e) {}
})();
