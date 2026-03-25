(function () {
  try {
    console.debug('Ary Game JS', '20260214-9');
  } catch (_) {}
  const $ = (sel) => document.querySelector(sel);

  const els = {
    setupPanel: $('#setup-panel'),
    playPanel: $('#play-panel'),
    resultsPanel: $('#results-panel'),

    genreSelect: $('#genre-select'),
    genreValue: $('#genre-value'),
    genreMenu: $('#genre-menu'),
    start: $('#start-game'),

    playTitle: $('#play-title'),
    playSub: $('#play-sub'),
    pillProgress: $('#pill-progress'),
    pillScore: $('#pill-score'),
    pillTime: $('#pill-time'),

    questionCover: $('#question-cover'),
    questionPrompt: $('#question-prompt'),
    questionDesc: $('#question-desc'),
    options: $('#options'),

    quit: $('#quit-game'),
    next: $('#next-question'),

    resultsScore: $('#results-score'),
    resultsMeta: $('#results-meta'),
    playAgain: $('#play-again'),
    backSetup: $('#back-setup'),

    toast: $('#toast'),
    countdown: $('#countdown'),
    countdownNum: $('#countdown-num'),
    countdownSub: document.querySelector('.countdown-sub'),

    mpOpen: $('#mp-open'),
    mpLobby: $('#mp-lobby'),
    mpLeave: $('#mp-leave'),
    mpStatus: $('#mp-status'),
    mpOpponent: $('#mp-opponent'),
    mpInvite: $('#mp-invite'),
    mpPlayers: $('#mp-players'),
    mpSettings: $('#mp-settings'),
    mpStart: $('#mp-start')
  };

  const mpEls = {
    modal: $('#mp-settings-modal'),
    modalClose: $('#mp-settings-close'),
    modalX: $('#mp-settings-x'),
    modalSave: $('#mp-settings-save'),
    setGenre: $('#mp-set-genre'),
    setDifficulty: $('#mp-set-difficulty'),
    setMode: $('#mp-set-mode'),
    setCount: $('#mp-set-count')
  };

  function setLobbyVisible(on) {
    if (!els.mpLobby) return;
    els.mpLobby.classList.toggle('active', !!on);
    els.mpLobby.setAttribute('aria-hidden', on ? 'false' : 'true');

    try {
      if (els.mpOpen) els.mpOpen.style.display = on ? 'none' : '';
    } catch (_) {}

    try {
      if (els.setupPanel) els.setupPanel.classList.toggle('mp-mode', !!on);
    } catch (_) {}
  }

  function setMpControls({ canStart, canSettings } = {}) {
    try {
      if (els.mpStart) els.mpStart.disabled = !canStart;
    } catch (_) {}
    try {
      if (els.mpSettings) els.mpSettings.disabled = !canSettings;
    } catch (_) {}
  }

  function setLobbyStatus(text) {
    if (!els.mpStatus) return;
    els.mpStatus.textContent = safeText(text);
  }

  async function waitForSupabaseClient(ms) {
    const start = Date.now();
    while (Date.now() - start < (ms || 0)) {
      try {
        if (typeof getSupabaseClient === 'function') {
          const c = getSupabaseClient();
          if (c) return c;
        }
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 150));
    }
    try {
      return typeof getSupabaseClient === 'function' ? getSupabaseClient() : null;
    } catch (_) {
      return null;
    }
  }

  async function waitForAuthSession(client, ms = 6000) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      try {
        const { data } = await client.auth.getSession();
        const s = data?.session || null;
        if (s?.access_token) return s;
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 250));
    }
    try {
      const { data } = await client.auth.getSession();
      return data?.session || null;
    } catch (_) {
      return null;
    }
  }

  function safeText(v) {
    return v == null ? '' : String(v);
  }

  function makeSeededRng(seed) {
    let a = (Number(seed) || 0) >>> 0;
    if (!a) a = 0x12345678;
    return function () {
      // Mulberry32
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randomInt(rng, maxExclusive) {
    const m = Math.max(1, Number(maxExclusive) || 1);
    return Math.floor((rng ? rng() : Math.random()) * m);
  }

  function setCountdownVisible(on) {
    if (!els.countdown) return;
    els.countdown.classList.toggle('active', !!on);
    els.countdown.setAttribute('aria-hidden', on ? 'false' : 'true');
  }

  async function runCountdown(seconds = 5) {
    const n = Math.max(1, Math.floor(Number(seconds) || 5));
    setCountdownVisible(true);
    if (els.countdownNum) els.countdownNum.textContent = String(n);

    for (let i = n; i >= 1; i--) {
      if (els.countdownNum) els.countdownNum.textContent = String(i);
      await new Promise((r) => window.setTimeout(r, 700));
    }

    if (els.countdownNum) els.countdownNum.textContent = 'GO';
    await new Promise((r) => window.setTimeout(r, 450));
    setCountdownVisible(false);
  }

  function showToast(msg) {
    if (!els.toast) return;
    try {
      els.toast.classList.remove('good', 'bad', 'neutral');
    } catch (_) {}
    els.toast.textContent = msg;
    els.toast.classList.add('active');
    window.clearTimeout(showToast.__t);
    showToast.__t = window.setTimeout(() => {
      els.toast.classList.remove('active');
    }, 1600);
  }

  function showToastKind(msg, kind) {
    if (!els.toast) return;
    try {
      els.toast.classList.remove('good', 'bad', 'neutral');
      if (kind) els.toast.classList.add(kind);
    } catch (_) {}
    showToast(msg);
  }

  const state = {
    difficulty: 'easy',
    mode: 'cover',
    count: 5,
    search: '',

    autoNext: true,

    questions: [],
    idx: 0,
    correct: 0,
    answered: false,

    startedAt: 0,
    timerId: 0,

    timeLimitSec: 0,
    endsAt: 0,

    lastAnswerCorrect: false,

    pvp: {
      enabled: false,
      roomId: '',
      seed: 0,
      hostId: '',
      startedViaInvite: false
    },

    rng: null,

    mp: {
      roomId: '',
      leaderId: '',
      isLeader: false,
      members: [],
      channel: null,
      started: false
    }
  };

  function isPvpEnabled() {
    return !!(state.pvp && state.pvp.enabled && state.rng);
  }

  function isMpGameEnabled() {
    return !!(state.mp && state.mp.roomId && state.mp.started && state.rng);
  }

  function getRoomFromUrl() {
    try {
      const u = new URL(window.location.href);
      const room = safeText(u.searchParams.get('room')).trim();
      return room || '';
    } catch (_) {
      return '';
    }
  }

  function setSettingsModalOpen(on) {
    if (!mpEls.modal) return;
    mpEls.modal.classList.toggle('open', !!on);
    mpEls.modal.setAttribute('aria-hidden', on ? 'false' : 'true');
    try {
      document.body.classList.toggle('nav-locked', !!on);
    } catch (_) {}
  }

  function renderMembers() {
    if (!els.mpPlayers) return;
    const arr = Array.isArray(state.mp.members) ? state.mp.members : [];
    if (!arr.length) {
      els.mpPlayers.innerHTML = '<div class="small-muted">No one yet.</div>';
      return;
    }
    els.mpPlayers.innerHTML = arr
      .map((m) => {
        const name = safeText(m.username || 'User');
        const avatar = safeText(m.avatar_url || '').trim();
        const bg = avatar ? `background-image:url('${avatar.replace(/'/g, "%27")}');` : '';
        return `<div class="mp-player"><div class="mp-avatar" style="${bg}"></div><div>${name.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div></div>`;
      })
      .join('');

    // Gate start: leader + at least 2 players
    const canStart = !!(state.mp.isLeader && arr.length >= 2);
    setMpControls({ canStart, canSettings: !!state.mp.isLeader });
  }

  async function getAuthedUserAndProfile(client) {
    let user = null;
    try {
      const { data: userRes } = await client.auth.getUser();
      user = userRes?.user || null;
    } catch (_) {
      user = null;
    }
    if (!user?.id) return { user: null, profile: null };
    let profile = null;
    try {
      const { data } = await client
        .from('profiles')
        .select('id,username,display_name,avatar_url')
        .eq('id', user.id)
        .maybeSingle();
      profile = data || null;
    } catch (_) {
      profile = null;
    }
    return { user, profile };
  }

  function applyRoomSettings(roomRow) {
    if (!roomRow) return;
    const genre = safeText(roomRow.genre || 'random');
    const diff = safeText(roomRow.difficulty || 'easy');
    const mode = safeText(roomRow.mode || 'cover');
    const count = Number(roomRow.question_count || 5) || 5;

    state.search = genre;
    state.difficulty = diff;
    state.mode = mode;
    state.count = count;

    try {
      if (mpEls.setGenre) mpEls.setGenre.value = genre;
      if (mpEls.setDifficulty) mpEls.setDifficulty.value = diff;
      if (mpEls.setMode) mpEls.setMode.value = mode;
      if (mpEls.setCount) mpEls.setCount.value = String(count);
    } catch (_) {}
  }

  async function loadRoomAndMembers(client, roomId, announceJoinName) {
    let roomRow = null;
    // room
    try {
      const { data, error } = await client
        .from('game_rooms')
        .select('id,leader_user_id,genre,difficulty,mode,question_count,status,seed,started_at')
        .eq('id', roomId)
        .maybeSingle();
      if (error) {
        console.warn('load room failed', error);
      }
      roomRow = data || null;
      if (roomRow) {
        state.mp.roomRow = roomRow;
        state.mp.leaderId = safeText(roomRow.leader_user_id);
        applyRoomSettings(roomRow);
        state.mp.started = safeText(roomRow.status) === 'started';
      }
    } catch (err) {
      console.warn('load room crashed', err);
    }

    // members
    try {
      const { data: mem, error } = await client
        .from('game_room_members')
        .select('user_id,username,avatar_url,joined_at')
        .eq('room_id', roomId)
        .order('joined_at', { ascending: true });
      if (error) {
        console.warn('load members failed', error);
      }
      state.mp.members = Array.isArray(mem) ? mem : [];
    } catch (err) {
      console.warn('load members crashed', err);
      state.mp.members = [];
    }
    renderMembers();

    if (announceJoinName) {
      setLobbyStatus(`${announceJoinName} entered the room`);
    }
  }

  async function subscribeRoomRealtime(client, roomId) {
    try {
      if (state.mp.channel) {
        await state.mp.channel.unsubscribe();
      }
    } catch (_) {}

    const ch = client.channel(`ary-room-${roomId}`);
    state.mp.channel = ch;

    ch.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'game_room_members', filter: `room_id=eq.${roomId}` },
      async (payload) => {
        const ev = payload?.eventType;
        const row = payload?.new || payload?.old || null;
        const name = safeText(row?.username || 'User');
        if (ev === 'INSERT') setLobbyStatus(`${name} entered the room`);
        if (ev === 'DELETE') setLobbyStatus(`${name} left the room`);
        await loadRoomAndMembers(client, roomId);
      }
    );

    ch.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'game_rooms', filter: `id=eq.${roomId}` },
      async (payload) => {
        const row = payload?.new || null;
        if (!row) return;
        applyRoomSettings(row);

        const status = safeText(row.status);
        if (status === 'started' && !state.mp.started) {
          state.mp.started = true;
          // seed
          const seed = Number(row.seed) || 0;
          state.rng = makeSeededRng(seed || 1);
          setLobbyStatus('Leader started the game…');
          // Start for everyone
          setSetupLocked(true);
          startGame();
        }
      }
    );

    await ch.subscribe();
  }

  async function joinLobby(roomId) {
    const client = await waitForSupabaseClient(8000);
    if (!client) {
      showToast('Supabase unavailable');
      return;
    }
    // Ensure session exists; otherwise PostgREST will run as anon and RLS will reject inserts.
    // Auth restoration can lag behind first page paint, so we wait briefly.
    const session = await waitForAuthSession(client, 7000);

    if (!session?.access_token) {
      showToast('Sign in to play multiplayer');
      setLobbyVisible(true);
      setLobbyStatus('Not signed in (no session).');
      return;
    }

    // IMPORTANT: For RLS, auth.uid() is the session user id.
    // Use it as the authoritative user_id to satisfy (user_id = auth.uid()).
    const sessionUserId = safeText(session?.user?.id).trim();
    const { user, profile } = await getAuthedUserAndProfile(client);
    const userId = safeText(user?.id).trim();
    const effectiveUserId = sessionUserId || userId;

    try {
      console.debug('joinLobby auth', { sessionUserId, userId, effectiveUserId, hasSession: !!session?.access_token });
    } catch (_) {}

    if (!effectiveUserId) {
      showToast('Sign in to play multiplayer');
      return;
    }

    if (sessionUserId && userId && sessionUserId !== userId) {
      console.warn('Supabase user mismatch (session vs getUser)', { sessionUserId, userId });
      setLobbyStatus('Auth mismatch detected. Refresh the page.');
    }

    if (!roomId) {
      showToast('Missing room id');
      return;
    }

    state.mp.roomId = roomId;
    setLobbyVisible(true);

    // join membership
    try {
      const username = safeText(profile?.username || profile?.display_name || 'User');
      const avatar = safeText(profile?.avatar_url || '');
      try {
        console.debug('joinLobby membership upsert', { roomId, userId: effectiveUserId, username });
      } catch (_) {}
      const { error } = await client.from('game_room_members').upsert(
        {
          room_id: roomId,
          user_id: effectiveUserId,
          username,
          avatar_url: avatar,
        },
        { onConflict: 'room_id,user_id' }
      );
      if (error) {
        const msg = safeText(error?.message || 'Failed to join room');
        const code = safeText(error?.code || '');
        const details = safeText(error?.details || '');
        const hint = safeText(error?.hint || '');
        const joined = [msg, details, hint].filter(Boolean).join(' • ');

        // Console logging: make sure the error object is visible even when the console collapses objects.
        console.error('join membership failed', error);
        console.warn('join membership failed ctx', { code, msg, details, hint, sessionUserId, userId, effectiveUserId });

        if (code === '42501') {
          setLobbyStatus(`Join failed (42501). RLS blocked the insert. uid:${sessionUserId || '?'} row_uid:${effectiveUserId || '?'}`);
        } else if (code === '42P10') {
          setLobbyStatus('Join failed (42P10). Missing UNIQUE constraint for (room_id, user_id) on game_room_members.');
        } else {
          setLobbyStatus(code ? `Join failed (${code}). ${joined || msg}` : `Join failed. ${joined || msg}`);
        }

        showToast(code ? `${code}: ${msg}` : msg);
      }
    } catch (err) {
      console.warn('join room failed', err);
      setLobbyStatus('Failed to join room.');
    }

    // load room + determine leader
    await loadRoomAndMembers(client, roomId);

    const leaderId = safeText(state.mp.leaderId).trim();
    state.mp.isLeader = !!(leaderId && String(leaderId) === String(effectiveUserId));

    // If room couldn't be read, we can't know the leader.
    if (!leaderId) {
      setLobbyStatus('Joined, but cannot read room data (check RLS on game_rooms).');
    } else {
      setLobbyStatus(state.mp.isLeader ? 'Lobby ready. Invite friends.' : 'Joined lobby. Waiting for leader to start…');
    }

    setMpControls({ canStart: false, canSettings: !!state.mp.isLeader });

    // realtime
    await subscribeRoomRealtime(client, roomId);

    // ensure settings reflect room
    try {
      if (state.mp.isLeader) {
        if (mpEls.setGenre) mpEls.setGenre.value = state.search || 'random';
        if (mpEls.setDifficulty) mpEls.setDifficulty.value = state.difficulty || 'easy';
        if (mpEls.setMode) mpEls.setMode.value = state.mode || 'cover';
        if (mpEls.setCount) mpEls.setCount.value = String(state.count || 5);
      }
    } catch (_) {}
  }

  async function ensureRoomForLeader() {
    if (state.mp.roomId) return state.mp.roomId;
    const client = await waitForSupabaseClient(8000);
    if (!client) return '';
    const { user } = await getAuthedUserAndProfile(client);
    if (!user?.id) return '';

    const roomId = `room_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
    let seed = 0;
    try {
      const buf = new Uint32Array(1);
      crypto.getRandomValues(buf);
      seed = Number(buf[0]) || 0;
    } catch (_) {
      seed = Math.floor(Math.random() * 1e9);
    }

    try {
      await client.from('game_rooms').insert({
        id: roomId,
        leader_user_id: user.id,
        genre: state.search || 'random',
        difficulty: state.difficulty || 'easy',
        mode: state.mode || 'cover',
        question_count: state.count || 5,
        status: 'lobby',
        seed,
      });
    } catch (err) {
      console.warn('create room failed', err);
      return '';
    }

    // join self
    await joinLobby(roomId);
    return roomId;
  }

  function setStage(stage) {
    const stages = ['setup', 'play', 'results'];
    if (!stages.includes(stage)) stage = 'setup';

    if (els.setupPanel) els.setupPanel.style.display = stage === 'setup' ? '' : 'none';

    if (els.playPanel) els.playPanel.classList.toggle('active', stage === 'play');
    if (els.resultsPanel) els.resultsPanel.classList.toggle('active', stage === 'results');
  }

  function setActiveChip(containerSel, chipSel) {
    const container = document.querySelector(containerSel);
    if (!container) return;
    container.querySelectorAll('.chip').forEach((btn) => btn.classList.remove('active'));
    const btn = container.querySelector(chipSel);
    if (btn) btn.classList.add('active');
  }

  function bindChips() {
    document.querySelectorAll('[data-difficulty]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.difficulty = btn.dataset.difficulty || 'easy';
        document.querySelectorAll('[data-difficulty]').forEach((b) => b.classList.toggle('active', b === btn));
      });
    });

    document.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.mode = btn.dataset.mode || 'cover';
        document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b === btn));
      });
    });

    document.querySelectorAll('[data-count]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const n = Number(btn.dataset.count || 5);
        state.count = Number.isFinite(n) ? n : 5;
        document.querySelectorAll('[data-count]').forEach((b) => b.classList.toggle('active', b === btn));
      });
    });

    document.querySelectorAll('[data-auto-next]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const v = (btn.dataset.autoNext || '').toLowerCase();
        state.autoNext = v !== 'no';
        document.querySelectorAll('[data-auto-next]').forEach((b) => b.classList.toggle('active', b === btn));
      });
    });
  }

  function stopTimer() {
    if (state.timerId) {
      window.clearInterval(state.timerId);
      state.timerId = 0;
    }
  }

  function startTimer() {
    stopTimer();
    state.startedAt = performance.now();
    state.endsAt = state.startedAt + state.timeLimitSec * 1000;
    state.timerId = window.setInterval(() => {
      const now = performance.now();
      const remaining = Math.max(0, (state.endsAt - now) / 1000);
      if (els.pillTime) {
        // Keep constant width so the topbar doesn't jump.
        els.pillTime.textContent = `${remaining.toFixed(1).padStart(4, '0')}s`;
      }
      if (remaining <= 0) {
        stopTimer();
        finishGame({ reason: 'time' });
      }
    }, 100);
  }

  function setSetupLocked(locked) {
    const disable = !!locked;
    try {
      els.genreSelect?.toggleAttribute('disabled', disable);
    } catch (_) {}
    if (disable) {
      try {
        els.genreMenu?.classList.remove('open');
        els.genreSelect?.setAttribute('aria-expanded', 'false');
      } catch (_) {}
    }
    try {
      document.querySelectorAll('[data-difficulty],[data-mode],[data-count],[data-auto-next]').forEach((b) => {
        if (!(b instanceof HTMLButtonElement)) return;
        b.disabled = disable;
      });
    } catch (_) {}
    try {
      if (els.start) els.start.disabled = disable;
    } catch (_) {}
  }

  function shuffle(arr) {
    const a = Array.isArray(arr) ? [...arr] : [];
    for (let i = a.length - 1; i > 0; i--) {
      const j = randomInt(state.rng, i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function uniqBy(arr, keyFn) {
    const out = [];
    const seen = new Set();
    for (const item of arr || []) {
      const k = keyFn(item);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(item);
    }
    return out;
  }

  function safeStr(s) {
    return typeof s === 'string' ? s : '';
  }

  function scoreSimilarity(a, b) {
    if (!a || !b) return 0;
    const tagsA = new Set(Array.isArray(a.tags) ? a.tags.map((t) => String(t).toLowerCase()) : []);
    const tagsB = new Set(Array.isArray(b.tags) ? b.tags.map((t) => String(t).toLowerCase()) : []);
    let overlap = 0;
    for (const t of tagsA) if (tagsB.has(t)) overlap += 1;
    const ratingA = Number(a.rating) || 0;
    const ratingB = Number(b.rating) || 0;
    const ratingDelta = Math.abs(ratingA - ratingB);
    const ratingScore = ratingA && ratingB ? Math.max(0, 1.5 - ratingDelta) : 0;
    return overlap * 1.0 + ratingScore;
  }

  async function fetchComixBrowsePage({ genre, page, limit }) {
    const url = new URL('/api/comix/browse', window.location.origin);
    url.searchParams.set('page', String(page));
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('genres_mode', 'and');
    url.searchParams.set('order', 'follows_total');
    if (genre && genre !== 'random') url.searchParams.set('genre', genre);
    const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Comix browse failed: ${res.status}`);
    return await res.json();
  }

  function getDifficultyMaxPage() {
    if (state.difficulty === 'chaos') return 2464;
    if (state.difficulty === 'hard') return 1000;
    if (state.difficulty === 'normal') return 100;
    return 20;
  }

  async function fetchComixMangaDetail(hid) {
    const url = new URL(`/api/comix/manga/${encodeURIComponent(hid)}`, window.location.origin);
    const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Comix manga failed: ${res.status}`);
    return await res.json();
  }

  function normalizeComixPoster(poster) {
    if (!poster) return '';
    if (typeof poster === 'string') return poster;
    if (typeof poster === 'object') {
      return safeStr(poster.large) || safeStr(poster.medium) || safeStr(poster.small) || '';
    }
    return '';
  }

  function normalizeComixItem(x) {
    if (!x || typeof x !== 'object') return null;
    const hid = safeStr(x.hash_id) || safeStr(x.hid) || safeStr(x.id);
    const slug = safeStr(x.slug);
    const title = safeStr(x.title);
    const cover = normalizeComixPoster(x.poster || x._poster) || safeStr(x.cover) || safeStr(x.thumb);
    const tags = Array.isArray(x.genres)
      ? x.genres
          .map((g) => (typeof g === 'string' ? g : (g?.title || g?.name)))
          .filter(Boolean)
      : [];
    return {
      id: hid || slug || title,
      hid,
      slug,
      title,
      description: safeStr(x.synopsis) || safeStr(x.desc) || safeStr(x.description),
      cover_url: cover || 'https://placehold.co/400x600?text=No+Cover',
      tags,
      rating: Number(x.rating) || 0,
      followers: Number(x.followers) || 0,
    };
  }

  async function buildComixPool({ genre, needed }) {
    const pagesToTry = 5;
    const limit = 28;
    const maxPage = getDifficultyMaxPage();
    const items = [];
    const tried = new Set();

    for (let i = 0; i < pagesToTry; i++) {
      const page = 1 + randomInt(state.rng, maxPage);
      if (tried.has(page)) continue;
      tried.add(page);
      try {
        const data = await fetchComixBrowsePage({ genre, page, limit });
        const batch = data?.result?.items;
        if (Array.isArray(batch)) batch.forEach((b) => items.push(b));
      } catch (_) {
        // ignore and continue
      }
      if (items.length >= needed) break;
    }

    const base = uniqBy(
      items.map(normalizeComixItem).filter((x) => x && x.title),
      (x) => x.hid || x.slug || x.title
    );

    const target = base.slice(0, Math.max(needed, 24));
    const out = [];
    const concurrency = 6;
    for (let i = 0; i < target.length; i += concurrency) {
      const chunk = target.slice(i, i + concurrency);
      const hydrated = await Promise.all(
        chunk.map(async (entry) => {
          if (!entry?.hid) return entry;
          try {
            const detail = await fetchComixMangaDetail(entry.hid);
            const d = detail?.result || detail;
            const merged = normalizeComixItem({ ...entry, ...d });
            return merged || entry;
          } catch (_) {
            return entry;
          }
        })
      );
      hydrated.forEach((h) => out.push(h));
      if (out.length >= needed) break;
    }

    return uniqBy(out, (x) => x.hid || x.slug || x.id || x.title);
  }

  function pickDistractors(pool, correct, n) {
    const candidates = pool.filter((p) => p && p.slug !== correct.slug);
    if (state.difficulty === 'hard' || state.difficulty === 'chaos') {
      const scored = candidates
        .map((c) => ({ c, s: scoreSimilarity(correct, c) }))
        .sort((a, b) => b.s - a.s);
      return scored.slice(0, n).map((x) => x.c);
    }
    if (state.difficulty === 'normal') {
      const scored = candidates
        .map((c) => ({ c, s: scoreSimilarity(correct, c) }))
        .sort((a, b) => b.s - a.s);
      const top = scored.slice(0, Math.max(n * 3, 12)).map((x) => x.c);
      return shuffle(top).slice(0, n);
    }
    return shuffle(candidates).slice(0, n);
  }

  function cropText(txt, maxLen) {
    const t = safeStr(txt).replace(/\s+/g, ' ').trim();
    if (!t) return '';
    if (t.length <= maxLen) return t;
    return t.slice(0, maxLen).replace(/\s+\S*$/, '').trim() + '…';
  }

  function buildQuestionFromEntry(entry, pool, type) {
    const optionCount = type === 'title' ? 4 : 3;
    const distractors = pickDistractors(pool, entry, optionCount - 1);
    if (distractors.length < optionCount - 1) return null;
    const all = shuffle([entry, ...distractors]);

    return {
      type,
      title: entry.title,
      cover: entry.cover_url,
      desc: cropText(entry.description, 200),
      options: all.map((x) => ({ title: x.title, cover: x.cover_url }))
    };
  }

  async function buildQuestionsFromComix({ genre, count, mode }) {
    const neededPool = Math.max(40, count * 8);
    const pool = await buildComixPool({ genre, needed: neededPool });
    if (pool.length < Math.max(10, count * 2)) {
      return { pool, questions: [] };
    }

    // For hard/chaos, bias towards higher rated/followed entries
    const base = (state.difficulty === 'hard' || state.difficulty === 'chaos')
      ? [...pool].sort((a, b) => (b.rating || 0) - (a.rating || 0) || (b.followers || 0) - (a.followers || 0))
      : shuffle(pool);

    const questions = [];
    let guard = 0;
    while (questions.length < count && guard < 300) {
      guard += 1;
      const entry = base[randomInt(state.rng, base.length)];
      if (!entry) continue;

      const type = mode === 'mixed'
        ? (questions.length % 3 === 0 ? 'cover' : questions.length % 3 === 1 ? 'bio' : 'title')
        : mode;

      const qObj = buildQuestionFromEntry(entry, pool, type);
      if (!qObj) continue;
      // Require bio to have some description
      if (type === 'bio' && !qObj.desc) continue;
      questions.push(qObj);
    }

    return { pool, questions };
  }

  function renderQuestion() {
    const q = state.questions[state.idx];
    if (!q) return;

    try {
      els.playPanel?.classList.remove('answered-correct', 'answered-wrong');
    } catch (_) {}

    state.answered = false;
    state.lastAnswerCorrect = false;

    if (els.next) els.next.disabled = true;

    if (els.pillProgress) els.pillProgress.textContent = `${state.idx + 1} / ${state.questions.length}`;
    if (els.pillScore) els.pillScore.textContent = `${state.correct} correct`;

    if (els.playTitle) {
      const modeLabel = q.type === 'cover' ? 'Guess from cover' : q.type === 'bio' ? 'Guess from bio' : q.type === 'title' ? 'Guess from title' : 'Quiz';
      els.playTitle.textContent = modeLabel;
    }

    if (els.playSub) {
      const diffLabel = state.difficulty === 'chaos' ? 'Chaos' : state.difficulty === 'hard' ? 'Hard' : state.difficulty === 'normal' ? 'Normal' : 'Easy';
      els.playSub.textContent = diffLabel;
    }

    if (els.playPanel) {
      els.playPanel.classList.toggle('title-mode', q.type === 'title');
      els.playPanel.classList.toggle('bio-mode', q.type === 'bio');
      els.playPanel.classList.toggle('cover-mode', q.type === 'cover');
    }

    if (els.questionCover) {
      els.questionCover.onerror = () => {
        try {
          els.questionCover.onerror = null;
          els.questionCover.src = 'https://placehold.co/600x840?text=No+Cover';
        } catch (_) {}
      };
      // Only show the big cover in cover-mode.
      if (q.type === 'cover') {
        els.questionCover.src = q.cover || 'https://placehold.co/600x840?text=No+Cover';
      } else {
        els.questionCover.src = 'https://placehold.co/600x840?text=—';
      }
    }

    if (els.questionPrompt) {
      if (q.type === 'cover') els.questionPrompt.textContent = 'Which title matches this cover?';
      else if (q.type === 'bio') els.questionPrompt.textContent = 'Which title matches this bio?';
      else if (q.type === 'title') els.questionPrompt.textContent = q.title || 'Which cover matches this title?';
      else els.questionPrompt.textContent = 'Question';
    }

    if (els.questionDesc) {
      if (q.type === 'bio') els.questionDesc.textContent = q.desc || '';
      else if (q.type === 'title') els.questionDesc.textContent = 'Which cover matches this title?';
      else els.questionDesc.textContent = 'Pick the correct answer.';
    }

    if (els.options) {
      els.options.innerHTML = '';
      const opts = Array.isArray(q.options) ? q.options : [];

      // title-mode: show cover options (with title under), answer is still the title
      if (q.type === 'title') {
        opts.forEach((opt) => {
          const title = typeof opt === 'string' ? opt : (opt?.title || '');
          const cover = typeof opt === 'string' ? '' : (opt?.cover || '');
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'opt-btn is-cover';
          btn.setAttribute('role', 'listitem');
          btn.innerHTML = `
            <div class="opt-cover">${cover ? `<img alt="" loading="lazy" />` : ''}</div>
            <div class="opt-title"></div>
          `;
          const img = btn.querySelector('img');
          if (img) {
            img.onerror = () => {
              try {
                img.onerror = null;
                img.src = 'https://placehold.co/600x840?text=No+Cover';
              } catch (_) {}
            };
            img.src = cover || 'https://placehold.co/600x840?text=No+Cover';
          }
          const t = btn.querySelector('.opt-title');
          // In title-mode, the title is already shown as the prompt.
          // Keep option cards cover-only to avoid duplicate title text.
          if (t) t.textContent = '';

          btn.addEventListener('click', () => onAnswer(title, btn));
          els.options.appendChild(btn);
        });
        return;
      }

      // other modes: show title options
      opts.forEach((opt) => {
        const title = typeof opt === 'string' ? opt : (opt?.title || '');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'opt-btn';
        btn.textContent = title;
        btn.setAttribute('role', 'listitem');
        btn.addEventListener('click', () => onAnswer(title, btn));
        els.options.appendChild(btn);
      });
    }
  }

  function lockOptions() {
    if (!els.options) return;
    els.options.querySelectorAll('button').forEach((b) => {
      b.disabled = true;
    });
  }

  function onAnswer(selected, btnEl) {
    if (state.answered) return;
    const q = state.questions[state.idx];
    if (!q) return;

    state.answered = true;

    const correct = selected === q.title;
    state.lastAnswerCorrect = correct;

    if (correct) {
      state.correct += 1;
      btnEl.classList.add('correct');
      showToastKind('Correct', 'good');
      try {
        els.playPanel?.classList.remove('answered-wrong');
        els.playPanel?.classList.add('answered-correct');
      } catch (_) {}
    } else {
      btnEl.classList.add('wrong');
      showToastKind(`Wrong — it was: ${q.title}`, 'bad');
      try {
        els.playPanel?.classList.remove('answered-correct');
        els.playPanel?.classList.add('answered-wrong');
      } catch (_) {}
      if (els.options) {
        els.options.querySelectorAll('button').forEach((b) => {
          if (b.textContent === q.title) b.classList.add('correct');
        });
      }
    }

    lockOptions();

    if (els.pillScore) els.pillScore.textContent = `${state.correct} correct`;
    if (els.next) els.next.disabled = false;

    if (state.autoNext) {
      window.clearTimeout(onAnswer.__autoNext);
      onAnswer.__autoNext = window.setTimeout(() => {
        try {
          nextQuestion();
        } catch (_) {}
      }, 650);
    }
  }

  function nextQuestion() {
    if (!state.answered) {
      showToast('Pick an answer');
      return;
    }

    state.idx += 1;
    if (state.idx >= state.questions.length) {
      finishGame();
      return;
    }

    renderQuestion();
  }

  function finishGame({ reason } = {}) {
    stopTimer();

    const total = state.questions.length;
    if (els.resultsScore) els.resultsScore.textContent = `${state.correct} / ${total}`;

    const elapsed = (performance.now() - state.startedAt) / 1000;
    if (els.resultsMeta) {
      if (reason === 'time') {
        els.resultsMeta.textContent = `Time’s up. You got ${state.correct} correct. Search-based questions + hard difficulty tuning is next.`;
      } else {
        els.resultsMeta.textContent = `You got ${state.correct} correct in ${elapsed.toFixed(1)}s. Search-based questions + hard difficulty tuning is next.`;
      }
    }

    setStage('results');

    // 1v1: submit result + wait for opponent
    try {
      if (isPvpEnabled()) {
        submitPvpResult({ elapsedSec: elapsed }).catch(() => {});
      }
    } catch (_) {}

    // Multiplayer lobby: submit result + wait for room results
    try {
      if (isMpGameEnabled()) {
        submitMpResult({ elapsedSec: elapsed }).catch(() => {});
      }
    } catch (_) {}
  }

  async function submitMpResult({ elapsedSec }) {
    const roomId = safeText(state.mp?.roomId).trim();
    if (!roomId) return;

    const client = await waitForSupabaseClient(8000);
    if (!client) return;

    let user = null;
    try {
      const { data: userRes } = await client.auth.getUser();
      user = userRes?.user || null;
    } catch (_) {
      user = null;
    }
    if (!user?.id) return;

    const payload = {
      room_id: roomId,
      user_id: user.id,
      score: state.correct,
      total: state.questions.length,
      elapsed_sec: Number(elapsedSec) || 0,
      finished_at: new Date().toISOString(),
    };

    try {
      const { error } = await client.from('game_results').upsert(payload, { onConflict: 'room_id,user_id' });
      if (error) {
        console.warn('mp result upsert failed', error);
        try {
          if (els.resultsMeta) {
            els.resultsMeta.textContent = `Multiplayer: Failed to submit result (${safeText(error.code) || 'error'}).`;
          }
        } catch (_) {}
        return;
      }
    } catch (_) {}

    await waitForRoomResultsAndRenderWinner(client, roomId, user.id);
  }

  async function waitForRoomResultsAndRenderWinner(client, roomId, myUserId) {
    if (!els.resultsMeta) return;
    const start = Date.now();
    const timeoutMs = 2 * 60 * 1000;
    const partialAfterMs = 12 * 1000;

    while (Date.now() - start < timeoutMs) {
      try {
        const { data, error } = await client
          .from('game_results')
          .select('user_id,score,total,elapsed_sec,finished_at')
          .eq('room_id', roomId);

        if (error) {
          console.warn('mp results select failed', error);
        }

        const rows = !error && Array.isArray(data) ? data : [];

        // If we can see at least 2 results, render immediately.
        // Do NOT block on an "expected player count" because state.mp.members can be stale
        // (someone left, invite-only member, etc.) which would cause an infinite wait.
        // If more than 2 players exist, we give a short grace period and then show partial results.
        const canRenderNow = rows.length >= 2;
        const shouldRenderPartial = rows.length >= 2 && Date.now() - start >= partialAfterMs;

        if (canRenderNow && (rows.length === 2 || shouldRenderPartial)) {
          const sorted = [...rows].sort((a, b) => {
            const sa = Number(a?.score) || 0;
            const sb = Number(b?.score) || 0;
            if (sb !== sa) return sb - sa;
            const ta = Number(a?.elapsed_sec) || 0;
            const tb = Number(b?.elapsed_sec) || 0;
            if (ta !== tb) return ta - tb;
            return String(a?.user_id || '').localeCompare(String(b?.user_id || ''));
          });

          const winner = sorted[0] || null;
          const winnerId = safeText(winner?.user_id);
          const me = rows.find((r) => String(r?.user_id) === String(myUserId)) || null;

          const winnerName = (() => {
            try {
              const mem = Array.isArray(state.mp?.members) ? state.mp.members : [];
              const found = mem.find((m) => String(m?.user_id) === String(winnerId));
              return safeText(found?.username || 'Winner');
            } catch (_) {
              return 'Winner';
            }
          })();

          const myScore = Number(me?.score) || 0;
          const winScore = Number(winner?.score) || 0;
          const myIsWinner = String(winnerId) === String(myUserId);

          els.resultsMeta.textContent = myIsWinner
            ? `Multiplayer: You won (${myScore}/${state.questions.length})`
            : `Multiplayer: ${winnerName} won (${winScore}/${state.questions.length})`;

          if (rows.length > 2) {
            try {
              els.resultsMeta.textContent += ` — ${rows.length} players reported`;
            } catch (_) {}
          }
          return;
        }

        // If we can only see our own row for a while, it's usually RLS blocking access to other players' results.
        if (rows.length === 1 && Date.now() - start > 8000) {
          els.resultsMeta.textContent = 'Multiplayer: Waiting… (can only see 1 result — check RLS on game_results)';
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
      } catch (_) {}

      els.resultsMeta.textContent = 'Multiplayer: Waiting for other players to finish…';
      await new Promise((r) => setTimeout(r, 2500));
    }

    try {
      els.resultsMeta.textContent = 'Multiplayer: Still waiting for others.';
    } catch (_) {}
  }

  async function submitPvpResult({ elapsedSec }) {
    const roomId = safeText(state.pvp?.roomId).trim();
    if (!roomId) return;

    const client = await waitForSupabaseClient(8000);
    if (!client) return;

    let user = null;
    try {
      const { data: userRes } = await client.auth.getUser();
      user = userRes?.user || null;
    } catch (_) {
      user = null;
    }
    if (!user?.id) return;

    const payload = {
      room_id: roomId,
      user_id: user.id,
      score: state.correct,
      total: state.questions.length,
      elapsed_sec: Number(elapsedSec) || 0,
      finished_at: new Date().toISOString(),
    };

    try {
      await client.from('game_results').upsert(payload, { onConflict: 'room_id,user_id' });
    } catch (_) {}

    await waitForOpponentAndRenderWinner(client, roomId, user.id);
  }

  async function waitForOpponentAndRenderWinner(client, roomId, myUserId) {
    if (!els.resultsMeta) return;
    const start = Date.now();
    const timeoutMs = 2 * 60 * 1000;
    while (Date.now() - start < timeoutMs) {
      try {
        const { data, error } = await client
          .from('game_results')
          .select('user_id,score,total,elapsed_sec')
          .eq('room_id', roomId);
        if (!error && Array.isArray(data) && data.length >= 2) {
          const mine = data.find((r) => String(r?.user_id) === String(myUserId));
          const other = data.find((r) => String(r?.user_id) !== String(myUserId));
          if (!mine || !other) break;

          const myScore = Number(mine.score) || 0;
          const otherScore = Number(other.score) || 0;
          const myTime = Number(mine.elapsed_sec) || 0;
          const otherTime = Number(other.elapsed_sec) || 0;

          let msg = '';
          if (myScore > otherScore) msg = `1v1: You win (${myScore}-${otherScore})`;
          else if (myScore < otherScore) msg = `1v1: You lose (${myScore}-${otherScore})`;
          else if (myTime < otherTime) msg = `1v1: You win (tie, faster time)`;
          else if (myTime > otherTime) msg = `1v1: You lose (tie, slower time)`;
          else msg = `1v1: Draw`;

          els.resultsMeta.textContent = msg;
          return;
        }
      } catch (_) {}

      els.resultsMeta.textContent = '1v1: Waiting for opponent to finish…';
      await new Promise((r) => setTimeout(r, 2500));
    }

    try {
      els.resultsMeta.textContent = '1v1: Opponent did not finish yet.';
    } catch (_) {}
  }

  function computeTimeLimitSec() {
    const perQ = (state.difficulty === 'hard' || state.difficulty === 'chaos') ? 6 : state.difficulty === 'normal' ? 8 : 10;
    return Math.max(10, perQ * Math.max(1, state.count));
  }

  async function startGame() {
    state.search = (state.search || '').trim();

    // Default RNG (non-pvp) so all random helpers behave consistently.
    if (!state.rng) state.rng = null;

    if (!state.search) {
      showToast('Select a genre first');
      return;
    }

    state.correct = 0;
    state.idx = 0;
    state.answered = false;
    state.lastAnswerCorrect = false;

    state.timeLimitSec = computeTimeLimitSec();

    setSetupLocked(true);

    let questions = [];
    try {
      const result = await buildQuestionsFromComix({ genre: state.search || 'random', count: state.count, mode: state.mode });
      questions = result.questions || [];
    } catch (err) {
      showToast('Failed to build questions');
      console.error(err);
      return;
    } finally {
      // Keep setup locked while playing; it will be unlocked when returning to setup.
    }

    if (!questions.length) {
      showToast('No results. Try another genre.');
      return;
    }

    state.questions = questions;

    try {
      if (els.countdownSub) els.countdownSub.textContent = 'Starting…';
    } catch (_) {}

    await runCountdown(5);
    setStage('play');
    startTimer();
    renderQuestion();
  }

  function parsePvpFromUrl() {
    try {
      // Preferred lobby url
      const roomParam = getRoomFromUrl();
      if (roomParam) {
        joinLobby(roomParam);
        return;
      }

      const u = new URL(window.location.href);
      const mode = safeText(u.searchParams.get('pvp')).trim();
      if (mode !== '1') return;
      const room = safeText(u.searchParams.get('room')).trim();
      const seedRaw = safeText(u.searchParams.get('seed')).trim();
      const seed = Number(seedRaw) || 0;
      if (!room || !seed) return;

      state.pvp.enabled = true;
      state.pvp.roomId = room;
      state.pvp.seed = seed;
      state.pvp.hostId = safeText(u.searchParams.get('host')).trim();
      state.pvp.startedViaInvite = true;
      state.rng = makeSeededRng(seed);

      // Legacy invite urls are treated as lobby join now.
      try {
        joinLobby(room);
      } catch (_) {}

      // Best-effort: mark invite accepted so it disappears from notifications.
      const inviteId = safeText(u.searchParams.get('invite')).trim();
      if (inviteId) {
        (async () => {
          try {
            const client = await waitForSupabaseClient(8000);
            if (!client) return;
            await client.from('game_invites').update({ status: 'accepted' }).eq('id', inviteId);
            try {
              if (typeof window.__aryRefreshNotifications === 'function') window.__aryRefreshNotifications();
            } catch (_) {}
          } catch (_) {}
        })();
      }

      const genre = safeText(u.searchParams.get('genre')).trim();
      const diff = safeText(u.searchParams.get('difficulty')).trim();
      const modeQ = safeText(u.searchParams.get('mode')).trim();
      const countRaw = safeText(u.searchParams.get('count')).trim();
      const count = Number(countRaw) || 5;

      if (genre) {
        state.search = genre;
        if (els.genreValue) els.genreValue.textContent = genre === 'random' ? 'Random' : genre;
      }
      if (diff) state.difficulty = diff;
      if (modeQ) state.mode = modeQ;
      if (count) state.count = count;

      // reflect chips
      try {
        document.querySelectorAll('[data-difficulty]').forEach((b) => b.classList.toggle('active', b.dataset.difficulty === state.difficulty));
        document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
        document.querySelectorAll('[data-count]').forEach((b) => b.classList.toggle('active', Number(b.dataset.count) === state.count));
      } catch (_) {}
    } catch (_) {}
  }

  async function sendPvpInvite() {
    const opponent = safeText(els.mpOpponent?.value).trim();
    if (!opponent) {
      showToast('Enter opponent username');
      return;
    }

    // Cooldown: stop spam-invites (per target, 60 seconds)
    const opponentKey = opponent.toLowerCase();
    const now = Date.now();
    try {
      if (!window.__aryInviteCooldowns) window.__aryInviteCooldowns = {};
      const last = Number(window.__aryInviteCooldowns[opponentKey] || 0);
      if (last && now - last < 60 * 1000) {
        const remaining = Math.ceil((60 * 1000 - (now - last)) / 1000);
        showToastKind(`Wait ${remaining}s before inviting again`, 'neutral');
        return;
      }
    } catch (_) {}

    const client = await waitForSupabaseClient(8000);
    if (!client) {
      showToast('Supabase unavailable');
      return;
    }

    let user = null;
    try {
      const { data: userRes } = await client.auth.getUser();
      user = userRes?.user || null;
    } catch (_) {
      user = null;
    }
    if (!user?.id) {
      showToast('Sign in to invite');
      return;
    }

    // resolve opponent username -> id
    let toUserId = '';
    let resolvedUsername = '';
    try {
      const { data } = await client.from('profiles').select('id,username,display_name').ilike('username', opponent).limit(1);
      const row = Array.isArray(data) ? data[0] : null;
      if (row?.id) toUserId = String(row.id);
      resolvedUsername = safeText(row?.username || opponent).trim() || opponent;
    } catch (_) {
      toUserId = '';
      resolvedUsername = opponent;
    }
    if (!toUserId) {
      showToast('User not found');
      return;
    }

    // Don’t allow inviting someone already in the lobby
    try {
      const mem = Array.isArray(state.mp?.members) ? state.mp.members : [];
      const oppLc = opponent.toLowerCase();
      const resolvedLc = resolvedUsername.toLowerCase();
      const alreadyIn = mem.some((m) => {
        const mid = safeText(m?.user_id);
        const mun = safeText(m?.username).trim().toLowerCase();
        return String(mid) === String(toUserId) || (!!mun && (mun === oppLc || mun === resolvedLc));
      });
      if (alreadyIn) {
        showToastKind(`"${resolvedUsername || opponent}" is already in the lobby`, 'neutral');
        return;
      }
    } catch (_) {}

    // Don’t allow inviting yourself
    if (String(toUserId) === String(user.id)) {
      showToastKind('You can’t invite yourself', 'neutral');
      return;
    }

    // Apply cooldown by resolved user id too (stronger than username)
    try {
      if (!window.__aryInviteCooldownsById) window.__aryInviteCooldownsById = {};
      const last = Number(window.__aryInviteCooldownsById[String(toUserId)] || 0);
      if (last && now - last < 60 * 1000) {
        const remaining = Math.ceil((60 * 1000 - (now - last)) / 1000);
        showToastKind(`Wait ${remaining}s before inviting again`, 'neutral');
        return;
      }
    } catch (_) {}

    // display name + avatar
    let fromDisplay = '';
    let fromAvatarUrl = '';
    let fromUsername = '';
    try {
      const { data: me } = await client
        .from('profiles')
        .select('display_name,username,avatar_url')
        .eq('id', user.id)
        .maybeSingle();
      fromUsername = safeText(me?.username || '').trim();
      fromDisplay = safeText(me?.display_name || fromUsername || '').trim();
      fromAvatarUrl = safeText(me?.avatar_url || '').trim();
    } catch (_) {
      fromDisplay = '';
      fromAvatarUrl = '';
      fromUsername = '';
    }
    if (!fromDisplay) fromDisplay = 'Someone';

    const roomId = await ensureRoomForLeader();
    if (!roomId) {
      showToast('Unable to create room');
      return;
    }
    let seed = 1;
    try {
      const { data: roomRow } = await client
        .from('game_rooms')
        .select('seed')
        .eq('id', roomId)
        .maybeSingle();
      seed = Number(roomRow?.seed) || 1;
    } catch (_) {
      seed = 1;
    }

    let inviteId = '';
    try {
      inviteId = crypto.randomUUID();
    } catch (_) {
      inviteId = `inv_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
    }

    const inviteUrl = new URL('/game', window.location.origin);
    inviteUrl.searchParams.set('room', roomId);
    inviteUrl.searchParams.set('invite', inviteId);

    try {
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      const payload = {
        id: inviteId,
        to_user_id: toUserId,
        from_user_id: user.id,
        from_display: fromDisplay,
        from_username: fromUsername,
        from_avatar_url: fromAvatarUrl,
        invite_url: inviteUrl.toString(),
        room_id: roomId,
        seed,
        status: 'pending',
        expires_at: expiresAt,
      };
      const { error } = await client.from('game_invites').insert(payload);
      if (error) {
        showToast('Invite failed');
        return;
      }
    } catch (_) {
      showToast('Invite failed');
      return;
    }

    // Mark cooldown (only after successful insert)
    try {
      if (!window.__aryInviteCooldowns) window.__aryInviteCooldowns = {};
      if (!window.__aryInviteCooldownsById) window.__aryInviteCooldownsById = {};
      window.__aryInviteCooldowns[opponentKey] = now;
      window.__aryInviteCooldownsById[String(toUserId)] = now;
    } catch (_) {}

    try {
      if (typeof window.__aryRefreshNotifications === 'function') window.__aryRefreshNotifications();
    } catch (_) {}

    showToastKind('Invite sent', 'good');

    try {
      setLobbyVisible(true);
      setLobbyStatus('Invite sent. Waiting for friend to join…');
      setMpControls({ canStart: false, canSettings: true });
    } catch (_) {}
  }

  function resetToSetup() {
    stopTimer();
    setCountdownVisible(false);
    setStage('setup');
    setSetupLocked(false);
  }

  function bindButtons() {
    els.start?.addEventListener('click', () => startGame());

    els.mpOpen?.addEventListener('click', () => {
      const isOpen = !!(els.mpLobby && els.mpLobby.classList.contains('active'));
      setLobbyVisible(!isOpen);
      if (!isOpen) setLobbyStatus('Create a lobby or join from an invite.');
    });

    els.mpLeave?.addEventListener('click', () => {
      setLobbyVisible(false);
      setLobbyStatus('Not connected.');
      setMpControls({ canStart: false, canSettings: false });
    });

    els.mpInvite?.addEventListener('click', () => {
      sendPvpInvite();
    });

    els.mpSettings?.addEventListener('click', () => {
      if (!state.mp.isLeader) {
        showToast('Leader only');
        return;
      }
      try {
        if (mpEls.setGenre) mpEls.setGenre.value = state.search || 'random';
        if (mpEls.setDifficulty) mpEls.setDifficulty.value = state.difficulty || 'easy';
        if (mpEls.setMode) mpEls.setMode.value = state.mode || 'cover';
        if (mpEls.setCount) mpEls.setCount.value = String(state.count || 5);
      } catch (_) {}
      setSettingsModalOpen(true);
    });

    els.mpStart?.addEventListener('click', () => {
      if (!state.mp.isLeader) {
        showToast('Leader only');
        return;
      }
      if ((state.mp.members || []).length < 2) {
        showToast('Need at least 2 players');
        return;
      }
      (async () => {
        const client = await waitForSupabaseClient(8000);
        if (!client) return;
        const roomId = safeText(state.mp.roomId).trim();
        if (!roomId) return;
        const seed = (function () {
          try { return Number(state.pvp?.seed) || 0; } catch (_) { return 0; }
        })();
        // start: update room status; realtime will start everyone
        try {
          await client
            .from('game_rooms')
            .update({ status: 'started', started_at: new Date().toISOString() })
            .eq('id', roomId);
        } catch (err) {
          console.warn('start room failed', err);
        }
      })();
    });

    mpEls.modalClose?.addEventListener('click', () => setSettingsModalOpen(false));
    mpEls.modalX?.addEventListener('click', () => setSettingsModalOpen(false));
    mpEls.modal?.addEventListener('click', (e) => {
      if (e.target === mpEls.modal) setSettingsModalOpen(false);
    });
    mpEls.modalSave?.addEventListener('click', async () => {
      if (!state.mp.isLeader) {
        setSettingsModalOpen(false);
        return;
      }
      const client = await waitForSupabaseClient(8000);
      if (!client) return;
      const roomId = safeText(state.mp.roomId).trim();
      if (!roomId) return;

      const nextGenre = safeText(mpEls.setGenre?.value || 'random');
      const nextDiff = safeText(mpEls.setDifficulty?.value || 'easy');
      const nextMode = safeText(mpEls.setMode?.value || 'cover');
      const nextCount = Number(mpEls.setCount?.value || 5) || 5;
      try {
        await client
          .from('game_rooms')
          .update({ genre: nextGenre, difficulty: nextDiff, mode: nextMode, question_count: nextCount })
          .eq('id', roomId);
      } catch (err) {
        console.warn('save settings failed', err);
      }
      setSettingsModalOpen(false);
    });

    els.quit?.addEventListener('click', () => {
      showToast('Quit');
      resetToSetup();
    });

    els.next?.addEventListener('click', () => nextQuestion());

    els.playAgain?.addEventListener('click', () => resetToSetup());

    els.backSetup?.addEventListener('click', () => resetToSetup());

    const closeGenreMenu = () => {
      if (!els.genreMenu) return;
      els.genreMenu.classList.remove('open');
      if (els.genreSelect) els.genreSelect.setAttribute('aria-expanded', 'false');
    };

    const onSelectToggle = (e) => {
      try {
        e.preventDefault();
        e.stopPropagation();
      } catch (_) {}
      if (!els.genreMenu) return;
      const isOpen = els.genreMenu.classList.toggle('open');
      els.genreSelect?.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    };

    // pointer events work better on mobile than click
    els.genreSelect?.addEventListener('pointerdown', onSelectToggle);

    els.genreMenu?.querySelectorAll('[data-genre]').forEach((btn) => {
      const onPick = (e) => {
        try {
          e.preventDefault();
          e.stopPropagation();
        } catch (_) {}
        const key = btn.getAttribute('data-genre') || '';
        const label = (btn.querySelector('span')?.textContent || key || '').trim();
        state.search = key;
        if (els.genreValue) els.genreValue.textContent = label || 'Select a genre…';
        closeGenreMenu();
        showToastKind(`Selected: ${label}`, 'neutral');
      };
      btn.addEventListener('pointerdown', onPick);
    });

    document.addEventListener('pointerdown', (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t.closest('#genre-menu') || t.closest('#genre-select')) return;
      closeGenreMenu();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeGenreMenu();
    });
  }

  function init() {
    bindChips();
    bindButtons();
    parsePvpFromUrl();
    setStage('setup');

    // Solo default: Random genre
    try {
      if (!state.search) state.search = 'random';
      if (els.genreValue) els.genreValue.textContent = 'Random';
    } catch (_) {}

    // Default multiplayer UI state.
    setMpControls({ canStart: false, canSettings: false });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
