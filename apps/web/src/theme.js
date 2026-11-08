// Picks the theme before the first paint (a classic script in <head>, so the
// page never flashes the wrong colours). main.js toggles it afterwards.
(() => {
  let saved = null;
  try {
    saved = localStorage.getItem('archslate:web:theme');
  } catch {
    // storage blocked: follow the system
  }
  const dark = saved ? saved === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
