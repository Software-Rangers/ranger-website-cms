"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");

/**
 * Strapi 5 always stores relations per locale. This document-service middleware
 * keeps the article's author and category identical across all locales:
 *  - a new locale inherits the relations it was not given explicitly
 *    (preferring the default locale)
 *  - saving a locale copies its relations to the other locales whose drafts differ
 * Runs in one transaction with the triggering save, so it commits or rolls back as a whole.
 */
const UID = "api::article.article";
const SHARED = ["author", "category"];

// Marks calls made by the middleware itself, scoped to the async call chain.
const syncContext = new AsyncLocalStorage();

const isEmptyValue = (value) => {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") {
    if (value.id != null || value.documentId != null) return false;
    return ["connect", "set"].every(
      (key) => !value[key] || value[key].length === 0,
    );
  }
  return false;
};

module.exports = ({ strapi }) => {
  const populate = Object.fromEntries(
    SHARED.map((field) => [field, { select: ["documentId"] }]),
  );

  const toRelationData = (entry) =>
    Object.fromEntries(
      SHARED.map((field) => [field, entry?.[field]?.documentId ?? null]),
    );

  const findDrafts = (documentId, where = {}) =>
    strapi.db.query(UID).findMany({
      where: { documentId, publishedAt: null, ...where },
      populate,
      orderBy: { id: "asc" },
    });

  strapi.documents.use(async (context, next) => {
    const { action, uid, params } = context;

    if (
      uid !== UID ||
      action !== "update" ||
      !params.documentId ||
      syncContext.getStore()
    ) {
      return next();
    }

    const defaultLocale = await strapi
      .plugin("i18n")
      .service("locales")
      .getDefaultLocale();
    const locale = params.locale || defaultLocale;
    if (typeof locale !== "string" || locale === "*") {
      return next();
    }
    const { documentId } = params;

    return strapi.db.transaction(async ({ trx }) => {
      // Lock all locale rows of the document in a fixed order so concurrent saves of
      // different locales queue up instead of deadlocking (no-op on SQLite).
      await strapi.db
        .getConnection(strapi.db.metadata.get(UID).tableName)
        .transacting(trx)
        .where({ document_id: documentId })
        .orderBy("id")
        .forUpdate()
        .select("id");

      const drafts = await findDrafts(documentId);
      const saved = drafts.find((draft) => draft.locale === locale);
      let before = toRelationData(saved);

      // New locale: fill in the relations it was not given from an existing locale.
      if (!saved && drafts.length > 0) {
        const source =
          drafts.find((draft) => draft.locale === defaultLocale) ?? drafts[0];
        const inherited = toRelationData(source);
        before = inherited;
        const data = { ...params.data };
        for (const field of SHARED) {
          if (isEmptyValue(data[field])) {
            data[field] = inherited[field];
          }
        }
        params.data = data;
      }

      const result = await next();

      const [current, ...others] = await Promise.all([
        findDrafts(documentId, { locale }),
        findDrafts(documentId, { locale: { $ne: locale } }),
      ]).then(([own, rest]) => [own[0], ...rest]);

      // Only propagate what this save changed, so untouched (or empty) relations never
      // overwrite the other locales.
      const now = toRelationData(current);
      const data = Object.fromEntries(
        SHARED.filter((f) => now[f] !== before[f]).map((f) => [f, now[f]]),
      );
      const outdated = others.filter((draft) =>
        Object.keys(data).some(
          (field) => (draft[field]?.documentId ?? null) !== data[field],
        ),
      );

      await syncContext.run(true, async () => {
        for (const draft of outdated) {
          await strapi
            .documents(UID)
            .update({ documentId, locale: draft.locale, data });
        }
      });

      return result;
    });
  });
};
