function buildComickUrl(path, params = {}) {
  const base = path.startsWith("http") ? path : `https://api.comick.dev${path}`;
  const url = new URL(base);
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((entry) => url.searchParams.append(key, entry));
    } else {
      url.searchParams.set(key, value);
    }
  });
  return url.toString();
}

async function fetchComickJson(path, params = {}) {
  const url = new URL("/api/comick/raw", window.location.origin);
  url.searchParams.set("path", path);
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((entry) => url.searchParams.append(key, entry));
    } else {
      url.searchParams.set(key, value);
    }
  });

  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Comick API error: ${res.status}`);
  }
  return res.json();
}

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
