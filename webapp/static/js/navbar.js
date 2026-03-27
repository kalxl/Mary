function normalizeComicCard(entry) {
  if (!entry || typeof entry !== "object") return null;
  const coverKey = entry.cover_url || entry.md_covers?.[0]?.b2key;
  const coverUrl = coverKey
    ? coverKey.startsWith("http")
      ? coverKey
      : `https://meo.comick.pictures/${coverKey}`
    : "https://placehold.co/400x600?text=No+Cover";
  const tags = [];
  const genres = entry.md_comic_md_genres || entry.genres;
  if (Array.isArray(genres)) {
    genres.forEach((genre) => {
      if (typeof genre === "string") tags.push(genre);
      else if (genre?.md_genres?.name) tags.push(genre.md_genres.name);
      else if (genre?.name) tags.push(genre.name);
    });
  }
  return {
    id: entry.hid || entry.id || entry.slug,
    slug: entry.slug || entry.hid || entry.id,
    title: entry.title || entry.name,
    description: entry.desc || entry.description,
    cover_url: coverUrl,
    tags,
    meta: `${entry.status === 1 ? 'Ongoing' : 'Completed'} • Ch. ${entry.last_chapter || 'N/A'}`
  };
}

let searchSubmitCallback = (q) => {
  window.location.href = `/browse?title=${encodeURIComponent(q)}`;
};

const ARY_THEME_STORAGE_KEY = 'aryTheme';
const ARY_LAST_USER_ID_STORAGE_KEY = 'aryLastUserId';
const ARY_THEME_PRESETS = {
  green: { accent: '#78f09a', accentDark: '#45c768', rgb: '120,240,154' },
  brown: { accent: '#b7794a', accentDark: '#9b6239', rgb: '183,121,74' },
  orange: { accent: '#ff8a00', accentDark: '#e07800', rgb: '255,138,0' },
  sakura: { accent: '#ff5aa5', accentDark: '#e44b93', rgb: '255,90,165' },
  lavender: { accent: '#b07cff', accentDark: '#9c63ff', rgb: '176,124,255' },
  crimson: { accent: '#ff3b3b', accentDark: '#e33636', rgb: '255,59,59' },
  amber: { accent: '#ffb000', accentDark: '#e39a00', rgb: '255,176,0' },
  teal: { accent: '#12d6c5', accentDark: '#0fb6a8', rgb: '18,214,197' },
  platinum: { accent: '#f0d08a', accentDark: '#d7b875', rgb: '240,208,138' },
  coral: { accent: '#ff5c5c', accentDark: '#e14f4f', rgb: '255,92,92' },
  blue: { accent: '#3b82f6', accentDark: '#2563eb', rgb: '59,130,246' },
  neutral: { accent: '#9ca3af', accentDark: '#6b7280', rgb: '156,163,175' },
  indigo: { accent: '#6366f1', accentDark: '#4f46e5', rgb: '99,102,241' },
  emerald: { accent: '#10b981', accentDark: '#059669', rgb: '16,185,129' },
};

function applyThemePreset(themeKey) {
  const preset = ARY_THEME_PRESETS[String(themeKey || '')] || null;
  if (!preset) return false;
  try {
    document.documentElement.style.setProperty('--accent', preset.accent);
    document.documentElement.style.setProperty('--accent-dark', preset.accentDark);
    if (preset.rgb) {
      document.documentElement.style.setProperty('--accent-rgb', preset.rgb);
    }
    // Switch footer logo based on theme (zoro2.png for non-green themes)
    const footerLogo = document.getElementById('footer-logo');
    if (footerLogo) {
      const isGreen = themeKey === 'green';
      footerLogo.src = isGreen ? '/static/img/zoro.png' : '/static/img/zoro2.png';
    }
    return true;
  } catch (_) {
    return false;
  }
}

async function fetchComickJson(path, params = {}) {
  const url = new URL('/api/comick/raw', window.location.origin);
  url.searchParams.set('path', path);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((entry) => url.searchParams.append(key, entry));
    else url.searchParams.set(key, value);
  });
  const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Comick API error: ${res.status}`);
  return res.json();
}

function safeText(v) {
  return String(v == null ? '' : v);
}

function loadNotifState() {
  try {
    const raw = localStorage.getItem(ARY_NOTIF_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return { cleared: {}, clearedAllAt: 0 };
    const cleared = parsed.cleared && typeof parsed.cleared === 'object' ? parsed.cleared : {};
    const clearedAllAt = typeof parsed.clearedAllAt === 'number' ? parsed.clearedAllAt : 0;
    return { cleared, clearedAllAt };
  } catch (_) {
    return { cleared: {}, clearedAllAt: 0 };
  }
}

function saveNotifState(state) {
  try {
    localStorage.setItem(ARY_NOTIF_STORAGE_KEY, JSON.stringify(state || { cleared: {}, clearedAllAt: 0 }));
  } catch (_) {}
}

function buildNotifKey(seriesHid, chapterNumber) {
  const hid = safeText(seriesHid).trim();
  const ch = Number(chapterNumber);
  return `${hid}::${Number.isFinite(ch) ? ch : '0'}`;
}

function buildNotifSeriesKey(seriesHid, lastChapterNumber) {
  const hid = safeText(seriesHid).trim();
  const ch = Number(lastChapterNumber);
  return `series::${hid}::${Number.isFinite(ch) ? ch : '0'}`;
}

function formatChapterLabel(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num <= 0) return 'New chapter';
  return `Ch. ${num}`;
}

function formatChapterRangeLabel(start, end) {
  const s = Number(start);
  const e = Number(end);
  if (!Number.isFinite(e) || e <= 0) return 'New chapters';
  if (!Number.isFinite(s) || s <= 0 || s === e) return `Ch. ${e}`;
  return `Ch. ${s}–${e}`;
}

function formatRelativeTime(tsMs) {
  const t = Number(tsMs);
  if (!Number.isFinite(t) || t <= 0) return '';
  const diff = Date.now() - t;
  if (!Number.isFinite(diff)) return '';
  const s = Math.floor(diff / 1000);
  if (s < 30) return 'just now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  return `${w}w`;
}

function pickLatestChapterTimestampMs(comic) {
  try {
    const candidates = [
      comic?.last_chapter_updated_at,
      comic?.last_update,
      comic?.updated_at,
      comic?.uploaded_at,
      comic?.created_at,
    ];
    for (const c of candidates) {
      const ms = Date.parse(String(c || ''));
      if (Number.isFinite(ms) && ms > 0) return ms;
    }
  } catch (_) {}
  return 0;
}

function normalizeChapterFeedItem(entry) {
  try {
    if (!entry || typeof entry !== 'object') return null;
    const manga = entry.md_comics || {};
    const comicCard = normalizeComicCard(manga);
    if (!comicCard) return null;
    const releasedAt =
      entry.created_at ||
      entry.createdAt ||
      entry.updated_at ||
      entry.updatedAt ||
      entry.publish_at ||
      entry.published_at;
    const seriesKey =
      manga.hid ||
      manga.id ||
      manga.slug ||
      comicCard.slug ||
      comicCard.id;
    const chapterNumber = entry.chap != null ? Number(entry.chap) : null;
    const lastChapter = manga.last_chapter != null ? Number(manga.last_chapter) : null;
    return {
      ...comicCard,
      series_hid: seriesKey ? String(seriesKey) : '',
      chapterLabel: entry.chap ? `Ch. ${entry.chap}` : '',
      chapterNumber: Number.isFinite(chapterNumber) ? chapterNumber : null,
      lastChapter: Number.isFinite(lastChapter) ? lastChapter : null,
      releasedAt: releasedAt ? String(releasedAt) : '',
    };
  } catch (_) {
    return null;
  }
}

function formatCompactRelativeTimeFromIso(iso) {
  try {
    const ms = Date.parse(String(iso || ''));
    return formatRelativeTime(ms);
  } catch (_) {
    return '';
  }
}

function normalizeSupabaseHistoryRow(row) {
  if (!row || typeof row !== 'object') return null;
  if (!row.chapter_id || !row.source) return null;
  return {
    title: row.series_title || 'Untitled',
    chapterId: String(row.chapter_id),
    chapterLabel: row.chapter_label || String(row.chapter_id),
    chapterNumber: typeof row.chapter_number === 'number' ? row.chapter_number : null,
    source: String(row.source),
    sourceSlug: row.source_slug != null ? String(row.source_slug) : null,
    seriesId: row.series_id != null ? String(row.series_id) : null,
    seriesSlug: row.series_slug != null ? String(row.series_slug) : null,
    cover: row.cover_url || null,
    cover_url: row.cover_url || null,
    readerUrl: row.reader_url || null,
    viewedAt: row.viewed_at || null,
    updatedAt: row.viewed_at || null,
    __supabaseSynced: true,
  };
}

async function refreshReaderHistoryFromSupabase(client, user) {
  try {
    if (!client || !user) return false;

    const { data, error } = await client
      .from('reading_history')
      .select(
        'series_id,series_slug,series_title,cover_url,chapter_id,chapter_number,chapter_label,source,source_slug,reader_url,viewed_at'
      )
      .eq('user_id', user.id)
      .order('viewed_at', { ascending: false })
      .limit(30);

    if (error) {
      console.warn('Failed to refresh readerHistory from Supabase', error);
      return false;
    }

    const remote = Array.isArray(data) ? data.map(normalizeSupabaseHistoryRow).filter(Boolean) : [];

    let local = [];
    try {
      const raw = localStorage.getItem('readerHistory');
      const parsed = raw ? JSON.parse(raw) : [];
      local = Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      local = [];
    }

    const unsyncedLocal = local.filter((it) => it && it.chapterId && it.source && !it.__supabaseSynced);

    const seen = new Set();
    const merged = [];

    for (const it of unsyncedLocal) {
      const key = `${it.source}::${it.chapterId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(it);
    }

    for (const it of remote) {
      const key = `${it.source}::${it.chapterId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(it);
    }

    localStorage.setItem('readerHistory', JSON.stringify(merged.slice(0, 30)));
    return true;
  } catch (err) {
    console.warn('Failed to refresh readerHistory from Supabase (exception)', err);
    return false;
  }
}

let aryLastHistoryRefreshAt = 0;
let aryLastHistorySyncUserId = '';
let aryLastHistorySyncKey = '';

function escapeHtml(str) {
  const s = String(str ?? '');
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

try {
  if (typeof window !== 'undefined') window.escapeHtml = escapeHtml;
} catch (_) {}

async function maybeSyncReadingHistory(force = false) {
  try {
    const now = Date.now();
    if (!force && now - aryLastHistoryRefreshAt < 2500) return;
    aryLastHistoryRefreshAt = now;
    const client = getSupabaseClient();
    if (!client) return;
    const { data, error } = await client.auth.getUser();
    const user = data && data.user;
    if (error || !user) return;
    await refreshReaderHistoryFromSupabase(client, user);
  } catch (_) {}
}

function maybeRefreshReaderHistory() {
  return maybeSyncReadingHistory(false);
}

function normalizeAvatarUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) return s;
  try {
    const u = new URL(s);
    const isDiscord = /discordapp\.com|discord\.com/i.test(u.hostname);
    if (isDiscord && !/\.(png|jpe?g|webp|gif)$/i.test(u.pathname)) {
      u.pathname = u.pathname.replace(/\/+$/, '') + '.png';
    }
    if (!u.searchParams.get('size')) u.searchParams.set('size', '128');
    return u.toString();
  } catch (_) {
    return s;
  }
}

function getSavedThemeKey() {
  try {
    return localStorage.getItem(ARY_THEME_STORAGE_KEY) || '';
  } catch (_) {
    return '';
  }
}

function setSavedThemeKey(themeKey) {
  try {
    localStorage.setItem(ARY_THEME_STORAGE_KEY, String(themeKey || ''));
  } catch (_) {}
}

function setLastUserId(userId) {
  try {
    const value = userId ? String(userId) : '';
    if (!value) localStorage.removeItem(ARY_LAST_USER_ID_STORAGE_KEY);
    else localStorage.setItem(ARY_LAST_USER_ID_STORAGE_KEY, value);
  } catch (_) {}
}

function getLastUserId() {
  try {
    const v = localStorage.getItem(ARY_LAST_USER_ID_STORAGE_KEY);
    return v ? String(v) : '';
  } catch (_) {
    return '';
  }
}

function applySavedTheme() {
  const key = getSavedThemeKey();
  const resolved = key || 'green';
  if (!key) {
    try { setSavedThemeKey(resolved); } catch (_) {}
  }
  applyThemePreset(resolved);
}

// Register service worker early so the app becomes installable.
try {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('/sw.js', { updateViaCache: 'none' })
        .then((reg) => {
          try {
            if (reg && typeof reg.update === 'function') reg.update();
          } catch (_) {}
        })
        .catch((err) => {
          console.warn('Service worker registration failed', err);
        });
    });
  }
} catch (_) {}

applySavedTheme();

function configureNavbarSearch(opts) {
  if (opts && typeof opts.onSubmit === 'function') {
    searchSubmitCallback = opts.onSubmit;
  }
}

let arySupabaseClient = null;

const ARY_NOTIF_STORAGE_KEY = 'aryNotificationsV1';

function getSupabaseClient() {
  if (arySupabaseClient) return arySupabaseClient;
  if (!window.supabase || !window.supabase.createClient) return null;
  try {
    const { createClient } = window.supabase;
    const SUPABASE_URL = 'https://vgcurkfpgyzuwvedtzqj.supabase.co';
    const SUPABASE_ANON_KEY =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZnY3Vya2ZwZ3l6dXd2ZWR0enFqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAwNTM3NjYsImV4cCI6MjA4NTYyOTc2Nn0.MAsL1mJIsE4noTDq05YA3a2WsygwdSAkCXRG8A07x_U';
    arySupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return arySupabaseClient;
  } catch (err) {
    console.warn('Supabase init failed', err);
    return null;
  }
}

async function upsertProfileForUser(client, user, meta, avatarUrl) {
  try {
    if (!client || !user) return;
    const payload = {
      id: user.id,
      discord_id: meta.provider_id || meta.sub || null,
      username:
        meta.username ||
        meta.preferred_username ||
        meta.full_name ||
        meta.name ||
        null,
      display_name: meta.full_name || meta.name || null,
      avatar_url: avatarUrl || null,
      email: user.email || meta.email || null,
    };

    const { data: existing, error: existingError } = await client
      .from('profiles')
      .select('id,discord_id,username,display_name,avatar_url,email')
      .eq('id', user.id)
      .maybeSingle();

    if (existingError) {
      console.warn('Failed to check existing profile', existingError);
      return;
    }

    // If no profile row exists yet, create it.
    if (!existing || !existing.id) {
      const { error } = await client.from('profiles').insert(payload);
      if (error) console.warn('Failed to create profile', error);
      return;
    }

    // Profile exists: never overwrite user-customized fields on refresh.
    // Only fill missing/empty values.
    const update = {};
    const isEmpty = (v) => v == null || String(v).trim() === '';

    if (isEmpty(existing.discord_id) && payload.discord_id) update.discord_id = payload.discord_id;
    if (isEmpty(existing.email) && payload.email) update.email = payload.email;
    if (isEmpty(existing.username) && payload.username) update.username = payload.username;
    if (isEmpty(existing.display_name) && payload.display_name) update.display_name = payload.display_name;
    if (isEmpty(existing.avatar_url) && payload.avatar_url) update.avatar_url = payload.avatar_url;

    if (Object.keys(update).length === 0) return;

    const { error } = await client.from('profiles').update(update).eq('id', user.id);
    if (error) console.warn('Failed to update profile defaults', error);
  } catch (err) {
    console.warn('Failed to upsert profile', err);
  }
}

async function syncLocalReadingHistoryToSupabase(client, user) {
  try {
    if (!client || !user) return;
    const raw = localStorage.getItem('readerHistory');
    if (!raw) return;
    const items = JSON.parse(raw);
    if (!Array.isArray(items) || items.length === 0) return;

    const pending = items.filter((it) => it && !it.__supabaseSynced && it.chapterId && it.source);
    if (pending.length === 0) return;

    const payload = pending.map((entry) => ({
      user_id: user.id,
      series_id: entry.seriesId != null ? String(entry.seriesId) : null,
      series_slug: entry.seriesSlug != null ? String(entry.seriesSlug) : null,
      series_title: entry.title || 'Untitled',
      cover_url: entry.cover || entry.cover_url || null,
      chapter_id: String(entry.chapterId),
      chapter_number: entry.chapterNumber != null ? entry.chapterNumber : null,
      chapter_label: entry.chapterLabel || String(entry.chapterId),
      source: String(entry.source),
      source_slug: entry.sourceSlug != null ? String(entry.sourceSlug) : null,
      reader_url: entry.readerUrl || null,
      viewed_at: entry.viewedAt || entry.updatedAt || new Date().toISOString(),
    }));

    const { error } = await client
      .from('reading_history')
      .upsert(payload, { onConflict: 'user_id,source,chapter_id', ignoreDuplicates: true });

    if (error) {
      console.warn('Failed to sync local reading history', error);
      return;
    }

    const syncedKeys = new Set(pending.map((it) => `${it.source}::${it.chapterId}`));
    const updated = items.map((it) => {
      if (!it || !it.source || !it.chapterId) return it;
      const k = `${it.source}::${it.chapterId}`;
      if (!syncedKeys.has(k)) return it;
      return { ...it, __supabaseSynced: true };
    });
    localStorage.setItem('readerHistory', JSON.stringify(updated));
  } catch (err) {
    console.warn('Failed to sync local reading history (exception)', err);
  }
}

function initNavbar() {
  try {
    // Don't lock initialization until the navbar markup exists.
    // Some pages mount the navbar into #navbar-mount asynchronously.
    if (!document.querySelector('.nav-wrapper')) return;
    if (window.__aryNavbarInited) return;
    window.__aryNavbarInited = true;
  } catch (_) {}

  try {
    document.body.classList.add('has-floating-nav');
  } catch (_) {}

  // ── Search elements ──
  const searchInput = document.getElementById('search-input');
  const mobileSearchInput = document.getElementById('mobile-search-input');
  const searchOverlay = document.getElementById('mobile-search-overlay');
  const searchResults = document.getElementById('search-popup-results');
  const searchModeComicsBtn = document.getElementById('search-mode-comics');
  const searchModeUsersBtn = document.getElementById('search-mode-users');
  const searchTriggers = document.querySelectorAll('[data-search-open]');
  const searchCloseTriggers = document.querySelectorAll('[data-search-close]');
  const pwaInstallBtns = Array.from(document.querySelectorAll('[data-pwa-install]') || []);

  // ── Theme modal ──
  const themeModal = document.getElementById('theme-modal');
  const themeOpenTriggers = document.querySelectorAll('[data-theme-open]');
  const themeCloseTriggers = document.querySelectorAll('[data-theme-close]');
  const themeGrid = document.querySelector('[data-theme-grid]');
  const settingsTabs = Array.from(document.querySelectorAll('[data-settings-tab]') || []);
  const settingsPanels = Array.from(document.querySelectorAll('[data-settings-panel]') || []);

  const readerModeButtons = Array.from(document.querySelectorAll('[data-reader-mode]') || []);
  const readerProgressModeSelect = document.querySelector('[data-reader-progress-mode]');
  const readerProgressToggleBtn = document.querySelector('[data-reader-progress-toggle]');
  const readerScrollTopToggleBtn = document.querySelector('[data-reader-scrolltop-toggle]');
  const readerGapRange = document.querySelector('[data-reader-gap-range]');
  const readerGapValue = document.querySelector('[data-reader-gap-value]');
  const readerShortcutsToggleBtn = document.querySelector('[data-reader-shortcuts-toggle]');

  function getLsBool(key, fallback = true) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null || raw === undefined || raw === '') return !!fallback;
      return String(raw) !== 'false';
    } catch (_) {
      return !!fallback;
    }
  }

  function setLsBool(key, value) {
    try {
      localStorage.setItem(key, value ? 'true' : 'false');
    } catch (_) {}
  }

  function getLsStr(key, fallback = '') {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? String(fallback || '') : String(raw);
    } catch (_) {
      return String(fallback || '');
    }
  }

  function setLsStr(key, value) {
    try {
      localStorage.setItem(key, String(value ?? ''));
    } catch (_) {}
  }

  function clampNum(v, min, max) {
    const n = Number(v);
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
  }

  function getReaderPrefs() {
    const readingMode = getLsStr('readerReadingMode', 'strip') === 'page' ? 'page' : 'strip';
    const progressEnabled = getLsBool('readerProgressEnabled', true);
    const progressModeRaw = getLsStr('readerProgressMode', 'top');
    const progressMode = progressModeRaw === 'ui' || progressModeRaw === 'minimal' ? progressModeRaw : 'top';
    const scrollTopEnabled = getLsBool('readerScrollTopEnabled', true);
    const gap = clampNum(getLsStr('readerPageGap', '0'), 0, 40);
    const shortcutsEnabled = getLsBool('readerShortcutsEnabled', true);
    return { readingMode, progressEnabled, progressMode, scrollTopEnabled, gap, shortcutsEnabled };
  }

  function applyReaderPrefsToUi(prefs) {
    const p = prefs || getReaderPrefs();

    readerModeButtons.forEach((btn) => {
      const key = String(btn.getAttribute('data-reader-mode') || '').toLowerCase();
      btn.classList.toggle('active', key === p.readingMode);
    });

    if (readerProgressModeSelect) {
      readerProgressModeSelect.value = p.progressMode;
    }

    if (readerProgressToggleBtn) {
      readerProgressToggleBtn.classList.toggle('active', !!p.progressEnabled);
      readerProgressToggleBtn.textContent = p.progressEnabled ? 'On' : 'Off';
    }

    const pageMode = p.readingMode === 'page';
    if (readerScrollTopToggleBtn) {
      const enabled = pageMode ? false : !!p.scrollTopEnabled;
      readerScrollTopToggleBtn.disabled = pageMode;
      readerScrollTopToggleBtn.classList.toggle('active', enabled);
      readerScrollTopToggleBtn.textContent = enabled ? 'On' : 'Off';
    }

    if (readerGapRange) {
      const gap = pageMode ? 0 : clampNum(p.gap, 0, 40);
      readerGapRange.disabled = pageMode;
      readerGapRange.value = String(gap);
    }
    if (readerGapValue) {
      const gap = pageMode ? 0 : clampNum(p.gap, 0, 40);
      readerGapValue.textContent = `${gap}px`;
    }

    if (readerShortcutsToggleBtn) {
      readerShortcutsToggleBtn.classList.toggle('active', !!p.shortcutsEnabled);
      readerShortcutsToggleBtn.textContent = p.shortcutsEnabled ? 'On' : 'Off';
    }
  }

  function setReadingModePref(mode) {
    const next = String(mode || '').toLowerCase() === 'page' ? 'page' : 'strip';
    setLsStr('readerReadingMode', next);
    if (next === 'page') {
      // Mirror reader.html behavior: page mode disables scroll-to-top and page gap.
      setLsBool('readerScrollTopEnabled', false);
      setLsStr('readerPageGap', '0');
    }
    applyReaderPrefsToUi();
  }

  // ── Sidebar elements ──
  const mobileSidebar = document.getElementById('mobile-sidebar');
  const navToggle = document.querySelector('[data-nav-toggle]');   // mobile hamburger
  const navClose = document.querySelector('[data-nav-close]');

  // ── Login modal ──
  const loginModal = document.getElementById('login-modal');
  const loginOpenTriggers = document.querySelectorAll('[data-login-open]');
  const loginCloseTriggers = document.querySelectorAll('[data-login-close]');

  // ── Desktop profile dropdown ──
  const profileToggle = document.querySelector('[data-profile-toggle]');
  const profileDropdown = document.getElementById('profile-dropdown');

  // ── Notifications dropdown ──
  const notifToggleButtons = Array.from(document.querySelectorAll('[data-notif-toggle]') || []);
  const notifDropdown = document.getElementById('notifications-dropdown');
  const notifCloseButtons = Array.from(document.querySelectorAll('[data-notif-close]') || []);
  const notifList = document.querySelector('[data-notif-list]');
  const notifEmpty = document.querySelector('[data-notif-empty]');
  const notifBadgeEls = Array.from(document.querySelectorAll('[data-notif-badge]') || []);

  let notifCache = { items: null, loadedAt: 0, userId: '' };
  const NOTIF_CACHE_TTL_MS = 2 * 60 * 1000;

  // ─────────────────── NOTIFICATIONS ────────────────
  const setBadgeCount = (n) => {
    const value = Math.max(0, Number(n) || 0);
    notifBadgeEls.forEach((el) => {
      if (!el) return;
      el.textContent = value > 99 ? '99+' : String(value);
      el.classList.toggle('show', value > 0);
      el.setAttribute('aria-hidden', value > 0 ? 'false' : 'true');
    });
  };

  const closeNotifDropdown = () => {
    if (!notifDropdown) return;
    notifDropdown.classList.remove('open');
    notifDropdown.setAttribute('aria-hidden', 'true');
  };

  const openNotifDropdown = () => {
    if (!notifDropdown) return;
    notifDropdown.classList.add('open');
    notifDropdown.setAttribute('aria-hidden', 'false');
  };

  const renderNotifEmpty = (text) => {
    if (notifEmpty) notifEmpty.textContent = safeText(text);
    if (notifList) notifList.innerHTML = '';
    setBadgeCount(0);
  };

  const renderNotifLoading = () => {
    if (notifEmpty) notifEmpty.textContent = '';
    if (notifList) {
      notifList.innerHTML = '<div class="notif-loading"><div class="notif-spinner" aria-label="Loading" role="status"></div></div>';
    }
  };

  async function computeNotifications(client, userId) {
    const state = loadNotifState();
    const cleared = state.cleared || {};

    // Pending 1v1 invites (best-effort; table may not exist yet)
    let inviteItems = [];
    try {
      const { data: invites, error: invErr } = await client
        .from('game_invites')
        .select('id,from_display,from_username,from_avatar_url,invite_url,created_at')
        .eq('to_user_id', userId)
        .eq('status', 'pending')
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(10);
      if (!invErr && Array.isArray(invites) && invites.length) {
        inviteItems = invites
          .map((row) => {
            const id = safeText(row?.id).trim();
            const href = safeText(row?.invite_url).trim();
            const createdAt = safeText(row?.created_at).trim();
            const createdMs = Date.parse(createdAt || 0) || 0;
            const key = `invite::${id || href || createdMs}`;
            if (!id || !href) return null;
            if (cleared[key]) return null;
            const fromName = safeText(row?.from_username || row?.from_display || 'Someone');
            const avatar = safeText(row?.from_avatar_url || '').trim();
            return {
              key,
              series_hid: '',
              title: `${fromName} has invited you to play`,
              cover_url: avatar || 'https://placehold.co/120x120/111111/222222?text=VS',
              chapter_label: 'Tap to play',
              time_label: createdAt ? formatCompactRelativeTimeFromIso(createdAt) : '',
              href,
            };
          })
          .filter(Boolean);
      }
    } catch (_) {
      inviteItems = [];
    }

    const { data, error } = await client
      .from('library_entries')
      .select('series_hid')
      .eq('user_id', userId);
    if (error) throw error;

    const seriesIds = Array.from(
      new Set((Array.isArray(data) ? data : []).map((row) => row && row.series_hid).filter(Boolean))
    ).map((v) => String(v));
    if (!seriesIds.length) return [];

    const bestBySeries = new Map();
    const MAX_PAGES = 10;

    // First pass: collect lastChapter values per series across all pages
    const lastChapterBySeries = new Map();
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      let chaptersPayload = null;
      try {
        chaptersPayload = await fetchComickJson('/chapter', {
          page,
          order: 'new',
          lang: 'en',
          accept_erotic_content: 'false',
        });
      } catch (_) {
        chaptersPayload = null;
      }
      const rawList = Array.isArray(chaptersPayload) ? chaptersPayload : [];
      if (!rawList.length) break;

      for (const entry of rawList) {
        const manga = entry.md_comics || {};
        const seriesId = manga.hid || manga.id || manga.slug;
        if (!seriesId) continue;
        const lc = manga.last_chapter != null ? Number(manga.last_chapter) : null;
        if (lc !== null && Number.isFinite(lc)) {
          const prev = lastChapterBySeries.get(seriesId);
          if (prev === undefined || lc > prev) {
            lastChapterBySeries.set(seriesId, lc);
          }
        }
      }
    }

    // Second pass: process and filter
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      let chaptersPayload = null;
      try {
        chaptersPayload = await fetchComickJson('/chapter', {
          page,
          order: 'new',
          lang: 'en',
          accept_erotic_content: 'false',
        });
      } catch (_) {
        chaptersPayload = null;
      }
      const rawList = Array.isArray(chaptersPayload) ? chaptersPayload : [];
      if (!rawList.length) break;

      const normalized = rawList
        .map(normalizeChapterFeedItem)
        .filter((item) => item && item.series_hid && seriesIds.includes(item.series_hid))
        .filter((item) => {
          // Skip backfilled chapters: only show if chapter >= lastChapter
          const chapNum = typeof item.chapterNumber === 'number' ? item.chapterNumber : null;
          let lastChap = typeof item.lastChapter === 'number' ? item.lastChapter : null;
          // Use cached lastChapter if this entry's is null
          if (lastChap === null) {
            lastChap = lastChapterBySeries.get(item.series_hid) ?? null;
          }
          if (chapNum !== null && lastChap !== null && chapNum < lastChap) return false;
          return true;
        });

      for (const item of normalized) {
        const key = String(item.series_hid || '');
        if (!key) continue;
        const prev = bestBySeries.get(key);
        if (!prev) {
          bestBySeries.set(key, item);
          continue;
        }
        // Pick the highest chapter number, use oldest release time as tiebreaker
        const prevChap = typeof prev.chapterNumber === 'number' ? prev.chapterNumber : -Infinity;
        const currChap = typeof item.chapterNumber === 'number' ? item.chapterNumber : -Infinity;
        if (currChap > prevChap) {
          bestBySeries.set(key, item);
        } else if (currChap === prevChap) {
          const prevTime = Date.parse(prev.releasedAt || 0) || 0;
          const currTime = Date.parse(item.releasedAt || 0) || 0;
          if (currTime < prevTime) bestBySeries.set(key, item); // pick older
        }
      }
    }

    const allItems = Array.from(bestBySeries.values());
    if (!allItems.length) return [];

    const sorted = allItems
      .sort((a, b) => (Date.parse(b.releasedAt || 0) || 0) - (Date.parse(a.releasedAt || 0) || 0))
      .slice(0, 18);

    const out = [];
    for (const it of sorted) {
      const hid = safeText(it.series_hid).trim();
      if (!hid) continue;
      const chapN = typeof it.chapterNumber === 'number' ? it.chapterNumber : null;
      const chapterLabel = safeText(it.chapterLabel || (chapN != null ? `Ch. ${chapN}` : ''));
      const timeLabel = formatCompactRelativeTimeFromIso(it.releasedAt);
      const releasedMs = Date.parse(it.releasedAt || 0) || 0;
      const key = `chapter::${hid}::${chapterLabel}`;
      if (cleared[key]) continue;
      out.push({
        key,
        series_hid: hid,
        title: safeText(it.title || 'Untitled'),
        cover_url: safeText(it.cover_url || 'https://placehold.co/400x560/111111/222222?text=Cover'),
        chapter_label: chapterLabel,
        time_label: timeLabel,
        href: `/series?slug=${encodeURIComponent(hid)}`,
      });
    }

    // Put invites first so they are visible.
    return [...inviteItems, ...out];
  }

  function renderNotifList(items, loggedIn) {
    if (!notifDropdown) return;
    if (!loggedIn) {
      const msg = 'Sign in to get updates about new chapters in your library.';
      if (notifEmpty) {
        notifEmpty.classList.add('notif-empty-center');
        notifEmpty.innerHTML = `
          <div class="notif-empty-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 7h18s-3 0-3-7"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
          </div>
          <div class="notif-empty-text">${safeText(msg)}</div>
        `;
      }
      if (notifList) notifList.innerHTML = '';
      setBadgeCount(0);
      return;
    }

    const arr = Array.isArray(items) ? items : [];
    setBadgeCount(arr.length);
    if (!arr.length) {
      if (notifEmpty) {
        notifEmpty.classList.add('notif-empty-center');
        notifEmpty.innerHTML = `
          <div class="notif-empty-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 7h18s-3 0-3-7"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
          </div>
          <div class="notif-empty-text">No new chapters right now.</div>
        `;
      }
      if (notifList) notifList.innerHTML = '';
      return;
    }
    if (notifEmpty) {
      notifEmpty.classList.remove('notif-empty-center');
      notifEmpty.textContent = '';
    }

    if (notifList) {
      notifList.innerHTML = arr
        .map((it) => {
          const title = safeText(it.title);
          const chapter = safeText(it.chapter_label);
          const cover = safeText(it.cover_url);
          const href = safeText(it.href);
          const key = safeText(it.key);
          const time = safeText(it.time_label);
          const coverClass = key && String(key).startsWith('invite::') ? 'notif-cover notif-cover-round' : 'notif-cover';
          return `
            <a class="notif-item" href="${href}" data-notif-item="${key}">
              <div class="${coverClass}"><img src="${cover}" alt="" /></div>
              <div class="notif-meta">
                <div class="notif-series">${title.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
                <div class="notif-chapter-row">
                  <div class="notif-chapter">${chapter.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
                  ${time ? `<div class=\"notif-time\">${time.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>` : ''}
                </div>
              </div>
              <div class="notif-item-actions">
                <button type="button" class="notif-mini-btn" aria-label="Dismiss" data-notif-item-clear="${key}">
                  <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
            </a>
          `;
        })
        .join('');
    }
  }

  async function refreshNotifications() {
    if (!notifDropdown) return;
    const client = getSupabaseClient();
    if (!client) {
      renderNotifEmpty('Sign in to get updates about new chapters in your library.');
      return;
    }
    let userId = null;
    try {
      const { data: userRes } = await client.auth.getUser();
      userId = userRes?.user?.id || null;
    } catch (_) {
      userId = null;
    }
    if (!userId) {
      renderNotifList([], false);
      return;
    }

    const now = Date.now();
    const cacheOk =
      notifCache &&
      notifCache.items &&
      notifCache.userId === userId &&
      notifCache.loadedAt &&
      now - notifCache.loadedAt < NOTIF_CACHE_TTL_MS;

    if (cacheOk) {
      renderNotifList(notifCache.items, true);
      return;
    }

    try {
      renderNotifLoading();
      const items = await computeNotifications(client, userId);
      notifCache = { items, loadedAt: Date.now(), userId };
      renderNotifList(items, true);
    } catch (err) {
      console.warn('Failed to load notifications', err);
      renderNotifEmpty('Unable to load updates right now.');
    }
  }

  try {
    window.__aryRefreshNotifications = refreshNotifications;
  } catch (_) {}

  if (notifToggleButtons.length && notifDropdown) {
    notifToggleButtons.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const open = notifDropdown.classList.contains('open');
        if (open) {
          closeNotifDropdown();
          return;
        }
        try {
          if (profileDropdown) profileDropdown.classList.remove('open');
        } catch (_) {}
        openNotifDropdown();
        refreshNotifications();
      });
    });
  }

  notifCloseButtons.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      closeNotifDropdown();
    });
  });

  if (notifDropdown) {
    document.addEventListener('click', (e) => {
      try {
        if (!notifDropdown.classList.contains('open')) return;
        const clickedToggle = e.target && e.target.closest && e.target.closest('[data-notif-toggle]');
        if (clickedToggle) return;
        if (!notifDropdown.contains(e.target)) closeNotifDropdown();
      } catch (_) {}
    });

    notifDropdown.addEventListener('click', async (e) => {
      const clearBtn = e.target && e.target.closest ? e.target.closest('[data-notif-item-clear]') : null;
      if (clearBtn) {
        e.preventDefault();
        e.stopPropagation();
        const key = clearBtn.getAttribute('data-notif-item-clear');

        // If this is a 1v1 invite, also decline it in Supabase so it disappears for real.
        try {
          if (key && String(key).startsWith('invite::')) {
            const inviteId = String(key).split('invite::')[1] || '';
            const client = getSupabaseClient();
            if (client && inviteId) {
              await client.from('game_invites').update({ status: 'declined' }).eq('id', inviteId);
            }
          }
        } catch (_) {}

        const state = loadNotifState();
        state.cleared = state.cleared && typeof state.cleared === 'object' ? state.cleared : {};
        state.cleared[key] = Date.now();
        saveNotifState(state);
        notifCache = { items: null, loadedAt: 0, userId: '' };
        await refreshNotifications();
      }
    });
  }

  // Preload once so the badge shows up without opening the dropdown.
  try {
    refreshNotifications();
  } catch (_) {}

  // Background refresh so new chapters appear without a page reload.
  // Guarded to avoid duplicate intervals if initNavbar retries.
  try {
    if (!window.__aryNotifPollBound) {
      window.__aryNotifPollBound = true;
      window.setInterval(() => {
        try {
          if (document.visibilityState !== 'visible') return;
          refreshNotifications();
        } catch (_) {}
      }, 120000);
    }
  } catch (_) {}

  // Refresh on focus (lightweight due to caching).
  try {
    if (!window.__aryNotifFocusBound) {
      window.__aryNotifFocusBound = true;
      window.addEventListener('focus', () => {
        try {
          refreshNotifications();
        } catch (_) {}
      });
    }
  } catch (_) {}

  // ── Mobile person btn + mobile dropdown ──
  const mobilePersonBtn        = document.querySelector('[data-mobile-person]');
  const mobileProfileDropdown  = document.getElementById('mobile-profile-dropdown');
  const mobileLogoutBtn        = document.querySelector('[data-mobile-logout]');

  const canUseSearch = !!(searchOverlay && mobileSearchInput && searchResults);
  let searchMode = 'comics';

  // ── Move modals to body to avoid z-index stacking issues ──
  if (searchOverlay)           document.body.appendChild(searchOverlay);
  if (mobileSidebar)           document.body.appendChild(mobileSidebar);
  if (loginModal)              document.body.appendChild(loginModal);
  if (mobileProfileDropdown)   document.body.appendChild(mobileProfileDropdown);
  if (themeModal)              document.body.appendChild(themeModal);

  function refreshThemeSelectionUI() {
    if (!themeGrid) return;
    const selected = getSavedThemeKey();
    themeGrid.querySelectorAll('[data-theme]').forEach((btn) => {
      const key = btn.getAttribute('data-theme') || '';
      btn.setAttribute('aria-pressed', key && selected && key === selected ? 'true' : 'false');
    });
  }

  function setSettingsTab(tabKey) {
    const key = String(tabKey || '').trim().toLowerCase();
    if (!key) return;
    settingsTabs.forEach((btn) => {
      const k = String(btn.getAttribute('data-settings-tab') || '').trim().toLowerCase();
      const active = k === key;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    settingsPanels.forEach((panel) => {
      const k = String(panel.getAttribute('data-settings-panel') || '').trim().toLowerCase();
      panel.classList.toggle('active', k === key);
    });
  }

  function openThemeModal() {
    if (!themeModal) return;
    try {
      if (mobileSidebar && mobileSidebar.classList.contains('open')) {
        mobileSidebar.classList.remove('open');
      }
    } catch (_) {}

    const open = () => {
      try {
        const initialTab = (settingsTabs[0] && settingsTabs[0].getAttribute('data-settings-tab')) || 'appearance';
        setSettingsTab(initialTab);
      } catch (_) {}
      refreshThemeSelectionUI();
      applyReaderPrefsToUi();
      themeModal.classList.add('open');
      themeModal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('nav-locked');
    };

    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(open);
    } else {
      setTimeout(open, 0);
    }
  }

  function closeThemeModal() {
    if (!themeModal) return;
    themeModal.classList.remove('open');
    themeModal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('nav-locked');
  }

  window.__openThemeModal = openThemeModal;
  window.__closeThemeModal = closeThemeModal;

  themeOpenTriggers.forEach((trigger) => {
    trigger.addEventListener('click', (e) => {
      e.preventDefault();
      openThemeModal();
    });
  });

  if (!window.__aryThemeDelegatedClickBound) {
    window.__aryThemeDelegatedClickBound = true;
    document.addEventListener('click', (e) => {
      const t = e.target && e.target.closest ? e.target.closest('[data-theme-open]') : null;
      if (!t) return;
      e.preventDefault();
      openThemeModal();
    });
  }

  themeCloseTriggers.forEach((trigger) => {
    trigger.addEventListener('click', (e) => {
      e.preventDefault();
      closeThemeModal();
    });
  });

  if (themeModal) {
    themeModal.addEventListener('click', (e) => {
      if (e.target === themeModal) closeThemeModal();
    });
  }

  if (themeGrid) {
    themeGrid.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-theme]');
      if (!btn) return;
      const key = btn.getAttribute('data-theme');
      if (!key) return;
      if (applyThemePreset(key)) {
        setSavedThemeKey(key);
        refreshThemeSelectionUI();
      }
    });
  }

  if (settingsTabs.length) {
    settingsTabs.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const key = btn.getAttribute('data-settings-tab');
        setSettingsTab(key);
      });
    });
  }

  if (readerModeButtons.length) {
    readerModeButtons.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const key = btn.getAttribute('data-reader-mode');
        setReadingModePref(key);
      });
    });
  }

  if (readerProgressModeSelect) {
    readerProgressModeSelect.addEventListener('change', () => {
      const v = readerProgressModeSelect.value;
      const next = v === 'ui' || v === 'minimal' ? v : 'top';
      setLsStr('readerProgressMode', next);
      applyReaderPrefsToUi();
    });
  }

  if (readerProgressToggleBtn) {
    readerProgressToggleBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const current = getLsBool('readerProgressEnabled', true);
      setLsBool('readerProgressEnabled', !current);
      applyReaderPrefsToUi();
    });
  }

  if (readerScrollTopToggleBtn) {
    readerScrollTopToggleBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const prefs = getReaderPrefs();
      if (prefs.readingMode === 'page') return;
      setLsBool('readerScrollTopEnabled', !prefs.scrollTopEnabled);
      applyReaderPrefsToUi();
    });
  }

  if (readerGapRange) {
    const handleGap = () => {
      const prefs = getReaderPrefs();
      if (prefs.readingMode === 'page') return;
      const gap = clampNum(readerGapRange.value, 0, 40);
      setLsStr('readerPageGap', String(gap));
      applyReaderPrefsToUi();
    };
    readerGapRange.addEventListener('input', handleGap);
    readerGapRange.addEventListener('change', handleGap);
  }

  if (readerShortcutsToggleBtn) {
    readerShortcutsToggleBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const current = getLsBool('readerShortcutsEnabled', true);
      setLsBool('readerShortcutsEnabled', !current);
      applyReaderPrefsToUi();
    });
  }

  // ─────────────────── SEARCH ───────────────────
  if (canUseSearch) {
    searchTriggers.forEach(trigger => {
      trigger.addEventListener('click', (e) => {
        e.preventDefault();
        searchOverlay.classList.add('open');
        document.body.classList.add('nav-locked');
        setTimeout(() => mobileSearchInput.focus(), 100);
      });
    });
  }

  // ─────────────────── PWA INSTALL ───────────────────
  let deferredPwaPrompt = null;
  const isStandalone = () => {
    try {
      return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone;
    } catch (_) {
      return false;
    }
  };

  const applyStandaloneClass = () => {
    try {
      document.documentElement.classList.toggle('is-standalone', isStandalone());
    } catch (_) {}
  };

  const isIOS = () => {
    try {
      const ua = String(navigator.userAgent || '');
      return /iphone|ipad|ipod/i.test(ua) && !('MSStream' in window);
    } catch (_) {
      return false;
    }
  };

  const isAndroid = () => {
    try {
      const ua = String(navigator.userAgent || '');
      return /android/i.test(ua);
    } catch (_) {
      return false;
    }
  };

  const hidePwaInstall = () => {
    if (!pwaInstallBtns.length) return;
    pwaInstallBtns.forEach((btn) => {
      if (!btn) return;
      btn.classList.add('is-hidden');
      btn.setAttribute('aria-hidden', 'true');
      try {
        btn.style.display = 'none';
      } catch (_) {}
    });
  };

  const showPwaInstall = () => {
    if (!pwaInstallBtns.length) return;
    pwaInstallBtns.forEach((btn) => {
      if (!btn) return;
      btn.classList.remove('is-hidden');
      btn.setAttribute('aria-hidden', 'false');
      try {
        btn.style.display = '';
      } catch (_) {}
    });
  };

  const setPwaInstallLabel = (text) => {
    if (!pwaInstallBtns.length) return;
    pwaInstallBtns.forEach((btn) => {
      if (!btn) return;
      try {
        const labelEl = btn.querySelector('[data-pwa-label]');
        if (labelEl) {
          labelEl.textContent = text;
        } else {
          btn.textContent = text;
        }
      } catch (_) {}
    });
  };

  if (pwaInstallBtns.length) {
    pwaInstallBtns.forEach((btn) => {
      if (!btn) return;
      btn.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!deferredPwaPrompt) {
        if (isIOS()) {
          try {
            alert('To install: tap the Share button, then choose “Add to Home Screen”.');
          } catch (_) {}
          return;
        }
        if (isAndroid()) {
          try {
            alert('To install: open your browser menu (⋮) and tap “Install app” or “Add to Home screen”.');
          } catch (_) {}
        }
        return;
      }
      try {
        deferredPwaPrompt.prompt();
        const choice = await deferredPwaPrompt.userChoice;
        deferredPwaPrompt = null;
        hidePwaInstall();
        if (choice && choice.outcome === 'accepted') {
          try { if (mobileSidebar && mobileSidebar.classList.contains('open')) mobileSidebar.classList.remove('open'); } catch (_) {}
        }
      } catch (_) {
        deferredPwaPrompt = null;
        hidePwaInstall();
      }
      });
    });
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    if (isStandalone()) return;
    deferredPwaPrompt = e;
    showPwaInstall();
  });

  window.addEventListener('appinstalled', () => {
    deferredPwaPrompt = null;
    hidePwaInstall();
  });

  if (isStandalone()) {
    hidePwaInstall();
  } else {
    showPwaInstall();
  }

  applyStandaloneClass();
  try {
    const mm = window.matchMedia ? window.matchMedia('(display-mode: standalone)') : null;
    if (mm && typeof mm.addEventListener === 'function') {
      mm.addEventListener('change', () => {
        applyStandaloneClass();
        if (isStandalone()) hidePwaInstall();
      });
    } else if (mm && typeof mm.addListener === 'function') {
      mm.addListener(() => {
        applyStandaloneClass();
        if (isStandalone()) hidePwaInstall();
      });
    }
  } catch (_) {}

  if (!isStandalone() && isIOS()) {
    showPwaInstall();
    setPwaInstallLabel('Add to Home Screen');
  }

  if (!isStandalone() && !isIOS() && isAndroid()) {
    // Some Android/Chrome builds don't reliably emit beforeinstallprompt,
    // or the user is still missing one installability criterion.
    // Show a manual install entry so the sidebar always contains the option.
    setPwaInstallLabel('Install App');
    setTimeout(() => {
      if (isStandalone()) return;
      showPwaInstall();
    }, 1200);
  }

  if (!isStandalone() && !isIOS() && !isAndroid()) {
    setPwaInstallLabel('Install App');
    showPwaInstall();
  }

  if (searchInput && canUseSearch) {
    searchInput.addEventListener('click', () => {
      searchOverlay.classList.add('open');
      document.body.classList.add('nav-locked');
      setTimeout(() => {
        mobileSearchInput.focus();
        mobileSearchInput.value = searchInput.value;
      }, 100);
    });

    searchInput.addEventListener('input', (e) => {
      if (e.target.value.length > 0 && !searchOverlay.classList.contains('open')) {
        searchOverlay.classList.add('open');
        document.body.classList.add('nav-locked');
        setTimeout(() => {
          mobileSearchInput.value = searchInput.value;
          mobileSearchInput.focus();
          mobileSearchInput.dispatchEvent(new Event('input'));
        }, 100);
      }
    });
  }

  if (canUseSearch) {
    searchCloseTriggers.forEach(trigger => {
      trigger.addEventListener('click', () => closeSearchPopup());
    });

    searchOverlay.addEventListener('click', (e) => {
      if (e.target === searchOverlay) closeSearchPopup();
    });
  }

  function closeSearchPopup() {
    if (!canUseSearch) return;
    searchOverlay.classList.remove('open');
    document.body.classList.remove('nav-locked');
    mobileSearchInput.value = '';
    if (searchInput) searchInput.value = '';
    resetSearchResults();
  }

  function goToBrowseSearch(rawQuery) {
    const q = String(rawQuery || '').trim();
    if (!q) return;
    try {
      const url = new URL('/browse', window.location.origin);
      url.searchParams.set('title', q);
      url.searchParams.set('order', 'user_follow_count');
      if (canUseSearch && searchOverlay && searchOverlay.classList.contains('open')) {
        closeSearchPopup();
      }
      window.location.href = url.toString();
    } catch (_) {
      // Fallback
      const title = encodeURIComponent(q).replace(/%20/g, '+');
      window.location.href = `/browse?title=${title}&order=user_follow_count`;
    }
  }

  function resetSearchResults() {
    if (!searchResults) return;
    searchResults.innerHTML = `
      <div class="search-popup-empty-state">
        <div class="search-icon-circle">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2" fill="none" />
            <line x1="16.5" y1="16.5" x2="21" y2="21" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
        </div>
        <h3>Search anything</h3>
        <p>Find manga titles, navigate to different pages, or revisit<br>your recent searches</p>
      </div>
    `;
  }

  function applySearchMode(next){
    searchMode = (next === 'users') ? 'users' : 'comics';
    try{
      if(searchModeComicsBtn){
        searchModeComicsBtn.classList.toggle('active', searchMode === 'comics');
        searchModeComicsBtn.setAttribute('aria-pressed', searchMode === 'comics' ? 'true' : 'false');
      }
      if(searchModeUsersBtn){
        searchModeUsersBtn.classList.toggle('active', searchMode === 'users');
        searchModeUsersBtn.setAttribute('aria-pressed', searchMode === 'users' ? 'true' : 'false');
      }
    }catch(_){ }
    try{
      mobileSearchInput.dispatchEvent(new Event('input'));
    }catch(_){ }
  }

  if(canUseSearch && searchModeComicsBtn && !searchModeComicsBtn.dataset.bound){
    searchModeComicsBtn.dataset.bound='1';
    searchModeComicsBtn.addEventListener('click', ()=>applySearchMode('comics'));
  }
  if(canUseSearch && searchModeUsersBtn && !searchModeUsersBtn.dataset.bound){
    searchModeUsersBtn.dataset.bound='1';
    searchModeUsersBtn.addEventListener('click', ()=>applySearchMode('users'));
  }

  let searchTimeout;
  if (canUseSearch) mobileSearchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const query = e.target.value.trim();

    if (query.length < 2) {
      resetSearchResults();
      return;
    }

    searchResults.innerHTML = `
      <div class="search-loading" style="padding: 60px 20px; text-align: center;">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="56" stroke-dashoffset="14" fill="none" />
        </svg>
        <p style="color: var(--text-gray);">Searching...</p>
      </div>
    `;

    searchTimeout = setTimeout(async () => {
      try {
        if(searchMode === 'users'){
          const client = getSupabaseClient();
          if(!client) throw new Error('Supabase client not available');
          const q = query.toLowerCase();
          const { data, error } = await client
            .from('profiles')
            .select('id,username,display_name,avatar_url')
            .or(`username.ilike.%${q}%,display_name.ilike.%${q}%`)
            .limit(24);
          if(error) throw error;
          const rows = Array.isArray(data) ? data : [];
          displayUserSearchResults(rows);
          return;
        }

        const data = await fetchComickJson("/v1.0/search", { q: query, limit: 18 });
        const results = Array.isArray(data) ? data.map(normalizeComicCard).filter(Boolean) : [];
        displayComicGridResults(results);
      } catch (err) {
        displaySearchError(err);
      }
    }, 300);
  });

  if (canUseSearch) {
    mobileSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        goToBrowseSearch(mobileSearchInput.value);
      }
    });
  }

  if (searchInput) {
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        goToBrowseSearch(searchInput.value);
      }
    });
  }

  function displaySearchError(err) {
    searchResults.innerHTML = `
      <div class="search-error">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3L2 21h20L12 3z" fill="none" stroke="currentColor" stroke-width="2" />
          <line x1="12" y1="9" x2="12" y2="14" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          <circle cx="12" cy="17" r="1.4" fill="currentColor" />
        </svg>
        <p>Failed to load results: ${err}</p>
      </div>
    `;
  }

  function displayComicGridResults(results){
    if(!searchResults) return;
    if(!results.length){
      resetSearchResults();
      return;
    }
    const cards = results.slice(0, 30).map((item)=>{
      const href = `/series?slug=${encodeURIComponent(item.slug)}`;
      const title = String(item.title || 'Untitled');
      const cover = String(item.cover_url || 'https://placehold.co/240x360/111/333?text=Cover');
      return `<a class="search-card" href="${href}">
        <img src="${cover}" alt="${escapeHtml(title)}" loading="lazy" decoding="async" />
        <div class="search-card-title">${escapeHtml(title)}</div>
      </a>`;
    }).join('');
    searchResults.innerHTML = `<div class="search-grid">${cards}</div>`;
  }

  function displayUserSearchResults(rows){
    if(!searchResults) return;
    const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
    if(!list.length){
      searchResults.innerHTML = `
        <div class="search-popup-empty-state">
          <div class="search-icon-circle">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2" fill="none" />
              <line x1="16.5" y1="16.5" x2="21" y2="21" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              <path d="M7.5 7.5l7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            </svg>
          </div>
          <h3>No users found</h3>
          <p>Try a different username or display name</p>
        </div>
      `;
      return;
    }
    const html = list.map((u)=>{
      const name = u.display_name || u.username || 'User';
      const handle = u.username ? `@${u.username}` : '';
      const avatar = u.avatar_url ? String(u.avatar_url) : '';
      const safeAvatar = avatar ? `background-image:url('${avatar.replace(/'/g,'%27')}')` : '';
      const ident = (u.username && String(u.username).trim()) ? String(u.username).trim() : (u.id ? String(u.id) : '');
      const href = ident ? `/profile?user=${encodeURIComponent(ident)}` : '/profile';
      return `<a class="user-result" href="${href}">
        <div class="user-avatar" style="${safeAvatar}"></div>
        <div class="user-meta">
          <div class="user-name">${escapeHtml(String(name))}</div>
          <div class="user-handle">${escapeHtml(String(handle))}</div>
        </div>
      </a>`;
    }).join('');
    searchResults.innerHTML = `<div class="user-results">${html}</div>`;
  }

  // ─────────────────── LOGIN MODAL ──────────────────
  function openLoginModal() {
    if (!loginModal) return;
    loginModal.classList.add('open');
    document.body.classList.add('nav-locked');
  }
  function closeLoginModal() {
    if (!loginModal) return;
    loginModal.classList.remove('open');
    document.body.classList.remove('nav-locked');
  }

  loginOpenTriggers.forEach(trigger => {
    trigger.addEventListener('click', (e) => {
      e.preventDefault();
      openLoginModal();
    });
  });
  loginCloseTriggers.forEach(trigger => {
    trigger.addEventListener('click', (e) => {
      e.preventDefault();
      closeLoginModal();
    });
  });
  if (loginModal) {
    loginModal.addEventListener('click', (e) => {
      if (e.target === loginModal) closeLoginModal();
    });
  }

  // ─────────────────── MOBILE SIDEBAR ───────────────
  // navToggle = the mobile-only hamburger ([data-nav-toggle])
  if (navToggle && mobileSidebar) {
    navToggle.addEventListener('click', () => {
      mobileSidebar.classList.add('open');
      document.body.classList.add('nav-locked');
    });
  }
  if (navClose && mobileSidebar) {
    navClose.addEventListener('click', () => {
      mobileSidebar.classList.remove('open');
      document.body.classList.remove('nav-locked');
    });
  }
  if (mobileSidebar) {
    mobileSidebar.addEventListener('click', (e) => {
      if (e.target === mobileSidebar) {
        mobileSidebar.classList.remove('open');
        document.body.classList.remove('nav-locked');
      }
    });
  }

  // ─────────────────── DESKTOP PROFILE DROPDOWN ─────
  if (profileToggle && profileDropdown) {
    profileToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      try {
        closeNotifDropdown();
      } catch (_) {}
      profileDropdown.classList.toggle('open');
    });
    document.addEventListener('click', (e) => {
      if (!profileDropdown.contains(e.target) && !profileToggle.contains(e.target)) {
        profileDropdown.classList.remove('open');
      }
    });
  }

  // ─────────────────── MOBILE PERSON BUTTON ───────
  // The actual action (open login OR toggle dropdown) is swapped by setupAuthUI
  // via window.__mobilePersonAction
  if (mobilePersonBtn) {
    mobilePersonBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (typeof window.__mobilePersonAction === 'function') window.__mobilePersonAction();
    });
  }
  // close mobile dropdown on outside click
  if (mobileProfileDropdown) {
    document.addEventListener('click', (e) => {
      if (mobileProfileDropdown.classList.contains('open') &&
          !mobileProfileDropdown.contains(e.target) &&
          !(mobilePersonBtn && mobilePersonBtn.contains(e.target))) {
        mobileProfileDropdown.classList.remove('open');
      }
    });
  }
  // mobile logout btn inside the dropdown
  if (mobileLogoutBtn) {
    mobileLogoutBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (mobileProfileDropdown) mobileProfileDropdown.classList.remove('open');
      if (typeof window.__handleLogout === 'function') window.__handleLogout();
    });
  }

  // ─────────────────── KEYBOARD ─────────────────────
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      if (canUseSearch) {
        searchOverlay.classList.add('open');
        document.body.classList.add('nav-locked');
        setTimeout(() => mobileSearchInput.focus(), 100);
      }
    }
    if (e.key === 'Escape') {
      if (themeModal && themeModal.classList.contains('open')) { closeThemeModal(); return; }
      if (canUseSearch && searchOverlay.classList.contains('open')) { closeSearchPopup(); return; }
      if (profileDropdown && profileDropdown.classList.contains('open')) { profileDropdown.classList.remove('open'); return; }
      if (notifDropdown && notifDropdown.classList.contains('open')) { closeNotifDropdown(); return; }
      if (mobileProfileDropdown && mobileProfileDropdown.classList.contains('open')) { mobileProfileDropdown.classList.remove('open'); return; }
      if (mobileSidebar && mobileSidebar.classList.contains('open')) { mobileSidebar.classList.remove('open'); document.body.classList.remove('nav-locked'); return; }
      if (loginModal && loginModal.classList.contains('open')) { closeLoginModal(); }
    }
  });

  // boot auth
  setupAuthUI();
}

// ═══════════════════════════════════════════════════════
// AUTH UI  –  updates desktop dropdown + mobile sidebar
// ═══════════════════════════════════════════════════════
function setupAuthUI() {
  const client = getSupabaseClient();
  if (!client) {
    try {
      window.__aryAuthInitAttempts = (window.__aryAuthInitAttempts || 0) + 1;
      if (window.__aryAuthInitAttempts <= 25) {
        setTimeout(() => setupAuthUI(), 200);
      }
    } catch (_) {}
    return;
  }

  const isStandalone = () => {
    try {
      const byClass = !!(document.documentElement && document.documentElement.classList && document.documentElement.classList.contains('is-standalone'));
      if (byClass) return true;
      return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone;
    } catch (_) {
      return false;
    }
  };

  // ── Desktop nav ──
  const navLoginBtn            = document.querySelector('.nav-login-btn');
  const userProfileContainer   = document.querySelector('.user-profile-container');

  // ── Desktop hamburger / dropdown ──
  const hamburgerAvatar        = document.querySelector('.hamburger-avatar');
  const userNameShortEl        = document.querySelector('[data-user-name-short]');
  const dropdownAvatar         = document.querySelector('.dropdown-avatar');
  const dropdownUserNameEl     = document.querySelector('.profile-dropdown [data-user-name]');
  const dropdownUserEmailEl    = document.querySelector('.profile-dropdown [data-user-email]');
  const dropdownLogoutBtn      = document.querySelector('.profile-dropdown [data-logout]');
  const profileToggle          = document.querySelector('[data-profile-toggle]');

  // ── Mobile sidebar ──
  const sidebarHeaderContent   = document.querySelector('.sidebar-header-content');
  const sidebarAvatar          = document.querySelector('.sidebar-avatar');
  const sidebarUserNameEl      = document.querySelector('.sidebar-header-text [data-user-name]');
  const sidebarUserEmailEl     = document.querySelector('.sidebar-header-text [data-user-email]');
  const sidebarAuthLinks       = document.querySelector('.sidebar-auth-links');   // View Profile + My Library
  const offlineDownloadsLink   = document.querySelector('[data-offline-downloads-link]');

  // ── Mobile person btn + mobile dropdown ──
  const mobilePersonBtn        = document.querySelector('[data-mobile-person]');
  const mobilePersonAvatar     = document.querySelector('.mobile-person-btn .person-avatar');
  const mobileProfileDropdown  = document.getElementById('mobile-profile-dropdown');
  const mobileDropdownAvatar   = document.getElementById('mobile-dd-avatar');
  const mobileDropdownNameEl   = document.getElementById('mobile-dd-name');
  const mobileDropdownEmailEl  = document.getElementById('mobile-dd-email');

  // ── Login modal ──
  const modalDiscordBtn        = document.querySelector('.discord-login-btn');
  const modalGoogleBtn         = document.querySelector('.google-login-btn');

  // ─── shared helpers ───
  function openLoginModal() {
    const m = document.getElementById('login-modal');
    if (m) { m.classList.add('open'); document.body.classList.add('nav-locked'); }
  }

  // ─── apply UI state ───
  async function applyUser(user) {
    if (!user) {
      window.__aryUserId = null;
      setLastUserId('');
      // ──── LOGGED OUT ────

      // desktop: show Login btn, hide profile container
      try {
        if (navLoginBtn) navLoginBtn.style.display = 'inline-flex';
      } catch (_) {}
      try {
        if (userProfileContainer) userProfileContainer.style.display = 'none';
      } catch (_) {}

      try {
        if (typeof window.__aryRefreshNotifications === 'function') {
          window.__aryRefreshNotifications();
        }
      } catch (_) {}
      // hide View Profile / My Library links
      if (sidebarAuthLinks)      sidebarAuthLinks.style.display = 'none';

      if (offlineDownloadsLink) {
        offlineDownloadsLink.classList.add('is-hidden');
        offlineDownloadsLink.setAttribute('aria-hidden', 'true');
      }
      // mobile person btn – reset to plain icon, tap → open login
      if (mobilePersonBtn)       mobilePersonBtn.classList.remove('has-avatar');
      if (mobilePersonAvatar)    mobilePersonAvatar.style.backgroundImage = 'none';
      window.__mobilePersonAction = () => openLoginModal();

      return;
    }

    // ──── LOGGED IN ────
    window.__aryUserId = user && user.id ? String(user.id) : null;
    setLastUserId(window.__aryUserId);
    const meta        = user.user_metadata || {};
    const email       = user.email || meta.email || '';

    // Prefer values from profiles table (user-customizable) over OAuth metadata.
    let profileRow = null;
    try {
      const res = await client
        .from('profiles')
        .select('display_name,username,avatar_url')
        .eq('id', user.id)
        .maybeSingle();
      profileRow = res && res.data ? res.data : null;
    } catch (_) {}

    const displayName =
      (profileRow && (profileRow.display_name || profileRow.username)) ||
      meta.full_name ||
      meta.name ||
      meta.preferred_username ||
      user.email ||
      'User';

    const rawAvatar =
      (profileRow && profileRow.avatar_url) ||
      meta.avatar_url ||
      meta.picture ||
      null;
    const avatar      = rawAvatar ? normalizeAvatarUrl(rawAvatar) : null;
    const safeUrl     = avatar ? `url('${String(avatar).replace(/'/g, '%27')}')` : 'none';

    // desktop: hide Login btn, show profile container
    if (navLoginBtn)           navLoginBtn.style.display = 'none';
    if (userProfileContainer)  userProfileContainer.style.display = 'block';

    try {
      if (typeof window.__aryRefreshNotifications === 'function') {
        window.__aryRefreshNotifications();
      }
    } catch (_) {}

    // desktop hamburger
    if (profileToggle)         profileToggle.classList.toggle('has-avatar', !!avatar);
    if (hamburgerAvatar)       hamburgerAvatar.style.backgroundImage = safeUrl;
    if (userNameShortEl)       userNameShortEl.textContent = displayName.split(' ')[0];

    // desktop dropdown
    if (dropdownAvatar)        dropdownAvatar.style.backgroundImage = safeUrl;
    if (dropdownUserNameEl)    dropdownUserNameEl.textContent = displayName;
    if (dropdownUserEmailEl)   dropdownUserEmailEl.textContent = email;

    // View Profile links → /profile?user=<id>
    document.querySelectorAll('[data-profile-link]').forEach((a) => {
      try {
        a.href = `/profile?user=${encodeURIComponent(user.id)}`;
      } catch (_) {}
    });

    // sidebar header
    if (sidebarHeaderContent)  sidebarHeaderContent.classList.toggle('has-avatar', !!avatar);
    if (sidebarAvatar)         sidebarAvatar.style.backgroundImage = safeUrl;
    if (sidebarUserNameEl)     sidebarUserNameEl.textContent = displayName;
    if (sidebarUserEmailEl)    sidebarUserEmailEl.textContent = email;

    // show View Profile / My Library in sidebar
    if (sidebarAuthLinks)      sidebarAuthLinks.style.display = 'block';

    if (offlineDownloadsLink) {
      if (isStandalone()) {
        offlineDownloadsLink.classList.remove('is-hidden');
        offlineDownloadsLink.setAttribute('aria-hidden', 'false');
      } else {
        offlineDownloadsLink.classList.add('is-hidden');
        offlineDownloadsLink.setAttribute('aria-hidden', 'true');
      }
    }

    // mobile person btn – show avatar, tap → toggle profile dropdown
    if (mobilePersonBtn)       mobilePersonBtn.classList.toggle('has-avatar', !!avatar);
    if (mobilePersonAvatar)    mobilePersonAvatar.style.backgroundImage = safeUrl;
    if (mobileDropdownAvatar)  mobileDropdownAvatar.style.backgroundImage = safeUrl;
    if (mobileDropdownNameEl)  mobileDropdownNameEl.textContent = displayName;
    if (mobileDropdownEmailEl) mobileDropdownEmailEl.textContent = email;
    window.__mobilePersonAction = () => {
      if (mobileProfileDropdown) mobileProfileDropdown.classList.toggle('open');
    };

    // keep DB in sync (fire & forget)
    upsertProfileForUser(client, user, meta, avatar);
    syncLocalReadingHistoryToSupabase(client, user);
    refreshReaderHistoryFromSupabase(client, user);
  }

  // ─── initial load ───
  async function refreshUser() {
    try {
      const { data, error } = await client.auth.getUser();
      if (error) {
        console.warn('Supabase getUser error', error);
        try {
          const sessionRes = await client.auth.getSession();
          const sessionUser = sessionRes && sessionRes.data && sessionRes.data.session && sessionRes.data.session.user
            ? sessionRes.data.session.user
            : null;
          if (sessionUser) {
            await applyUser(sessionUser);
            return;
          }
        } catch (_) {}
        await applyUser(null);
        return;
      }
      await applyUser(data && data.user ? data.user : null);
    } catch (err) {
      console.warn('Supabase getUser failed', err);
      try {
        const sessionRes = await client.auth.getSession();
        const sessionUser = sessionRes && sessionRes.data && sessionRes.data.session && sessionRes.data.session.user
          ? sessionRes.data.session.user
          : null;
        if (sessionUser) {
          await applyUser(sessionUser);
          return;
        }
      } catch (_) {}
      await applyUser(null);
    }
  }

  async function tryFinalizeOAuthRedirect() {
    try {
      const url = new URL(window.location.href);
      const code = url.searchParams.get('code');
      const hasError = url.searchParams.get('error') || url.searchParams.get('error_description');
      if (!code || hasError) return;

      if (client.auth && typeof client.auth.getSessionFromUrl === 'function') {
        await client.auth.getSessionFromUrl();
      } else if (client.auth && typeof client.auth.exchangeCodeForSession === 'function') {
        await client.auth.exchangeCodeForSession(code);
      }

      try {
        url.searchParams.delete('code');
        url.searchParams.delete('state');
        url.searchParams.delete('error');
        url.searchParams.delete('error_description');
        window.history.replaceState({}, document.title, url.toString());
      } catch (_) {}
    } catch (_) {}
  }

  try {
    if (!window.__aryAuthStateListenerBound && client.auth && typeof client.auth.onAuthStateChange === 'function') {
      window.__aryAuthStateListenerBound = true;
      client.auth.onAuthStateChange(() => {
        refreshUser();
      });
    }
  } catch (_) {}

  if (!window.__aryHistoryFocusRefreshBound) {
    window.__aryHistoryFocusRefreshBound = true;
    window.addEventListener('focus', () => {
      maybeSyncReadingHistory(false);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        maybeSyncReadingHistory(false);
      }
    });
  }

  // ─── Discord login (modal button) ───
  if (modalDiscordBtn) {
    modalDiscordBtn.addEventListener('click', async () => {
      try {
        try { modalDiscordBtn.disabled = true; } catch (_) {}
        const redirectTo = `${window.location.origin}/profile`;
        await client.auth.signInWithOAuth({
          provider: 'discord',
          options: { redirectTo },
        });
      } catch (err) {
        console.warn('Discord login failed', err);
        try { modalDiscordBtn.disabled = false; } catch (_) {}
      }
    });
  }

  // ─── Google login (modal button) ───
  if (modalGoogleBtn) {
    modalGoogleBtn.addEventListener('click', async () => {
      try {
        try { modalGoogleBtn.disabled = true; } catch (_) {}
        const redirectTo = `${window.location.origin}/profile`;
        await client.auth.signInWithOAuth({
          provider: 'google',
          options: { redirectTo },
        });
      } catch (err) {
        console.warn('Google login failed', err);
        try { modalGoogleBtn.disabled = false; } catch (_) {}
      }
    });
  }

  // ─── Logout handler ───
  async function handleLogout() {
    try { await client.auth.signOut(); } catch (err) { console.warn('Supabase logout failed', err); }
    // close dropdowns
    const dd  = document.getElementById('profile-dropdown');
    const mdd = document.getElementById('mobile-profile-dropdown');
    if (dd)  dd.classList.remove('open');
    if (mdd) mdd.classList.remove('open');
    await applyUser(null);
  }
  window.__handleLogout = handleLogout;

  // ─── Dropdown Sign Out ───
  if (dropdownLogoutBtn) {
    dropdownLogoutBtn.addEventListener('click', (e) => {
      e.preventDefault();
      // close dropdown first
      const dd = document.getElementById('profile-dropdown');
      if (dd) dd.classList.remove('open');
      handleLogout();
    });
  }

  (async () => {
    await tryFinalizeOAuthRedirect();
    refreshUser();
  })();
}

window.initNavbar            = initNavbar;
window.configureNavbarSearch = configureNavbarSearch;

try {
const mount = document.getElementById('navbar-mount');

const tryInit = () => {
  try {
    const nav = document.querySelector('.nav-wrapper');
    if (!nav) return false;
    initNavbar();
    return true;
  } catch (_) {
    return false;
  }
};

const startObservers = () => {
  if (tryInit()) return;
  if (!mount || typeof MutationObserver !== 'function') return;

  const obs = new MutationObserver(() => {
    if (tryInit()) {
      try { obs.disconnect(); } catch (_) {}
    }
  });

  try {
    obs.observe(mount, { childList: true, subtree: true });
  } catch (_) {}
};

if (document && document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => startObservers());
} else {
  startObservers();
}
} catch (_) {}