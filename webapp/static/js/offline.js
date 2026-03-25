const ARY_OFFLINE_DB_NAME = 'ary-offline-db';
const ARY_OFFLINE_DB_VERSION = 1;
const ARY_OFFLINE_STORE = 'chapters';

function aryIsStandalone() {
  try {
    return (
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone
    );
  } catch (_) {
    return false;
  }
}

function aryOpenOfflineDb() {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(ARY_OFFLINE_DB_NAME, ARY_OFFLINE_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(ARY_OFFLINE_STORE)) {
          db.createObjectStore(ARY_OFFLINE_STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('indexeddb open failed'));
    } catch (err) {
      reject(err);
    }
  });
}

async function aryDbGet(key) {
  const db = await aryOpenOfflineDb();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(ARY_OFFLINE_STORE, 'readonly');
      const req = tx.objectStore(ARY_OFFLINE_STORE).get(key);
      req.onsuccess = () => {
        const result = req.result || null;
        try { db.close(); } catch (_) {}
        resolve(result);
      };
      req.onerror = () => {
        try { db.close(); } catch (_) {}
        reject(req.error || new Error('indexeddb get failed'));
      };
    } catch (err) {
      try { db.close(); } catch (_) {}
      reject(err);
    }
  });
}

async function aryDbPut(record) {
  const db = await aryOpenOfflineDb();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(ARY_OFFLINE_STORE, 'readwrite');
      tx.objectStore(ARY_OFFLINE_STORE).put(record);
      tx.oncomplete = () => {
        try { db.close(); } catch (_) {}
        resolve(true);
      };
      tx.onerror = () => {
        try { db.close(); } catch (_) {}
        reject(tx.error || new Error('indexeddb put failed'));
      };
    } catch (err) {
      try { db.close(); } catch (_) {}
      reject(err);
    }
  });
}

async function aryDbGetAll() {
  const db = await aryOpenOfflineDb();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(ARY_OFFLINE_STORE, 'readonly');
      const req = tx.objectStore(ARY_OFFLINE_STORE).getAll();
      req.onsuccess = () => {
        const result = Array.isArray(req.result) ? req.result : [];
        try { db.close(); } catch (_) {}
        resolve(result);
      };
      req.onerror = () => {
        try { db.close(); } catch (_) {}
        reject(req.error || new Error('indexeddb getAll failed'));
      };
    } catch (err) {
      try { db.close(); } catch (_) {}
      reject(err);
    }
  });
}

async function aryDbDelete(key) {
  const db = await aryOpenOfflineDb();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(ARY_OFFLINE_STORE, 'readwrite');
      tx.objectStore(ARY_OFFLINE_STORE).delete(key);
      tx.oncomplete = () => {
        try { db.close(); } catch (_) {}
        resolve(true);
      };
      tx.onerror = () => {
        try { db.close(); } catch (_) {}
        reject(tx.error || new Error('indexeddb delete failed'));
      };
    } catch (err) {
      try { db.close(); } catch (_) {}
      reject(err);
    }
  });
}

function aryGetKey(userId, source, chapterId) {
  return `${String(userId || '')}|${String(source || '')}|${String(chapterId || '')}`;
}

async function aryGetChapter(userId, source, chapterId) {
  const key = aryGetKey(userId, source, chapterId);
  return await aryDbGet(key);
}

function aryPostToSw(message) {
  return new Promise((resolve, reject) => {
    try {
      if (!('serviceWorker' in navigator)) {
        reject(new Error('service worker not supported'));
        return;
      }
      const postWith = (target) => {
        if (!target || typeof target.postMessage !== 'function') {
          reject(new Error('service worker not ready'));
          return;
        }

        const channel = new MessageChannel();
        const timeout = setTimeout(() => {
          try { channel.port1.onmessage = null; } catch (_) {}
          reject(new Error('service worker timeout'));
        }, 30000);

        channel.port1.onmessage = (event) => {
          clearTimeout(timeout);
          const data = event && event.data ? event.data : null;
          if (data && data.ok) resolve(data);
          else reject((data && data.error) || new Error('service worker error'));
        };

        target.postMessage(message, [channel.port2]);
      };

      const controller = navigator.serviceWorker.controller;
      if (controller) {
        postWith(controller);
        return;
      }

      const ready = navigator.serviceWorker.ready;
      if (ready && typeof ready.then === 'function') {
        ready
          .then((reg) => {
            const sw = reg && (reg.active || reg.waiting || reg.installing);
            postWith(sw);
          })
          .catch((err) => reject(err));
        return;
      }

      reject(new Error('service worker controller not ready'));
    } catch (err) {
      reject(err);
    }
  });
}

async function aryDownloadChapter(payload) {
  const {
    userId,
    source,
    chapterId,
    title,
    description,
    chapterLabel,
    readerUrl,
    pageUrls,
    cover,
    seriesId,
    seriesSlug,
  } = payload || {};

  if (!aryIsStandalone()) throw new Error('not standalone');
  if (!userId) throw new Error('missing user');
  if (!source || !chapterId) throw new Error('missing chapter');
  if (!Array.isArray(pageUrls) || !pageUrls.length) throw new Error('missing pages');

  const key = aryGetKey(userId, source, chapterId);

  const record = {
    key,
    userId,
    source,
    chapterId,
    title: String(title || ''),
    description: String(description || ''),
    chapterLabel: String(chapterLabel || ''),
    readerUrl: String(readerUrl || ''),
    seriesId: seriesId != null ? String(seriesId) : '',
    seriesSlug: String(seriesSlug || ''),
    cover: String(cover || ''),
    pageUrls: pageUrls.map((u) => String(u)).filter(Boolean),
    downloadedAt: Date.now(),
  };

  await aryDbPut(record);
  await aryPostToSw({ type: 'ARY_OFFLINE_DOWNLOAD', key, urls: record.pageUrls });
  return record;
}

async function aryRemoveChapter(userId, source, chapterId) {
  const key = aryGetKey(userId, source, chapterId);
  const record = await aryDbGet(key);
  await aryDbDelete(key);
  await aryPostToSw({ type: 'ARY_OFFLINE_REMOVE', key, urls: record && Array.isArray(record.pageUrls) ? record.pageUrls : [] });
  return true;
}

async function aryRemoveAllForUser(userId) {
  const all = await aryDbGetAll();
  const targets = all.filter((r) => r && r.userId === userId);
  const urls = [];
  for (const r of targets) {
    if (r && Array.isArray(r.pageUrls)) {
      r.pageUrls.forEach((u) => {
        if (u) urls.push(String(u));
      });
    }
    try {
      await aryDbDelete(r.key);
    } catch (_) {}
  }
  await aryPostToSw({ type: 'ARY_OFFLINE_REMOVE_ALL', userId: String(userId || ''), urls });
  return true;
}

async function aryListForUser(userId) {
  const all = await aryDbGetAll();
  return all
    .filter((r) => r && r.userId === userId)
    .sort((a, b) => (Number(b.downloadedAt || 0) || 0) - (Number(a.downloadedAt || 0) || 0));
}

window.AryOffline = {
  isStandalone: aryIsStandalone,
  downloadChapter: aryDownloadChapter,
  getChapter: aryGetChapter,
  removeChapter: aryRemoveChapter,
  removeAllForUser: aryRemoveAllForUser,
  listForUser: aryListForUser,
  makeKey: aryGetKey,
};
