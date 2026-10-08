// webmods: the horde mod's engine settings for the browser page (engine.js), from the Options box's max zombies and
// start round. Mirrors tools/horde_flags.js (the launcher's; tools/web/check-horde.mjs compares the two) except:
//  - no fs_game: natively it only picks the log/config folder; the page keeps those in /opfs/user.
//  - the skinned vertex cache is at most 128 MB per pool: the wasm heap is a fixed 2 GiB and 1024 zombies at 192 MB
//    ran out of it (128 MB measured enough for round 100's 924 alive at once, Five).
//  - no napalm/sonic enemies (kisak_mod_zones loads Shangri-La's zone, which no browser pack ships).
//  - zinfo (the Tab counter) is its own Options mod; its dvar keeps the mod's default.
export const HORDE_MIN = 24, HORDE_MAX = 1024, HORDE_SKIN_MB_MAX = 128;
export const hordeDefaults = { n: 128, round: 1 };
// (user, 2026-10-04: cap 300 in the browser; native ran 600)
// webhorde: the fixed horde game = the user's native launcher run (tools/horde_flags.js: max 600, start round 100,
// Tab counter and no perk machines ticked, unstick on, spawn-from-every-window off, carry-over on). Native adds
// kisak_mod_pcore 1 (hybrid-CPU thread pinning, Windows only) and fs_game mods/horde (log folder); the page has neither.
// hordetoggle: the landing's HORDE MODE toggle (landing.js) starts any map with horde: true (maps.js MAP_LIST) in this
// game (page URL ?horde=1): the horde mod runs on any map through _zombiemode_ffotd::main_end; noperks and zinfo are
// map-independent. Same dvars on every map.
export const HORDE_GAME = { n: 300, round: 100, mods: ['zinfo', 'noperks'] };

export function hordeCount(value) {
  const n = parseInt(value, 10);
  return Math.max(HORDE_MIN, Math.min(HORDE_MAX, Number.isNaN(n) ? hordeDefaults.n : n));
}
export function hordeRound(value) {
  const round = parseInt(value, 10);
  return Math.max(1, Math.min(255, Number.isNaN(round) ? hordeDefaults.round : round));
}

// mods: every ticked mod, horde among them (fs_mods stacks them in this order). Returns +set arguments for engine.js.
export function hordeArguments({ n, round, mods }) {
  n = hordeCount(n); round = hordeRound(round);
  const set = [['fs_mods', ['horde', ...mods.filter(name => name !== 'horde')].join(' ')],
    ['horde_max_zombies', n], ['kisak_mod_maxactors', Math.min(1024, Math.max(32, n + 40))]];
  if (n > 100) set.push(['r_mod_skinCacheMB', Math.min(HORDE_SKIN_MB_MAX, Math.max(32, 16 * Math.ceil((n * 70 * 1.5 / 600 + 0.15625) / 16)))]);
  if (n > 150) set.push(['r_mod_gfxEnts', Math.min(2048, 256 * Math.ceil((n + 128) / 256))]);
  if (n > 300) set.push(['r_mod_modelLightingEntries', Math.min(5120, 32 * Math.ceil(3 * (n + 128) / 32))]);
  set.push(['kisak_mod_scriptperf', 1]);
  if (n > 300) set.push(['kisak_mod_scriptvars', 2], ['kisak_mod_netents', n >= 900 ? 2 : 1], ['r_mod_scsShare', 1],
    ['r_mod_fxElems', 4096], ['r_dobjLimit', 1024], ['kisak_mod_svfast', 1], ['cg_mod_asyncServer', 1]);
  if (round > 1) set.push(['horde_start_round', round]);
  if (mods.includes('zinfo')) set.push(['zinfo', 1]);
  if (mods.includes('noperks')) set.push(['noperks', 1]); // mods/noperks + the engine's clip removal (cm_noperks.cpp)
  if (n >= 900) set.push(['horde_fill_rate', 30]);
  return set.flatMap(([name, value]) => ['+set', name, String(value)]);
}
