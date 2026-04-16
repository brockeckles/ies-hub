/**
 * IES Hub v3 — Feedback System Types
 * JSDoc typedefs for feedback items, votes, and analytics.
 *
 * @module hub/feedback/types
 */

/**
 * @typedef {Object} FeedbackItem
 * @property {string} id
 * @property {string} title
 * @property {string} description
 * @property {'bug' | 'feature' | 'improvement' | 'question'} type
 * @property {'open' | 'in-review' | 'planned' | 'in-progress' | 'completed' | 'declined'} status
 * @property {'low' | 'medium' | 'high' | 'critical'} priority
 * @property {string} submittedBy — user name or email
 * @property {string} submittedDate — ISO date
 * @property {string} [tool] — which tool/section it relates to
 * @property {string[]} tags
 * @property {number} upvotes
 * @property {string[]} upvotedBy — user IDs who upvoted
 * @property {FeedbackComment[]} comments
 * @property {string} [created_at]
 * @property {string} [updated_at]
 */

/**
 * @typedef {Object} FeedbackComment
 * @property {string} id
 * @property {string} author
 * @property {string} content
 * @property {string} date — ISO datetime
 */

/**
 * @typedef {Object} FeedbackStats
 * @property {number} totalItems
 * @property {number} openItems
 * @property {number} completedItems
 * @property {number} declinedItems
 * @property {number} totalUpvotes
 * @property {number} avgUpvotes
 * @property {{ type: string, count: number }[]} byType
 * @property {{ status: string, count: number }[]} byStatus
 */

/**
 * @typedef {Object} FeedbackTrend
 * @property {string} month — 'YYYY-MM'
 * @property {number} submitted
 * @property {number} resolved
 */

export {};
