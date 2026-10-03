'use strict';

/**
 * Strapi 5 always stores relations per locale. This document-service middleware
 * keeps the article's author and category identical across all locales:
 *  - saving an existing locale copies its relations to the other locales
 *  - creating a new locale inherits the relations from an existing one
 */
const UID = 'api::article.article';
const SHARED = ['author', 'category'];

const syncing = new Set();

const toRelationData = (entry) =>
  Object.fromEntries(SHARED.map((field) => [field, entry?.[field]?.documentId ?? null]));

const loadDraft = (documentId, locale) =>
  strapi.documents(UID).findOne({
    documentId,
    locale,
    status: 'draft',
    populate: SHARED,
  });

module.exports = ({ strapi }) => {
  strapi.documents.use(async (context, next) => {
    const { action, uid, params } = context;

    if (uid !== UID || action !== 'update' || !params.documentId || !params.locale) {
      return next();
    }

    const { documentId, locale } = params;
    if (syncing.has(documentId)) {
      return next();
    }

    const existed = Boolean(await loadDraft(documentId, locale));
    const result = await next();

    syncing.add(documentId);
    try {
      const siblings = await strapi.db.query(UID).findMany({
        where: { documentId, publishedAt: null, locale: { $ne: locale } },
        select: ['locale'],
      });
      if (siblings.length === 0) {
        return result;
      }

      if (existed) {
        const data = toRelationData(await loadDraft(documentId, locale));
        for (const { locale: other } of siblings) {
          await strapi.documents(UID).update({ documentId, locale: other, data });
        }
      } else {
        const source = await loadDraft(documentId, siblings[0].locale);
        await strapi.documents(UID).update({ documentId, locale, data: toRelationData(source) });
      }
    } finally {
      syncing.delete(documentId);
    }

    return result;
  });
};
