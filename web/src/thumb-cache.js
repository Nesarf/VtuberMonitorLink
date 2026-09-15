// thumb-cache.js — fetch each source's thumbnail once per session, and never twice at the same time.
//
// The server caches thumbnails too, so a repeat ask is cheap (the log shows 304s in 1ms). The problem is
// the shape of the traffic, not its cost: entering the Sources page asked for up to fourteen thumbnails,
// and the page asked again on every visit and on every reload of its data, because the effect that does it
// depends on the whole data object. The request log caught it - bursts of 14 and 28 (fourteen, twice) -
// and the first fetch of each source is the slow one, up to two seconds. So a page that is merely being
// looked at should not be re-asking.
//
// Two maps, and the difference between them matters: `cache` is the answer (including "there is nothing
// there", which is an answer worth keeping so the page does not retry a missing image forever), while
// `pending` is the in-flight question, which is what stops two mounts from asking the same thing at once.
// A *failure* is deliberately not cached: an unreachable host now may answer later.

const cache = new Map();
const pending = new Map();

export const thumbKey = (source) => `${source?.id ?? ''}|${source?.url ?? ''}`;

/** What is already known about a source, or undefined when nothing has been asked yet. */
export const cachedThumb = (source) => cache.get(thumbKey(source));

/**
 * Ask for a source's thumbnail, or hand back the answer that is already known.
 * @param {object} source the source (id and url are what it is keyed by)
 * @param {(url: string, id: string) => Promise<{ok?: boolean, image?: string}>} fetchMeta the API call
 * @returns {Promise<string>} the image reference, or '' when there is none
 */
export function loadThumb(source, fetchMeta) {
  const key = thumbKey(source);
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  const already = pending.get(key);
  if (already) return already;
  const question = (async () => {
    try {
      const r = await fetchMeta(source.url, source.id);
      const image = r?.ok ? (r.image ?? '') : '';
      cache.set(key, image);
      return image;
    } catch {
      return '';
    } finally {
      pending.delete(key);
    }
  })();
  pending.set(key, question);
  return question;
}

/** Only for tests: a fresh page in the same process must not inherit another test's answers. */
export function clearThumbCache() {
  cache.clear();
  pending.clear();
}
