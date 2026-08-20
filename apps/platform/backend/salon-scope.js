// SINGLE SOURCE OF TRUTH for the question "which salon does this HTTP request act on?"
//
// Every gate, every screen and every /api/platform/* handler MUST resolve the salon
// through `resolveSalonScope()` and through nothing else. When multi-salon storage
// lands, the ONLY things that change here are `store.getSalonSlug()` / `store.hasSalon()`
// (see backend/store.js) — the request-side contract below stays put.
//
// Resolution order:
//   1. explicit selector on the request (?salon= / ?salonSlug= / X-Salon-Slug header)
//   2. the salon on the signed-in session (request.session.salonSlug)
//   3. the salon this instance hosts (store.getSalonSlug())
//
// Denial rules (both answer HTTP 403, never 404 — a wrong slug must not leak whether
// that salon exists on this box):
//   - cross_salon:          a session exists and the request explicitly asked for a
//                           different salon than the session is bound to.
//   - salon_not_provisioned: the resolved salon is not hosted by this instance.

const SALON_QUERY_KEYS = ["salon", "salonSlug", "salon_slug"];
const SALON_HEADER = "x-salon-slug";

function normalizeSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

// The salon the request explicitly names, or null when it names none.
function requestedSalonSlug(request, requestUrl) {
  if (requestUrl && requestUrl.searchParams) {
    for (const key of SALON_QUERY_KEYS) {
      const value = requestUrl.searchParams.get(key);
      if (value) return normalizeSlug(value);
    }
  }
  const header = request && request.headers ? request.headers[SALON_HEADER] : "";
  if (header) return normalizeSlug(header);
  return null;
}

function resolveSalonScope(store, request, requestUrl) {
  const hosted = store.getSalonSlug();
  const sessionSlug = request && request.session ? normalizeSlug(request.session.salonSlug) : "";
  const requested = requestedSalonSlug(request, requestUrl);
  const slug = requested || sessionSlug || hosted;

  if (sessionSlug && requested && requested !== sessionSlug) {
    return { ok: false, reason: "cross_salon", slug, sessionSlug, requested };
  }
  if (!store.hasSalon(slug)) {
    return { ok: false, reason: "salon_not_provisioned", slug, sessionSlug, requested };
  }
  return { ok: true, slug, sessionSlug, requested };
}

module.exports = {
  SALON_QUERY_KEYS,
  SALON_HEADER,
  normalizeSlug,
  requestedSalonSlug,
  resolveSalonScope
};
