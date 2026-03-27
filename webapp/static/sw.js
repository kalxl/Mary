const CACHE_NAME = 'ary-pwa-v19';
const OFFLINE_CACHE = 'ary-offline-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        const urls = [
          '/',
          '/?pwa=1',
          '/browse',
          '/library',
          '/profile',
          '/downloads',
          '/game',
          '/game.html',
          '/reader',
          '/reader.html',
          '/manifest.webmanifest',
          '/static/components/navbar.html',
          '/static/js/navbar.js',
          '/static/js/offline.js',
          '/static/js/comick-api.js?v=2',
          '/static/js/game.js?v=20260214-11',
          '/static/img/ary.png',
          '/static/favicon_io/favicon.ico',
          '/static/favicon_io/favicon-32x32.png',
          '/static/favicon_io/favicon-16x16.png',
          '/static/favicon_io/apple-touch-icon.png',
          '/static/favicon_io/android-chrome-192x192.png',
          '/static/favicon_io/android-chrome-512x512.png',
        ];

        await Promise.all(
          urls.map(async (url) => {
            try {
              const req = new Request(url, { cache: 'reload' });
              const res = await fetch(req);
              if (res && res.ok) {
                await cache.put(req, res);
              }
            } catch (_) {}
          })
        );
      } catch (_) {}
      try {
        await self.skipWaiting();
      } catch (_) {}
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => (k !== CACHE_NAME && k !== OFFLINE_CACHE ? caches.delete(k) : null))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = (() => {
    try {
      return new URL(req.url);
    } catch (_) {
      return null;
    }
  })();

  const isNavbarAsset = (() => {
    try {
      if (!url) return false;
      const path = url.pathname || '';
      return path === '/static/components/navbar.html' || path === '/static/js/navbar.js';
    } catch (_) {
      return false;
    }
  })();

  const isGameAsset = (() => {
    try {
      if (!url) return false;
      const path = url.pathname || '';
      if (path === '/game' || path === '/game.html') return true;
      if (path === '/static/js/game.js') return true;
      return false;
    } catch (_) {
      return false;
    }
  })();

  const isProfileAsset = (() => {
    try {
      if (!url) return false;
      const path = url.pathname || '';
      if (path === '/profile' || path === '/profile.html') return true;
      return false;
    } catch (_) {
      return false;
    }
  })();

  const isSeriesAsset = (() => {
    try {
      if (!url) return false;
      const path = url.pathname || '';
      if (path === '/series' || path === '/series.html') return true;
      return false;
    } catch (_) {
      return false;
    }
  })();

  const isReaderAsset = (() => {
    try {
      if (!url) return false;
      const path = url.pathname || '';
      if (path === '/reader' || path === '/reader.html') return true;
      return false;
    } catch (_) {
      return false;
    }
  })();

  const destination = (() => {
    try {
      return req.destination || '';
    } catch (_) {
      return '';
    }
  })();

  const isNavigation = (() => {
    try {
      if (req.mode === 'navigate') return true;
      return destination === 'document';
    } catch (_) {
      return false;
    }
  })();

  const isSameOrigin = (() => {
    try {
      if (!url) return true;
      return url.origin === self.location.origin;
    } catch (_) {
      return true;
    }
  })();

  const isApiRequest = (() => {
    try {
      if (!url) return false;
      return (url.pathname || '').startsWith('/api/');
    } catch (_) {
      return false;
    }
  })();

  event.respondWith(
    (async () => {
      // Dynamic data must not be served from cache (prevents stale latest chapters/library updates).
      if (isApiRequest) {
        try {
          return await fetch(req, { cache: 'no-store' });
        } catch (_) {
          const cachedApi = await caches.match(req);
          if (cachedApi) return cachedApi;
          return new Response('offline', { status: 503, statusText: 'offline' });
        }
      }

      // Series UI changes frequently; do NOT cache it (prevents stale layouts after deploy).
      if (isSeriesAsset && isNavigation) {
        try {
          return await fetch(req, { cache: 'no-store' });
        } catch (_) {
          const cached = await caches.match(req);
          if (cached) return cached;
          return new Response('offline', { status: 503, statusText: 'offline' });
        }
      }

      // Reader logic changes frequently; do NOT serve stale cached versions.
      if (isReaderAsset && isNavigation) {
        try {
          return await fetch(req, { cache: 'no-store' });
        } catch (_) {
          const cached = await caches.match(req);
          if (cached) return cached;
          return new Response('offline', { status: 503, statusText: 'offline' });
        }
      }

      if (isProfileAsset && isNavigation) {
        try {
          const fresh = await fetch(req, { cache: 'no-store' });
          const copy = fresh.clone();
          try {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(req, copy);
          } catch (_) {}
          return fresh;
        } catch (_) {
          const cached = await caches.match(req);
          if (cached) return cached;
          return new Response('offline', { status: 503, statusText: 'offline' });
        }
      }

      if (isNavbarAsset) {
        try {
          const fresh = await fetch(req, { cache: 'no-store' });
          const copy = fresh.clone();
          try {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(req, copy);
          } catch (_) {}
          return fresh;
        } catch (_) {
          const cached = await caches.match(req);
          if (cached) return cached;
          return new Response('offline', { status: 503, statusText: 'offline' });
        }
      }

      // Game UI should always update immediately after deploy.
      // We do network-first + no-store to avoid stale HTML/JS from SW cache.
      if (isGameAsset) {
        try {
          const fresh = await fetch(req, { cache: 'no-store' });
          const copy = fresh.clone();
          try {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(req, copy);
          } catch (_) {}
          return fresh;
        } catch (_) {
          const cached = await caches.match(req);
          if (cached) return cached;
          return new Response('offline', { status: 503, statusText: 'offline' });
        }
      }

      if (isNavigation) {
        try {
          const fresh = await fetch(req);
          const copy = fresh.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
          return fresh;
        } catch (_) {
          const cachedNav = await caches.match(req);
          if (cachedNav) return cachedNav;
          try {
            if (url && url.pathname) {
              const cachedNoQuery = await caches.match(new Request(url.pathname));
              if (cachedNoQuery) return cachedNoQuery;
            }
          } catch (_) {}
          const fallback = await caches.match('/');
          if (fallback) return fallback;
          return new Response('offline', { status: 503, statusText: 'offline' });
        }
      }

      if (destination === 'image') {
        try {
          const offlineCache = await caches.open(OFFLINE_CACHE);
          const hit = await offlineCache.match(req);
          if (hit) return hit;
          try {
            const noCorsHit = await offlineCache.match(new Request(req.url, { mode: 'no-cors' }));
            if (noCorsHit) return noCorsHit;
          } catch (_) {}
        } catch (_) {}
      }

      // Avoid caching cross-origin dynamic requests (Supabase/CDNs) to prevent stale data.
      // Images are handled above via OFFLINE_CACHE.
      if (!isSameOrigin) {
        try {
          return await fetch(req);
        } catch (_) {
          const cachedX = await caches.match(req);
          if (cachedX) return cachedX;
          return new Response('offline', { status: 503, statusText: 'offline' });
        }
      }

      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        return res;
      } catch (_) {
        return new Response('offline', { status: 503, statusText: 'offline' });
      }
    })()
  );
});

self.addEventListener('message', (event) => {
  const msg = event && event.data ? event.data : null;
  const port = event && event.ports && event.ports[0] ? event.ports[0] : null;
  if (!msg || !msg.type) return;

  const reply = (payload) => {
    if (!port) return;
    try {
      port.postMessage(payload);
    } catch (_) {}
  };

  const safeFetchAndCache = async (cache, url) => {
    const req = new Request(url, { mode: 'no-cors' });
    const res = await fetch(req);
    try {
      await cache.put(req, res.clone());
    } catch (_) {}
    try {
      const resolved = res && res.url ? String(res.url) : '';
      if (resolved && resolved !== String(url)) {
        await cache.put(new Request(resolved, { mode: 'no-cors' }), res.clone());
      }
    } catch (_) {}
  };

  if (msg.type === 'ARY_OFFLINE_DOWNLOAD') {
    const urls = Array.isArray(msg.urls) ? msg.urls : [];
    event.waitUntil(
      caches.open(OFFLINE_CACHE).then(async (cache) => {
        for (const url of urls) {
          if (!url) continue;
          try {
            await safeFetchAndCache(cache, String(url));
          } catch (_) {}
        }
        reply({ ok: true });
      }).catch((err) => {
        reply({ ok: false, error: String((err && err.message) || err || 'offline download failed') });
      })
    );
    return;
  }

  if (msg.type === 'ARY_OFFLINE_REMOVE') {
    const urls = Array.isArray(msg.urls) ? msg.urls : [];
    event.waitUntil(
      caches.open(OFFLINE_CACHE).then(async (cache) => {
        for (const url of urls) {
          if (!url) continue;
          try {
            await cache.delete(new Request(String(url), { mode: 'no-cors' }));
            await cache.delete(String(url));
          } catch (_) {}
        }
        reply({ ok: true });
      }).catch((err) => {
        reply({ ok: false, error: String((err && err.message) || err || 'offline remove failed') });
      })
    );
    return;
  }

  if (msg.type === 'ARY_OFFLINE_REMOVE_ALL') {
    const urls = Array.isArray(msg.urls) ? msg.urls : [];
    event.waitUntil(
      caches.open(OFFLINE_CACHE).then(async (cache) => {
        if (!urls.length) {
          reply({ ok: true });
          return;
        }
        for (const url of urls) {
          if (!url) continue;
          try {
            await cache.delete(new Request(String(url), { mode: 'no-cors' }));
            await cache.delete(String(url));
          } catch (_) {}
        }
        reply({ ok: true });
      }).catch((err) => {
        reply({ ok: false, error: String((err && err.message) || err || 'offline remove all failed') });
      })
    );
    return;
  }
});
